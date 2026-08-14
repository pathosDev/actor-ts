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

  async webSocket(app: unknown, maxFrameBytes: number): Promise<HonoWebsocketBridge> {
    let mod: { createNodeWebSocket: CreateNodeWebSocketFunction };
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
    return buildNodeWebsocketBridge(mod.createNodeWebSocket, app, maxFrameBytes);
  }
}

/* ----------------------------- internals --------------------------------- */

/**
 * The slice of `@hono/node-ws` we consume — it is an optional peer dep.
 * @internal — exported so a test can supply a wrapping implementation.
 */
export type CreateNodeWebSocketFunction = (options: { app: unknown }) => {
  upgradeWebSocket: unknown;
  injectWebSocket: (server: unknown) => void;
  /** The `ws` server the adapter built for itself; see {@link buildNodeWebsocketBridge}. */
  wss?: WebsocketServerLike;
};

/** The `ws` `WebSocketServer` slice we touch: its merged, mutable option bag. */
type WebsocketServerLike = { options?: { maxPayload?: number } };

/**
 * Build the Node bridge and install `maxFrameBytes` as the **transport** cap.
 *
 * `createNodeWebSocket` takes no options bag and constructs its own
 * `WebSocketServer({ noServer: true })`, which leaves `ws` on its 100 MiB
 * `maxPayload` default — two orders of magnitude above the frame size the
 * application admits, all of it buffered before the app-level check runs
 * (#586).  The adapter does return that server as `wss`, and `ws` keeps its
 * merged options as a plain object it re-reads on **every** upgrade, so
 * writing the cap after construction reaches every future connection.
 *
 * That is an internal of `ws`, so the write is verified rather than assumed:
 * a version that stops exposing a numeric `options.maxPayload` would
 * otherwise leave the socket uncapped with nothing to notice it.  Failing the
 * upgrade wiring loudly is the safer half of that trade — a silently ignored
 * cap is exactly the defect this closes.
 *
 * @internal — exported so a test can drive it with a captured `wss`.
 */
export function buildNodeWebsocketBridge(
  createNodeWebSocket: CreateNodeWebSocketFunction,
  app: unknown,
  maxFrameBytes: number,
): HonoWebsocketBridge {
  const { upgradeWebSocket, injectWebSocket, wss } = createNodeWebSocket({ app });
  const options = wss?.options;
  if (!options || typeof options.maxPayload !== 'number') {
    throw new Error(
      'NodeHonoRunner: cannot install the WebSocket frame cap — "@hono/node-ws" no longer '
        + 'exposes a "ws" server with a numeric options.maxPayload.  Pin "@hono/node-ws" and '
        + '"ws" to a version that does; running without the cap would let a peer buffer '
        + 'frames far larger than maxFrameBytes.',
    );
  }
  options.maxPayload = maxFrameBytes;
  return {
    upgradeWebSocket: upgradeWebSocket as HonoWebsocketBridge['upgradeWebSocket'],
    serveOptions: {},
    attach: (handle: HonoServerHandle) => {
      if (handle.raw) injectWebSocket(handle.raw);
    },
    transportFrameCapBytes: maxFrameBytes,
  };
}

interface NodeHttpServer {
  close(callback?: () => void): void;
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
