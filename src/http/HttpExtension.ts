import { match } from 'ts-pattern';
import type { ActorSystem } from '../ActorSystem.js';
import type { Config } from '../config/Config.js';
import { ConfigError } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { CoordinatedShutdownId, Phases } from '../CoordinatedShutdown.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import type { Logger } from '../Logger.js';
import type { HttpServerBackend, ServerBinding } from './backend/HttpServerBackend.js';
import { HttpClient } from './HttpClient.js';
import type { HttpClientOptions } from './HttpClientOptions.js';
import { requestIdOf } from './middleware/RequestId.js';
import { resolveSecurityHeaders } from './middleware/SecurityHeaders.js';
import type { SecurityHeadersOptions } from './middleware/SecurityHeadersOptions.js';
import { compile, defaultErrorResponse, type Route } from './Route.js';
import { HttpError, type HttpRequest, type HttpResponse } from './Types.js';
import { ConnectionTracker, trackSocket } from './websocket/ConnectionWiring.js';

export interface ServerBuilder {
  /** Override the default Fastify backend (or use Express / Hono). */
  useBackend(backend: HttpServerBackend): ServerBuilder;
  /**
   * Security response headers for **this whole server**, stamped by the
   * backend onto every response it writes — including the error, not-found
   * and WebSocket upgrade-reject paths that never flow back through a
   * middleware, and the throw short-circuits that skip one.
   *
   * Left alone, a server sends `X-Content-Type-Options: nosniff` and nothing
   * else: it is the only header of the bundle that cannot change how an
   * existing application is embedded, framed or referred to.  Passing
   * options opts into the **full** {@link securityHeaders} bundle — its own
   * defaults included, so `X-Frame-Options: DENY` and
   * `Cross-Origin-Resource-Policy: same-origin` come along and will break
   * iframes and cross-origin embedding if that is how the app is used.
   * `false` turns the mechanism off entirely.
   *
   * A response's own header always wins, whatever is configured here.
   * Requires a backend that supports `setDefaultResponseHeaders` (all
   * shipped backends do).
   */
  withSecurityHeaders(options: SecurityHeadersOptions | false): ServerBuilder;
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
 * server via `builder.useBackend(new HonoBackend())`.
 */
export class HttpExtension implements Extension {
  /**
   * Shared HTTP client — uses the global fetch, on the built-in limits (30 s
   * deadline, 8 MiB response ceiling).  For different limits use
   * {@link newClient} rather than mutating this one: it is shared by every
   * actor in the system, so raising a bound for one integration would raise it
   * for all of them.
   */
  readonly client: HttpClient = new HttpClient();

  constructor(private readonly system: ActorSystem) {}

  /**
   * A client of your own, configured independently of {@link client}.
   *
   * The seam exists because the limits are per-client and deliberately strict:
   * an integration that legitimately downloads a large export, or that talks
   * to an endpoint slower than the default deadline, needs its own bounds
   * without loosening the ones every other caller inherits.  Per-request
   * overrides (`maxResponseBytes`, `timeoutMs`) cover the one-off case; this
   * covers a whole integration.
   */
  newClient(options?: HttpClientOptions): HttpClient {
    return new HttpClient(options);
  }

