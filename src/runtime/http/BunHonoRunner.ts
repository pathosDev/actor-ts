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
 *
 * The idle timeout is `Bun.serve`'s own `idleTimeout`, written from the typed
 * `idleTimeoutMs`, or derived from `requestDeadlineMs` when that is unset —
 * see {@link bunIdleTimeoutOf} (#1487).
 */
export class BunHonoRunner implements HonoServerRunner {
  /** `Bun.serve` refuses an `idleTimeout` past {@link BUN_MAX_IDLE_TIMEOUT_SECONDS}; the backend refuses first, naming the key. */
  readonly idleTimeoutCeilingMs = BUN_MAX_IDLE_TIMEOUT_SECONDS * 1_000;

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
    // Before `Bun.serve`, so a value it would refuse never reaches it.
    const idle = bunIdleTimeoutOf(options);
    // `serveOptions` goes in first, beneath everything the runner writes, and
    // its own `tls`, `http2` and `idleTimeout` are dropped rather than merely
    // outranked: the listener's TLS and HTTP/2 shape and its idle timeout are
    // the typed members' to decide, set or unset.  A bag `http2` with no
    // `tls` is the h2c listener refused above (#1486), and a bag
    // `idleTimeout` would pass the conversion and the ceiling by (#1487).
    const { tls: _tls, http2: _http2, idleTimeout: _idleTimeout, ...tuning } = (options.serveOptions ?? {}) as BunListenerShape;
    const server = bun.serve({
      ...tuning,
      hostname: options.host,
      port: options.port,
      fetch: options.fetch,
      ...(idle.seconds !== undefined ? { idleTimeout: idle.seconds } : {}),
      ...(options.tls ? { tls: bunTlsOptions(options.tls) } : {}),
      ...(options.tls && options.http2 ? { http2: true } : {}),
    });
    return {
      host: server.hostname ?? options.host,
      port: server.port,
      appliedServeOptions: {
        // No per-server header cap on `Bun.serve`: Bun's is the process-wide
        // `--max-http-header-size` (#1488).
        maxHeaderBytes: false,
        idleTimeoutMs: options.idleTimeoutMs !== undefined,
        ...(idle.heldAtCeilingMs !== undefined ? { idleTimeoutHeldAtCeilingMs: idle.heldAtCeilingMs } : {}),
      },
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
 * The longest `idleTimeout` `Bun.serve` accepts, in seconds.  Past it Bun
 * throws a `TypeError` at bind rather than clamping — measured on bun 1.4.2,
 * `255` binds and `256` throws, and so does any fraction (`1.5`).
 */
export const BUN_MAX_IDLE_TIMEOUT_SECONDS = 255;

/**
 * How often Bun checks its connections for idleness, in seconds.  A value of
 * `X` seconds is held as `ceil(X / 4)` sweeps, and a connection silent that
 * long is cut on the sweep that completes them — so up to one sweep *before*
 * `X`.  Measured on bun 1.4.2 with silent in-flight requests started at
 * staggered offsets: `idleTimeout: 8` cut every one of them on the same sweep,
 * between 4.5 s and 8.0 s after each had started; `1` and `2` within 4 s, `5`
 * between 5.0 s and 8.0 s, `9` between 9.0 s and 12.0 s.
 */
export const BUN_IDLE_SWEEP_SECONDS = 4;

/**
 * How far past the request deadline the earliest possible cut of a derived
 * idle timeout must land, in seconds — room for the `503` that
 * `requestTimeout()` answers at the deadline to be written and flushed before
 * Bun closes the connection under the handler.
 */
const IDLE_CUT_MARGIN_SECONDS = 2;

/** What {@link bunIdleTimeoutOf} decided: the `idleTimeout` to write, if any, and whether a derived one fell short. */
type BunIdleTimeout = {
  /** `Bun.serve`'s `idleTimeout`, or `undefined` to leave Bun's own default (10 s). */
  readonly seconds?: number;
  /** Set when a derived value was held at the ceiling, too short for the deadline it came from — the ceiling, in ms. */
  readonly heldAtCeilingMs?: number;
};

/**
 * The `idleTimeout` this runner writes into `Bun.serve` (#1487).
 *
 * **Set**, `idleTimeoutMs` is converted to whole seconds by rounding *up*:
 * `0` stays `0` — off — and any other value becomes `Math.ceil(ms / 1000)`.
 * Never a floor and never a plain division, because `Bun.serve` reads `0` as
 * "never close" and throws on a fraction: 1–999 ms has to become 1 s.  A value
 * that rounds past {@link BUN_MAX_IDLE_TIMEOUT_SECONDS} is refused here, before
 * `Bun.serve` is called — the backend refuses it first, by the key's name, so
 * this is the guard for a caller that reaches the runner directly.
 *
 * **Unset**, it is derived from `requestDeadlineMs`.  Bun's bound is the whole
 * connection, and a request whose handler has written nothing counts as idle,
 * so Bun's own 10 s — cut at about 12 s — closed any handler slower than that
 * with no response at all, `requestTimeout()`'s `503` included.  The derived
 * value is the smallest multiple of the sweep whose *earliest* cut, one sweep
 * before the value, still lands {@link IDLE_CUT_MARGIN_SECONDS} past the
 * deadline: `4 * (ceil((deadline + 2 s) / 4) + 1)` seconds — 36 s for the
 * built-in 30 s deadline.  Measured on bun 1.4.2 with a handler that answers
 * `503` at 30 s, started at eight phases of one sweep: under 36 every request
 * got its `503` at 30.0 s, and under 32 the three started latest in the sweep
 * were cut at 28.5 s to 29.5 s with no bytes.
 *
 * Held at the ceiling, a derived value may cover the deadline anyway — 255 s
 * is 64 sweeps, cut at 252 s at the earliest — and is reported only when it
 * does not, which is a deadline past 250 s.
 *
 * **Neither**, nothing is written and Bun keeps its own default: a runner
 * called directly, without the policy `HttpExtension.bind` resolves, behaves
 * exactly as it did before either member existed.
 */
export function bunIdleTimeoutOf(options: Pick<HonoServeOptions, 'idleTimeoutMs' | 'requestDeadlineMs'>): BunIdleTimeout {
  const { idleTimeoutMs, requestDeadlineMs } = options;
  if (idleTimeoutMs !== undefined) {
    const seconds = idleTimeoutMs === 0 ? 0 : Math.ceil(idleTimeoutMs / 1_000);
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0 || seconds > BUN_MAX_IDLE_TIMEOUT_SECONDS) {
      throw new RangeError(
        `idleTimeoutMs = ${idleTimeoutMs} cannot be held by Bun.serve, whose idleTimeout is whole seconds from 0 to `
          + `${BUN_MAX_IDLE_TIMEOUT_SECONDS} — at most ${BUN_MAX_IDLE_TIMEOUT_SECONDS * 1_000} ms.`,
      );
    }
    return { seconds };
  }
  if (requestDeadlineMs === undefined) return {};
  if (!Number.isFinite(requestDeadlineMs) || requestDeadlineMs < 0) {
    throw new RangeError(`requestDeadlineMs = ${requestDeadlineMs} is no deadline to derive an idle timeout from.`);
  }
  const sweepMs = BUN_IDLE_SWEEP_SECONDS * 1_000;
  const neededMs = requestDeadlineMs + IDLE_CUT_MARGIN_SECONDS * 1_000;
  const derived = BUN_IDLE_SWEEP_SECONDS * (Math.ceil(neededMs / sweepMs) + 1);
  const seconds = Math.min(derived, BUN_MAX_IDLE_TIMEOUT_SECONDS);
  const earliestCutMs = sweepMs * (Math.ceil(seconds / BUN_IDLE_SWEEP_SECONDS) - 1);
  return earliestCutMs >= neededMs ? { seconds } : { seconds, heldAtCeilingMs: seconds * 1_000 };
}

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

/** The `Bun.serve` members only the typed `tls`, `http2` and idle members may set — never a `serveOptions` bag. */
type BunListenerShape = {
  readonly tls?: unknown;
  readonly http2?: unknown;
  readonly idleTimeout?: unknown;
};

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
    /** Whole seconds, `0` for never, at most {@link BUN_MAX_IDLE_TIMEOUT_SECONDS}; Bun's own default is 10. */
    idleTimeout?: number;
  }): BunServer;
}
