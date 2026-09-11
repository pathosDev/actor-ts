import { Lazy } from '../../util/Lazy.js';
import type {
  FetchHandler,
  HonoServeOptions,
  HonoServeTls,
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
  async serve(options: HonoServeOptions): Promise<HonoServerHandle> {
    const mod = await loadHonoNodeServer();
    const secure = options.tls ? await nodeSecureServerFactory(options.tls, options.http2 === true) : {};

    // `serve()` returns a node:http Server; we wait for its 'listening'
    // event (via the optional callback) to know the bound port.
    const server = await new Promise<NodeHttpServer>((resolve, reject) => {
      try {
        const serveResult = mod.serve({
          hostname: options.host,
          port: options.port,
          fetch: options.fetch,
          ...secure,
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
  /**
   * The `ws` server the adapter built for itself; see
   * {@link buildNodeWebsocketBridge}.  Optional even though the declared peer
   * floor guarantees it: an *optional* peer range is advisory — package
   * managers warn on a violation rather than refuse the install — so the
   * runtime check has to stay reachable, and it only type-checks while this
   * stays optional.
   */
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
 * The two ways that verification can fail have nothing to do with each other,
 * so they are reported apart.  `wss` itself is not a `ws` internal at all: the
 * adapter only started returning it in **1.2.0**, which is why that is the
 * declared peer floor.  An installation below it is an old dependency, not a
 * regression, and one message covering both would send its reader hunting a
 * `ws` change that never happened.
 *
 * @internal — exported so a test can drive it with a captured `wss`.
 */
export function buildNodeWebsocketBridge(
  createNodeWebSocket: CreateNodeWebSocketFunction,
  app: unknown,
  maxFrameBytes: number,
): HonoWebsocketBridge {
  const { upgradeWebSocket, injectWebSocket, wss } = createNodeWebSocket({ app });
  if (!wss) {
    throw new Error(
      'NodeHonoRunner: cannot install the WebSocket frame cap — the installed '
        + '"@hono/node-ws" does not return its "ws" server as "wss".  That member was added '
        + 'in 1.2.0, so this is a version below the supported floor rather than a '
        + 'regression: install "@hono/node-ws" >= 1.2.0.  Running without the cap would let '
        + 'a peer buffer frames far larger than maxFrameBytes.',
    );
  }
  const options = wss.options;
  if (!options || typeof options.maxPayload !== 'number') {
    throw new Error(
      'NodeHonoRunner: cannot install the WebSocket frame cap — the "ws" server behind '
        + '"@hono/node-ws" no longer exposes a numeric options.maxPayload.  Pin "ws" to a '
        + 'version that does; running without the cap would let a peer buffer frames far '
        + 'larger than maxFrameBytes.',
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

/**
 * `@hono/node-server`'s `createServer` / `serverOptions` pair: which
 * `node:*` factory builds the listener and what it is handed.  Typed as the
 * slice this runner writes, since the module is an optional peer.
 */
type NodeServerFactory = {
  readonly createServer: (options: object, listener?: unknown) => NodeHttpServer;
  readonly serverOptions: object;
};

/**
 * Pick the `node:*` factory a TLS listener needs.
 *
 * TLS alone is `https.createServer`; TLS with HTTP/2 is
 * `http2.createSecureServer` with `allowHTTP1`, which is the one shape that
 * negotiates `h2` through ALPN *and* keeps HTTP/1.1 on the same port —
 * measured on Node 26.7: a `node:http2` client gets `alpn=h2`, an `https`
 * client gets `httpVersion=1.1`, both `200`, against one listener.  Without
 * `allowHTTP1` the second would be refused with "no application protocol",
 * which is exactly what the plain `https` server does when an h2 client
 * tries it (#1522).
 *
 * `requestClientCert` becomes `requestCert`, the `node:tls` spelling.
 */
async function nodeSecureServerFactory(tls: HonoServeTls, http2: boolean): Promise<NodeServerFactory> {
  const serverOptions: Record<string, unknown> = { cert: tls.cert, key: tls.key };
  if (tls.ca !== undefined) serverOptions.ca = tls.ca;
  if (tls.requestClientCert !== undefined) serverOptions.requestCert = tls.requestClientCert;
  if (tls.rejectUnauthorized !== undefined) serverOptions.rejectUnauthorized = tls.rejectUnauthorized;
  if (http2) {
    const { createSecureServer } = await import('node:http2');
    return {
      createServer: createSecureServer as unknown as NodeServerFactory['createServer'],
      serverOptions: { ...serverOptions, allowHTTP1: true },
    };
  }
  const { createServer } = await import('node:https');
  return { createServer: createServer as unknown as NodeServerFactory['createServer'], serverOptions };
}

interface HonoNodeServerModule {
  serve(
    options: { hostname: string; port: number; fetch: FetchHandler } & Partial<NodeServerFactory>,
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
