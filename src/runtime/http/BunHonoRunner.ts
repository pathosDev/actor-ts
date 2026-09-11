import type {
  FetchHandler,
  HonoServeOptions,
  HonoServeTls,
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
  /**
   * The `Bun` global, injectable because `globalThis.Bun` is not
   * configurable — a test that wants to stand in an older `version` cannot
   * redefine it, so it hands one in here instead.
   */
  constructor(
    private readonly bunGlobal: BunServeGlobal | undefined = (globalThis as { Bun?: BunServeGlobal }).Bun,
  ) {}

  async serve(options: HonoServeOptions): Promise<HonoServerHandle> {
    const bun = this.bunGlobal;
    if (!bun || typeof bun.serve !== 'function') {
      throw new Error('BunHonoRunner requires the Bun runtime (globalThis.Bun.serve).');
    }
    // `http2` is passed only when TLS is: Bun accepts `http2: true` on a
    // plain socket and serves h2c, which the layer above refuses by policy
    // and this runner must not reintroduce by accident (#1522).  And only
    // on a Bun that has the option: it arrived in 1.4.1, the `engines`
    // floor is 1.3.0, and an older Bun would serve HTTP/1.1 under a setting
    // that says otherwise — refused, like every other silent downgrade here.
    if (options.tls && options.http2 && !bunSupportsHttp2(bun.version)) {
      throw new Error(
        `HTTP/2 on Bun.serve needs Bun >= ${BUN_HTTP2_SINCE} (this is ${bun.version}): `
          + 'upgrade Bun, or leave http2 off — HTTP/1.1 over TLS is still served.',
      );
    }
    const server = bun.serve({
      hostname: options.host,
      port: options.port,
      fetch: options.fetch,
      ...(options.tls ? { tls: bunTlsOptions(options.tls) } : {}),
      ...(options.tls && options.http2 ? { http2: true } : {}),
      ...(options.serveOptions ?? {}),
    });
    return {
      host: server.hostname ?? options.host,
      port: server.port,
      async stop(graceful: boolean): Promise<void> { server.stop(!graceful); },
    };
  }

  async webSocket(_app: unknown, maxFrameBytes: number): Promise<HonoWebsocketBridge> {
    let mod: { createBunWebSocket: () => { upgradeWebSocket: unknown; websocket: object } };
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
      // Bun's `websocket` bag carries the handlers *and* the socket options,
      // so the transport cap rides along with the handlers Hono built.  Left
      // unset, Bun buffers up to its own 16 MiB default before the
      // application-level `maxFrameBytes` check ever sees the frame (#586).
      // Past the cap Bun drops the connection rather than sending a policy
      // close, so the peer observes 1006 and not the app layer's clean 1009.
      serveOptions: { websocket: { ...websocket, maxPayloadLength: maxFrameBytes } },
      transportFrameCapBytes: maxFrameBytes,
    };
  }
}

/** The release that added `http2` to `Bun.serve`. */
export const BUN_HTTP2_SINCE = '1.4.1';

/**
 * Whether a `Bun.version` string is at or past {@link BUN_HTTP2_SINCE}.
 * Numeric on the first three dotted fields; a canary or prerelease suffix
 * (`1.4.1-canary.3`) counts as its base version, which is what `bun
 * upgrade --canary` users would expect.
 */
export function bunSupportsHttp2(version: string): boolean {
  const parse = (text: string): number[] =>
    text.split('-')[0]!.split('.').slice(0, 3).map((field) => Number.parseInt(field, 10) || 0);
  const [major = 0, minor = 0, patch = 0] = parse(version);
  const [sinceMajor = 0, sinceMinor = 0, sincePatch = 0] = parse(BUN_HTTP2_SINCE);
  if (major !== sinceMajor) return major > sinceMajor;
  if (minor !== sinceMinor) return minor > sinceMinor;
  return patch >= sincePatch;
}

interface BunServer {
  readonly port: number;
  readonly hostname: string;
  stop(forceCloseConnections?: boolean): void;
}

/** `Bun.serve`'s `tls` bag, the fields this runner writes; names as Bun spells them. */
type BunTlsOptions = {
  readonly cert: string | Uint8Array;
  readonly key: string | Uint8Array;
  readonly ca?: string | Uint8Array;
  readonly requestCert?: boolean;
  readonly rejectUnauthorized?: boolean;
};

/**
 * Bun spells the client-certificate demand `requestCert`; the option type
 * spells it `requestClientCert` to match the TCP transport.  Undefined
 * fields are left out rather than written as `undefined`, since Bun reads
 * a present key as set.
 */
function bunTlsOptions(tls: HonoServeTls): BunTlsOptions {
  const out: { -readonly [K in keyof BunTlsOptions]: BunTlsOptions[K] } = { cert: tls.cert!, key: tls.key! };
  if (tls.ca !== undefined) out.ca = tls.ca;
  if (tls.requestClientCert !== undefined) out.requestCert = tls.requestClientCert;
  if (tls.rejectUnauthorized !== undefined) out.rejectUnauthorized = tls.rejectUnauthorized;
  return out;
}

interface BunServeGlobal {
  readonly version: string;
  serve(options: {
    hostname: string;
    port: number;
    fetch: FetchHandler;
    websocket?: unknown;
    tls?: BunTlsOptions;
    /** Bun 1.4.1+; `@types/bun` 1.4.2 does not declare it yet, so it is declared here. */
    http2?: boolean;
  }): BunServer;
}
