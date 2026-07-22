import type { ActorSystem } from '../ActorSystem.js';
import { CoordinatedShutdownId, Phases } from '../CoordinatedShutdown.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import type { HttpServerBackend, ServerBinding } from './backend/HttpServerBackend.js';
import { FastifyBackend } from './backend/FastifyBackend.js';
import { HttpClient } from './HttpClient.js';
import { compile, defaultErrorResponse, type Route } from './Route.js';
import type { HttpRequest, HttpResponse } from './types.js';
import { ConnectionTracker, trackSocket } from './websocket/ConnectionWiring.js';

export interface ServerBuilder {
  /** Override the default Fastify backend (or use BunServe / Express). */
  useBackend(backend: HttpServerBackend): ServerBuilder;
  /**
   * Last-resort handler for errors that escape every route-level
   * `handleErrors(...)`, plus backend-internal errors (body-parse
   * failures, etc.).  Overrides the framework's default 500 mapping; if
   * it throws, the default mapping still applies.  Requires a backend
   * that supports `setErrorHandler` (all shipped backends do).
   */
  withErrorHandler(handler: (err: unknown, request: HttpRequest) => Promise<HttpResponse> | HttpResponse): ServerBuilder;
  /** Register the full route tree and bind.  Returns the ServerBinding. */
  bind(routes: Route): Promise<ServerBinding>;
}

/**
 * System-wide HTTP extension — entry point for the routing DSL and the
 * shared HttpClient.  Every ActorSystem gets one HttpClient and a factory
 * for HTTP servers.  The default server backend is Fastify; swap it per
 * server via `builder.useBackend(new BunServeBackend())`.
 */
export class HttpExtension implements Extension {
  /** Shared HTTP client — uses the global fetch. */
  readonly client: HttpClient = new HttpClient();

  constructor(private readonly system: ActorSystem) {}

