import { Lazy } from '../../util/Lazy.js';
import type {
  FetchHandler,
  HonoServerHandle,
  HonoServerRunner,
  HonoWebsocketBridge,
} from './HonoServerRunner.js';

/**
 * Node.js implementation — `@hono/node-server`'s `serve()`, which wraps a
 * `node:http` server around a standard fetch handler.  Graceful stop calls
 * `server.close()` (waits for in-flight) with a timeout after which
 * `closeAllConnections()` forces the kill.
 *
 * `@hono/node-server` is an optional peer dependency: install it only if
 * you run under Node.  On Bun/Deno this module is never imported at
 * runtime (the factory dispatches elsewhere).
 */
export class NodeHonoRunner implements HonoServerRunner {
  async serve(options: { host: string; port: number; fetch: FetchHandler; serveOptions?: object }): Promise<HonoServerHandle> {
    const mod = await loadHonoNodeServer();

    // `serve()` returns a node:http Server; we wait for its 'listening'
    // event (via the optional callback) to know the bound port.
    const server = await new Promise<NodeHttpServer>((resolve, reject) => {
      try {
        const serveResult = mod.serve({
          hostname: options.host,
          port: options.port,
          fetch: options.fetch,
        }, (info) => {
          resolve(Object.assign(serveResult, { _info: info }) as unknown as NodeHttpServer);
        });
      } catch (e) {
        reject(e as Error);
      }
    });

    const addr = server.address?.();
    const actualPort =
      typeof addr === 'object' && addr !== null ? addr.port : options.port;

    return {
      host: options.host,
      port: actualPort,
      raw: server,
      stop(graceful: boolean): Promise<void> {
        return new Promise<void>((resolve) => {
          const timer = !graceful
            ? setTimeout(() => {
                server.closeAllConnections?.();
                resolve();
              }, 0)
            : null;
          server.close(() => {
            if (timer) clearTimeout(timer);
            resolve();
          });
        });
      },
    };
  }

  async webSocket(app: unknown): Promise<HonoWebsocketBridge> {
    let mod: {
      createNodeWebSocket: (options: { app: unknown }) => {
        upgradeWebSocket: unknown;
        injectWebSocket: (server: unknown) => void;
      };
    };
    try {
      const name = '@hono/node-ws';
      mod = (await import(name)) as typeof mod;
    } catch (e) {
      throw new Error(
        'websocket() routes on the Hono backend (Node) require "@hono/node-ws".  '
          + 'Install it with: npm install @hono/node-ws\nOriginal error: '
          + (e instanceof Error ? e.message : String(e)),
      );
    }
    const { upgradeWebSocket, injectWebSocket } = mod.createNodeWebSocket({ app });
    return {
      upgradeWebSocket: upgradeWebSocket as HonoWebsocketBridge['upgradeWebSocket'],
      serveOptions: {},
      attach: (handle: HonoServerHandle) => {
        if (handle.raw) injectWebSocket(handle.raw);
      },
    };
  }
}

/* ----------------------------- internals --------------------------------- */

interface NodeHttpServer {
  close(cb?: () => void): void;
  closeAllConnections?(): void;
  address?(): { port: number; address: string } | string | null;
}

interface HonoNodeServerModule {
  serve(
    options: { hostname: string; port: number; fetch: FetchHandler },
    onReady?: (info: { address: string; port: number }) => void,
  ): NodeHttpServer;
}

// The Lazy caches the Promise itself — concurrent callers share the
// in-flight import.  A failure is cached too, so the "install the peer
// dep" error message is shown consistently instead of retrying the
// import on every call.
const honoServerLazy: Lazy<Promise<HonoNodeServerModule>> = Lazy.of(async () => {
  try {
    const name = '@hono/node-server';
    return (await import(name)) as unknown as HonoNodeServerModule;
  } catch (e) {
    throw new Error(
      'NodeHonoRunner requires the "@hono/node-server" package.  Install it with: '
      + 'npm install @hono/node-server\nOriginal error: '
      + (e instanceof Error ? e.message : String(e)),
    );
  }
});

function loadHonoNodeServer(): Promise<HonoNodeServerModule> { return honoServerLazy.get(); }
