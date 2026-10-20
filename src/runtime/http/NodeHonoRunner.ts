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
 * `serveOptions` reaches `serve()` beneath the runner's own fields, with its
 * `serverOptions` merged under the TLS material — see `nodeServeOptions`.
 * The typed `maxHeaderBytes` is the one tuning member this runtime can take:
 * it goes into `serverOptions` as `node:http`'s `maxHeaderSize`, and the
 * handle reports it applied only once the server reads it back.
 *
 * `@hono/node-server` is an optional peer dependency: install it only if
 * you run under Node.  It is imported when `serve()` first runs, never at
 * module load, so this module is safe on every runtime — which matters,
 * because the Fastify and Express backends import
 * {@link nodeTlsServerOptions} from here wherever they run.
 */
export class NodeHonoRunner implements HonoServerRunner {
  /**
   * How `@hono/node-server` is reached, injectable so a test can stand in a
   * module that records the option bag `serve()` is handed — the bag is
   * otherwise consumed where nothing can see it.  A module mock is no
   * substitute: the default loader caches the first module it resolves for
   * the whole process, and `mock.restore()` does not undo `mock.module()`.
   * The seam is the loader rather than the import, so how the default
   * resolves the peer can change without touching it.
   */
  constructor(
    private readonly loadServerModule: () => Promise<HonoNodeServerModule> = loadHonoNodeServer,
  ) {}

  async serve(options: HonoServeOptions): Promise<HonoServerHandle> {
    const mod = await this.loadServerModule();
    const secure = options.tls ? await nodeSecureServerFactory(options.tls, options.http2 === true) : undefined;

    // `serve()` returns a node:http Server; we wait for its 'listening'
    // event (via the optional callback) to know the bound port.
    const server = await new Promise<NodeHttpServer>((resolve, reject) => {
      try {
        const serveResult = mod.serve(nodeServeOptions(options, secure), (info) => {
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
      // Read back rather than assumed: the cap reached `createServer`, but only
      // a server that reports holding it is holding it.  Node and Bun do;
      // Deno's `node:http` shim reads it back as `undefined` and lets a 4 KiB
      // header through (deno 2.6.8).
      appliedServeOptions: {
        maxHeaderBytes: options.maxHeaderBytes !== undefined && server.maxHeaderSize === options.maxHeaderBytes,
      },
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
  /** The header cap the server was built with; absent where the runtime keeps none. */
  readonly maxHeaderSize?: number;
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
 * The TLS fields map through {@link nodeTlsServerOptions}.
 */
async function nodeSecureServerFactory(tls: HonoServeTls, http2: boolean): Promise<NodeServerFactory> {
  const serverOptions = nodeTlsServerOptions(tls);
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

/** What {@link nodeTlsServerOptions} returns: the server side of `node:tls`'s option names. */
export type NodeTlsServerFields = {
  cert?: string | Uint8Array;
  key?: string | Uint8Array;
  ca?: string | Uint8Array;
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
};

/**
 * The `node:tls` server options a {@link HonoServeTls} asks for — the one
 * spelling of that mapping, shared by the three listeners that hand it to a
 * `node:*` server factory: this runner's `https` and `http2` servers,
 * Fastify's `https` factory option (`fastifyFactoryOptions`), and the `https`
 * server the Express backend builds.  It lives here because this runner was
 * its first user and is the one of the three in the runtime layer, which the
 * HTTP backends import and which imports none of them back.
 *
 * `cert`, `key` and `ca` go in as given; `requestClientCert` becomes
 * `requestCert`, the `node:tls` spelling; `rejectUnauthorized` passes through.
 * `cert` and `key` are always present, the other three only when set, so an
 * unset one is left to `node:tls`: no client certificate is requested, and one
 * that is requested has to verify — against `ca`, which
 * `HttpServerOptionsValidator` does not let a demand go without.
 *
 * @internal — exported for `FastifyBackend` and `ExpressBackend`.
 */
export function nodeTlsServerOptions(tls: HonoServeTls): NodeTlsServerFields {
  const options: NodeTlsServerFields = { cert: tls.cert, key: tls.key };
  if (tls.ca !== undefined) options.ca = tls.ca;
  if (tls.requestClientCert !== undefined) options.requestCert = tls.requestClientCert;
  if (tls.rejectUnauthorized !== undefined) options.rejectUnauthorized = tls.rejectUnauthorized;
  return options;
}

/**
 * The bag `@hono/node-server`'s `serve()` receives.  The named members are the
 * ones this runner writes; the index signature carries whatever else a
 * caller's `serveOptions` holds — `overrideGlobalObjects`,
 * `autoCleanupIncoming`, `websocket` — which the module reads and this runner
 * passes on unread.
 */
type HonoNodeServeOptions = {
  readonly hostname: string;
  readonly port: number;
  readonly fetch: FetchHandler;
  readonly createServer?: NodeServerFactory['createServer'];
  readonly serverOptions: object;
  readonly [option: string]: unknown;
};

/** The two `serveOptions` members the runner does not pass on as they come. */
type CallerServeOptions = {
  readonly serverOptions?: object;
  readonly createServer?: unknown;
};

/**
 * Fold the caller's `serveOptions` into `serve()`'s bag, beneath the runner's
 * own fields (#1486).
 *
 * The caller's keys go in first, so nothing in them can move the listener:
 * `hostname`, `port` and `fetch` are the runner's, and so is `createServer` —
 * the TLS factory under `tls`, the module's own `node:http` one otherwise —
 * because the factory decides whether the socket speaks TLS or HTTP/2 at all,
 * which is `tls`'s and `http2`'s to say.  A caller's factory is dropped even
 * without TLS: `http2.createServer` there would be the h2c listener the
 * options validator refuses (#1522).
 *
 * `serverOptions` is the one member both sides write, so it is merged rather
 * than replaced.  It is where the `node:http` tuning goes (`maxHeaderSize`,
 * `connectionsCheckingInterval`), and under TLS it carries the certificate
 * too, spread last so the configured material wins a collision.  Spreading
 * either bag over the other loses a side: the caller's tuning, or the
 * certificate — and a listener that no longer terminates TLS with the
 * material it was configured with is what #1522 rules out.
 *
 * The typed `maxHeaderBytes` goes in between, as `maxHeaderSize`: over the
 * caller's bag, because the bag sits beneath everything the runner writes,
 * and under the TLS material, which it never collides with.  Under TLS this
 * is the `serverOptions` the TLS factory is handed — the only place a header
 * cap reaches an `https` or HTTP/2 listener at all (#1488).
 */
function nodeServeOptions(options: HonoServeOptions, secure: NodeServerFactory | undefined): HonoNodeServeOptions {
  const { serverOptions, createServer: _callerFactory, ...caller } = (options.serveOptions ?? {}) as CallerServeOptions;
  const headerCap = options.maxHeaderBytes !== undefined ? { maxHeaderSize: options.maxHeaderBytes } : {};
  return {
    ...caller,
    hostname: options.host,
    port: options.port,
    fetch: options.fetch,
    serverOptions: { ...serverOptions, ...headerCap, ...secure?.serverOptions },
    ...(secure ? { createServer: secure.createServer } : {}),
  };
}

interface HonoNodeServerModule {
  serve(
    options: HonoNodeServeOptions,
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
