import type { ActorSystem } from '../ActorSystem.js';
import { CoordinatedShutdownId, Phases } from '../CoordinatedShutdown.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import type { HttpServerBackend, ServerBinding } from './backend/HttpServerBackend.js';
import { FastifyBackend } from './backend/FastifyBackend.js';
import { HttpClient } from './HttpClient.js';
import { compile, type Route } from './Route.js';
import type { HttpRequest, HttpResponse } from './types.js';

export interface ServerBuilder {
  /** Override the default Fastify backend (or use BunServe / Express). */
  useBackend(backend: HttpServerBackend): ServerBuilder;
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
    const system = this.system;
    return {
      useBackend(b: HttpServerBackend): ServerBuilder {
        backend = b;
        return this;
      },
      async bind(routes: Route): Promise<ServerBinding> {
        const active = backend ?? new FastifyBackend();
        const compiled = compile(routes);
        // Wrap each route's handler with a request log + timing.
        // Done at the DSL level so backends don't need a Logger
        // reference — every backend gets the same per-request debug
        // line uniformly.
        for (const r of compiled) {
          const wrapped = {
            ...r,
            handler: async (req: HttpRequest): Promise<HttpResponse> => {
              const start = Date.now();
              system.log.debug(`[http] ${req.method} ${req.path}`);
              try {
                const out = await r.handler(req);
                system.log.debug(
                  `[http] ${req.method} ${req.path} → ${out.status} (${Date.now() - start} ms)`,
                );
                return out;
              } catch (err) {
                system.log.debug(
                  `[http] ${req.method} ${req.path} → error after ${Date.now() - start} ms: ${(err as Error).message}`,
                );
                throw err;
              }
            },
          };
          active.registerRoute(wrapped);
        }
        const raw = await active.listen(host, port);
        // Wrap `unbind` so it's idempotent — both the auto-registered
        // CoordinatedShutdown task and any manual caller can invoke it
        // safely; subsequent calls return the in-flight/resolved promise
        // from the first.
        let unbindOnce: Promise<void> | null = null;
        const binding: ServerBinding = {
          host: raw.host,
          port: raw.port,
          unbind(gracePeriodMs?: number): Promise<void> {
            if (!unbindOnce) unbindOnce = raw.unbind(gracePeriodMs);
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
        system.log.debug(`[http] ${compiled.length} route(s) registered`);
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