  /** Start building a new server scope.  Call `bind(routes)` to start it. */
  newServerAt(host: string, port: number): ServerBuilder {
    let backend: HttpServerBackend | null = null;
    let errorHandler: ((err: unknown, request: HttpRequest) => Promise<HttpResponse> | HttpResponse) | null = null;
    const system = this.system;
    return {
      useBackend(b: HttpServerBackend): ServerBuilder {
        backend = b;
        return this;
      },
      withErrorHandler(handler: (err: unknown, request: HttpRequest) => Promise<HttpResponse> | HttpResponse): ServerBuilder {
        errorHandler = handler;
        return this;
      },
      async bind(routes: Route): Promise<ServerBinding> {
        const active: HttpServerBackend = backend ?? new FastifyBackend();
        const compiled = compile(routes);
        const httpRoutes = compiled.filter((r) => r.kind === 'http');
        const wsRoutes = compiled.filter((r) => r.kind === 'websocket');
        const fallbacks = compiled.filter((r) => r.kind === 'fallback');

        if (wsRoutes.length > 0 && typeof active.registerWebSocket !== 'function') {
          throw new Error(
            `HTTP backend "${active.name}" does not support websocket() routes.`,
          );
        }

        // Reject duplicate / conflicting patterns up front — clearer than
        // the backend's own boot-time error, and it catches the WS-vs-GET
        // collision (a WS route occupies the GET verb at its pattern).
        const wsPatterns = new Set<string>();
        for (const route of wsRoutes) {
          if (wsPatterns.has(route.pattern)) {
            throw new Error(`Duplicate websocket() route for pattern "${route.pattern}".`);
          }
          wsPatterns.add(route.pattern);
        }
        for (const route of httpRoutes) {
          if (route.method === 'GET' && wsPatterns.has(route.pattern)) {
            throw new Error(
              `Route conflict: GET ${route.pattern} collides with a websocket() route on the same path.`,
            );
          }
        }

        // Wrap each HTTP route's handler with a request log + timing.
        // Done at the DSL level so backends don't need a Logger
        // reference — every backend gets the same per-request debug
        // line uniformly.
        for (const route of httpRoutes) {
          active.registerRoute({
            method: route.method,
            pattern: route.pattern,
            handler: async (request: HttpRequest): Promise<HttpResponse> => {
              const start = Date.now();
              system.log.debug(`[http] ${request.method} ${request.path}`);
              try {
                const out = await route.handler(request);
                system.log.debug(
                  `[http] ${request.method} ${request.path} → ${out.status} (${Date.now() - start} ms)`,
                );
                return out;
              } catch (err) {
                system.log.debug(
                  `[http] ${request.method} ${request.path} → error after ${Date.now() - start} ms: ${(err as Error).message}`,
                );
                throw err;
              }
            },
          });
        }

        // WebSocket routes: every accepted socket flows through the
        // shared ConnectionTracker so unbind() can close it — otherwise
        // a long-lived socket keeps the server's close() pending forever.
        const tracker = new ConnectionTracker();
        for (const route of wsRoutes) {
          active.registerWebSocket!({
            pattern: route.pattern,
            authorize: route.authorize,
            onConnection: (request, socket) => {
              system.log.debug(`[ws] upgrade ${request.path}`);
              route.connect(system, request, trackSocket(tracker, socket));
            },
          });
        }

        // Fallback (not-found) route — at most one, wired to the backend's
        // method-agnostic not-found hook.  Wrap it like the per-route
        // handlers (debug log + default error mapping on throw).
        if (fallbacks.length > 1) {
          throw new Error(
            'Multiple fallback() routes registered — a server has exactly one not-found handler.',
          );
        }
        if (fallbacks.length === 1) {
          if (typeof active.setNotFound !== 'function') {
            throw new Error(
              `HTTP backend "${active.name}" does not support fallback() routes (no setNotFound hook).`,
            );
          }
          const fb = fallbacks[0]!;
          active.setNotFound(async (request: HttpRequest): Promise<HttpResponse> => {
            system.log.debug(`[http] (fallback) ${request.method} ${request.path}`);
            try {
              return await fb.handler(request);
            } catch (err) {
              return defaultErrorResponse(err);
            }
          });
        }

        // Server-wide error handler.  Backends consult it before their
        // default mapping and fall back to that mapping if it throws.
        if (errorHandler) {
          if (typeof active.setErrorHandler !== 'function') {
            throw new Error(
              `HTTP backend "${active.name}" does not support withErrorHandler (no setErrorHandler hook).`,
            );
          }
          active.setErrorHandler(errorHandler);
        }

        const raw = await active.listen(host, port);
        // Wrap `unbind` so it's idempotent — both the auto-registered
        // CoordinatedShutdown task and any manual caller can invoke it
        // safely; subsequent calls return the in-flight/resolved promise
        // from the first.  On unbind we also close then hard-terminate
        // live WebSocket sockets so the backend's close() can complete.
        let unbindOnce: Promise<void> | null = null;
        const binding: ServerBinding = {
          host: raw.host,
          port: raw.port,
          unbind(gracePeriodMs?: number): Promise<void> {
            if (!unbindOnce) {
              unbindOnce = (async () => {
                const backendUnbind = raw.unbind(gracePeriodMs);
                tracker.closeAll(1001, 'server shutting down');
                tracker.terminateAll();
                await backendUnbind;
              })();
            }
            return unbindOnce;
          },
        };
        // Auto-register with CoordinatedShutdown's ServiceUnbind phase so
        // operator-triggered shutdown (SIGTERM, cluster-leave, etc.) closes
        // the server before the rest of the pipeline tears down the system.
        system.extension(CoordinatedShutdownId).addTask(
          Phases.ServiceUnbind,
          `http-unbind-${binding.host}:${binding.port}`,
          () => binding.unbind(),
        );
        system.log.info(`HTTP server bound on ${binding.host}:${binding.port} (${active.name})`);
        system.log.debug(
          `[http] ${httpRoutes.length} route(s) + ${wsRoutes.length} websocket route(s) registered`,
        );
        return binding;
      },
    };
  }

  /** Fire-and-forget request via the shared client. */
  singleRequest = this.client.singleRequest.bind(this.client);
}

export const HttpExtensionId: ExtensionId<HttpExtension> = extensionId(
  'HttpExtension',
  (system) => new HttpExtension(system),
);