  /** Start building a new server scope.  Call `bind(routes)` to start it. */
  newServerAt(host: string, port: number): ServerBuilder {
    let backend: HttpServerBackend | null = null;
    let errorHandler: ((err: unknown, request: HttpRequest) => Promise<HttpResponse> | HttpResponse) | null = null;
    // `undefined` is "never configured" and must stay distinguishable from
    // `false`: the backends ship with their own default header set, so an
    // untouched builder has to leave it alone rather than overwrite it.
    let securityHeadersOptions: SecurityHeadersOptions | false | undefined;
    const system = this.system;
    return {
      useBackend(b: HttpServerBackend): ServerBuilder {
        backend = b;
        return this;
      },
      withSecurityHeaders(options: SecurityHeadersOptions | false): ServerBuilder {
        securityHeadersOptions = options;
        return this;
      },
      withErrorHandler(handler: (err: unknown, request: HttpRequest) => Promise<HttpResponse> | HttpResponse): ServerBuilder {
        errorHandler = handler;
        return this;
      },
      async bind(routes: Route): Promise<ServerBinding> {
        const active: HttpServerBackend = backend ?? await backendFromConfig(system.config);
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
                logRouteFailure(system.log, request, err, Date.now() - start);
                throw err;
              }
            },
          });
        }

        // WebSocket routes: every accepted socket flows through the
        // shared ConnectionTracker so unbind() can close it — otherwise
        // a long-lived socket keeps the server's close() pending forever.
        //
        // The policy is resolved here rather than left to the first
        // connection because this is the only place that holds both the
        // routes and the system whose config they resolve against, and the
        // backend needs `maxFrameBytes` one moment earlier than that — at
        // listen(), to size the runtime's own payload limit (#373).
        // Resolution is memoised per route, so the connections still see the
        // very same policy object.  It also moves an `OptionsError` from a
        // malformed policy to bind() instead of the first upgrade, which is
        // where a configuration error belongs.
        const tracker = new ConnectionTracker();
        for (const route of wsRoutes) {
          const policy = route.resolvePolicy(system);
          active.registerWebSocket!({
            pattern: route.pattern,
            maxFrameBytes: policy.maxFrameBytes,
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
            const start = Date.now();
            system.log.debug(`[http] (fallback) ${request.method} ${request.path}`);
            try {
              return await fb.handler(request);
            } catch (err) {
              // This branch answers with `defaultErrorResponse` instead of
              // re-throwing, so nothing downstream ever sees the error — the
              // log below is the only place it can survive at all.
              logRouteFailure(system.log, request, err, Date.now() - start);
              return defaultErrorResponse(err);
            }
          });
        }

        // Server-wide response headers.  Only pushed when the builder was
        // actually configured — see the declaration of the local above.
        if (securityHeadersOptions !== undefined) {
          if (typeof active.setDefaultResponseHeaders !== 'function') {
            throw new Error(
              `HTTP backend "${active.name}" does not support withSecurityHeaders (no setDefaultResponseHeaders hook).`,
            );
          }
          active.setDefaultResponseHeaders(
            securityHeadersOptions === false ? {} : resolveSecurityHeaders(securityHeadersOptions),
          );
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
        const shutdownTaskName = `http-unbind-${raw.host}:${raw.port}`;
        // Read once at bind time, not per unbind: the shutdown path is the
        // caller that never passes one, and it must not depend on config
        // being reachable while the system is already tearing down.
        const configuredGracePeriodMs = shutdownGracePeriodFromConfig(system.config);
        const binding: ServerBinding = {
          host: raw.host,
          port: raw.port,
          unbind(gracePeriodMs?: number): Promise<void> {
            if (!unbindOnce) {
              unbindOnce = (async () => {
                const backendUnbind = raw.unbind(gracePeriodMs ?? configuredGracePeriodMs);
                tracker.closeAll(1001, 'server shutting down');
                tracker.terminateAll();
                await backendUnbind;
                // The task is named after the address, so leaving it
                // behind made re-binding that address impossible: the
                // next `bind()` collided with a task for a server that
                // no longer exists.
                system.extension(CoordinatedShutdownId)
                  .removeTask(Phases.ServiceUnbind, shutdownTaskName);
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
          shutdownTaskName,
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

/**
 * Record a throw that escaped every `handleErrors(...)`, on the way to the
 * response the client will actually get.
 *
 * The level split is the point.  An `HttpError` is a response the handler
 * *chose* — a 404, a 401 — and its message is mapped straight into the body,
 * so it is ordinary traffic and belongs on the same debug line as a success.
 * Anything else becomes the generic 500 that deliberately withholds the
 * thrown text (#130), because that text routinely carries file paths, SQL
 * fragments or driver internals.  Redaction only works if the detail
 * survives on the server, and at `debug` it did not: nothing runs at debug
 * in production, so a redacted 500 was the sole trace of the failure
 * anywhere.  Hence `error`, and the error value itself — the `Logger`
 * contract passes it through to the sink, which is what preserves a stack.
 *
 * The id is reported as the header it came from rather than as "the" request
 * id: it is whatever the caller sent, and `requestId({ trustIncoming: false })`
 * would have replaced it downstream.  `requestIdOf` bounds it to a
 * well-formed id first — a raw client string on a log line can forge records
 * with an embedded newline.  Only the default header is consulted; a server
 * that renames it should log its own id from `withErrorHandler`.
 */
function logRouteFailure(
  log: Logger,
  request: HttpRequest,
  err: unknown,
  elapsedMs: number,
): void {
  if (err instanceof HttpError) {
    log.debug(`[http] ${request.method} ${request.path} → ${err.status} (${elapsedMs} ms)`);
    return;
  }
  const correlation = requestIdOf(request);
  log.error(
    `[http] ${request.method} ${request.path} → 500 after ${elapsedMs} ms`
    + `${correlation ? ` [x-request-id=${correlation}]` : ''}`,
    err,
  );
}

/**
 * Instantiate the backend named by `actor-ts.http.backend`.  Only consulted
 * when the builder was not given one — `useBackend(...)` is the explicit
 * layer and always wins.
 *
 * All three backends are imported dynamically rather than at module scope.
 * For Express and Hono that keeps optional peer dependencies out of the
 * bundle of an application that uses another backend.  Fastify is the
 * built-in default and a hard dependency, but ActorSystem reaches this
 * module statically (the newServerAt sugar needs the extension id and its
 * factory synchronously), so a static Fastify import here would make every
 * `import { ActorSystem } from 'actor-ts'` pay Fastify's parse cost (#1005)
 * — the lazy import moves it to the first bind, on an already-async path.
 */
async function backendFromConfig(config: Config): Promise<HttpServerBackend> {
  if (!config.hasPath(ConfigKeys.http.backend)) {
    return new (await import('./backend/FastifyBackend.js')).FastifyBackend();
  }
  const name = config.getString(ConfigKeys.http.backend);
  return await match(name)
    .with('fastify', async () => new (await import('./backend/FastifyBackend.js')).FastifyBackend())
    .with('express', async () => new (await import('./backend/ExpressBackend.js')).ExpressBackend())
    .with('hono', async () => new (await import('./backend/HonoBackend.js')).HonoBackend())
    .otherwise(() => {
      throw new ConfigError(
        `${ConfigKeys.http.backend} = "${name}" is not a known backend — `
        + 'expected "fastify", "express" or "hono".  For a backend of your own, '
        + 'pass it to newServerAt(...).useBackend(...) instead.',
      );
    });
}

/** In-flight drain window for `unbind()`, or `undefined` when unconfigured. */
function shutdownGracePeriodFromConfig(config: Config): number | undefined {
  const key = ConfigKeys.http.shutdownGracePeriod;
  return config.hasPath(key) ? config.getDuration(key) : undefined;
}

export const HttpExtensionId: ExtensionId<HttpExtension> = extensionId(
  'HttpExtension',
  (system) => new HttpExtension(system),
);
