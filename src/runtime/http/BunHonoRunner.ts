import type { FetchHandler, HonoServerHandle, HonoServerRunner } from './HonoServerRunner.js';

/**
 * Bun implementation — `Bun.serve({ hostname, port, fetch })`.
 *
 * Graceful stop calls `server.stop(false)` which lets in-flight requests
 * finish.  Non-graceful calls `server.stop(true)` which kicks active
 * connections immediately.
 */
export class BunHonoRunner implements HonoServerRunner {
  async serve(opts: { host: string; port: number; fetch: FetchHandler }): Promise<HonoServerHandle> {
    const bun = (globalThis as { Bun?: BunServeGlobal }).Bun;
    if (!bun || typeof bun.serve !== 'function') {
      throw new Error('BunHonoRunner requires the Bun runtime (globalThis.Bun.serve).');
    }
    const server = bun.serve({
      hostname: opts.host,
      port: opts.port,
      fetch: opts.fetch,
    });
    return {
      host: server.hostname ?? opts.host,
      port: server.port,
      async stop(graceful: boolean): Promise<void> { server.stop(!graceful); },
    };
  }
}

interface BunServer {
  readonly port: number;
  readonly hostname: string;
  stop(forceCloseConnections?: boolean): void;
}

interface BunServeGlobal {
  serve(opts: { hostname: string; port: number; fetch: FetchHandler }): BunServer;
}
