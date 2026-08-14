import type {
  FetchHandler,
  HonoServerHandle,
  HonoServerRunner,
  HonoWebsocketBridge,
} from './HonoServerRunner.js';

/**
 * Deno implementation — `Deno.serve({ hostname, port }, fetch)`.
 * Returns a `HttpServer` with `.shutdown()` for graceful stop and
 * `.unref()` + `AbortController` for hard stop.
 *
 * Requires `--allow-net` to bind the listener.  WebSocket support uses
 * `upgradeWebSocket` from `hono/deno` (which wraps `Deno.upgradeWebSocket`).
 */
export class DenoHonoRunner implements HonoServerRunner {
  async serve(options: { host: string; port: number; fetch: FetchHandler; serveOptions?: object }): Promise<HonoServerHandle> {
    const deno = (globalThis as { Deno?: DenoGlobal }).Deno;
    if (!deno || typeof deno.serve !== 'function') {
      throw new Error('DenoHonoRunner requires Deno runtime (globalThis.Deno.serve).');
    }
    const ac = new AbortController();
    const server = deno.serve({ hostname: options.host, port: options.port, signal: ac.signal, ...(options.serveOptions ?? {}) }, options.fetch);
    return {
      host: options.host,
      port: options.port,
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

  /**
   * `maxFrameBytes` is accepted for signature parity and then deliberately
   * dropped: Deno has no transport-level frame cap to install.  Hono's Deno
   * adapter forwards its option bag straight into `Deno.upgradeWebSocket`,
   * whose options are `protocol` and `idleTimeout` only — there is no
   * payload-size member to set.  So on Deno an oversize frame is still fully
   * buffered by the runtime before `maxFrameBytes` rejects it, and the
   * bridge reports that honestly by leaving `transportFrameCapBytes` unset
   * (#586).  Bun and Node do install the cap.
   */
  async webSocket(_app: unknown, _maxFrameBytes: number): Promise<HonoWebsocketBridge> {
    let mod: { upgradeWebSocket: unknown };
    try {
      const name = 'hono/deno';
      mod = (await import(name)) as typeof mod;
    } catch (e) {
      throw new Error(
        'websocket() routes on the Hono backend (Deno) require "hono".  '
          + 'Install it with: deno add npm:hono\nOriginal error: '
          + (e instanceof Error ? e.message : String(e)),
      );
    }
    return {
      upgradeWebSocket: mod.upgradeWebSocket as HonoWebsocketBridge['upgradeWebSocket'],
      serveOptions: {},
    };
  }
}

interface DenoHttpServer {
  readonly finished: Promise<void>;
  shutdown?(): Promise<void>;
}

interface DenoGlobal {
  serve(
    options: { hostname: string; port: number; signal?: AbortSignal },
    handler: FetchHandler,
  ): DenoHttpServer;
}
