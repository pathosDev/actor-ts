import type {
  FetchHandler,
  HonoServerHandle,
  HonoServerRunner,
  HonoWebsocketBridge,
} from './HonoServerRunner.js';

/**
 * Bun implementation — `Bun.serve({ hostname, port, fetch })`.
 *
 * Graceful stop calls `server.stop(false)` which lets in-flight requests
 * finish.  Non-graceful calls `server.stop(true)` which kicks active
 * connections immediately.
 *
 * WebSocket support uses `createBunWebSocket()` from `hono/bun`, whose
 * `websocket` handler object must be passed to `Bun.serve` — so we fold
 * it into `serveOptions`.
 */
export class BunHonoRunner implements HonoServerRunner {
  async serve(opts: { host: string; port: number; fetch: FetchHandler; serveOptions?: object }): Promise<HonoServerHandle> {
    const bun = (globalThis as { Bun?: BunServeGlobal }).Bun;
    if (!bun || typeof bun.serve !== 'function') {
      throw new Error('BunHonoRunner requires the Bun runtime (globalThis.Bun.serve).');
    }
    const server = bun.serve({
      hostname: opts.host,
      port: opts.port,
      fetch: opts.fetch,
      ...(opts.serveOptions ?? {}),
    });
    return {
      host: server.hostname ?? opts.host,
      port: server.port,
      async stop(graceful: boolean): Promise<void> { server.stop(!graceful); },
    };
  }

  async webSocket(_app: unknown): Promise<HonoWebsocketBridge> {
    let mod: { createBunWebSocket: () => { upgradeWebSocket: unknown; websocket: unknown } };
    try {
      const name = 'hono/bun';
      mod = (await import(name)) as typeof mod;
    } catch (e) {
      throw new Error(
        'websocket() routes on the Hono backend (Bun) require "hono".  '
          + 'Install it with: bun add hono\nOriginal error: '
          + (e instanceof Error ? e.message : String(e)),
      );
    }
    const { upgradeWebSocket, websocket } = mod.createBunWebSocket();
    return {
      upgradeWebSocket: upgradeWebSocket as HonoWebsocketBridge['upgradeWebSocket'],
      serveOptions: { websocket },
    };
  }
}

interface BunServer {
  readonly port: number;
  readonly hostname: string;
  stop(forceCloseConnections?: boolean): void;
}

interface BunServeGlobal {
  serve(opts: { hostname: string; port: number; fetch: FetchHandler; websocket?: unknown }): BunServer;
}
