import type { FetchHandler, HonoServerHandle, HonoServerRunner } from './HonoServerRunner.js';

/**
 * Deno implementation — `Deno.serve({ hostname, port }, fetch)`.
 * Returns a `HttpServer` with `.shutdown()` for graceful stop and
 * `.unref()` + `AbortController` for hard stop.
 *
 * Requires `--allow-net` to bind the listener.
 */
export class DenoHonoRunner implements HonoServerRunner {
  async serve(opts: { host: string; port: number; fetch: FetchHandler }): Promise<HonoServerHandle> {
    const deno = (globalThis as { Deno?: DenoGlobal }).Deno;
    if (!deno || typeof deno.serve !== 'function') {
      throw new Error('DenoHonoRunner requires Deno runtime (globalThis.Deno.serve).');
    }
    const ac = new AbortController();
    const server = deno.serve({ hostname: opts.host, port: opts.port, signal: ac.signal }, opts.fetch);
    return {
      host: opts.host,
      port: opts.port,
      async stop(graceful: boolean): Promise<void> {
        if (graceful && typeof server.shutdown === 'function') {
          await server.shutdown();
          return;
        }
        ac.abort();
        try { await server.finished; } catch { /* ignore */ }
      },
    };
  }
}

interface DenoHttpServer {
  readonly finished: Promise<void>;
  shutdown?(): Promise<void>;
}

interface DenoGlobal {
  serve(
    opts: { hostname: string; port: number; signal?: AbortSignal },
    handler: FetchHandler,
  ): DenoHttpServer;
}
