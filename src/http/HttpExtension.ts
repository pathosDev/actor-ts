import type { ActorSystem } from '../ActorSystem.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import type { HttpServerBackend, ServerBinding } from './backend/HttpServerBackend.js';
import { FastifyBackend } from './backend/FastifyBackend.js';
import { HttpClient } from './HttpClient.js';
import { compile, type Route } from './Route.js';

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
        for (const r of compile(routes)) active.registerRoute(r);
        const binding = await active.listen(host, port);
        system.log.info(`HTTP server bound on ${binding.host}:${binding.port} (${active.name})`);
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
