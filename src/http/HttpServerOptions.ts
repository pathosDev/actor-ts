/**
 * All server-level option-relevant types live here:
 *
 *   - {@link HttpServerOptionsType} — the plain options-object shape.
 *   - {@link HttpServerOptionsBuilder} — the fluent builder
 *     (`HttpServerOptions.create()…`).
 *   - {@link HttpServerOptions} — the accepted-input **union**, plus a value
 *     alias to the builder.
 *   - {@link HttpServerOptionsValidator} — the consume-time domain check, run
 *     once by `HttpExtension.bind` on the merged settings.
 *
 *     const serverOptions = HttpServerOptions.create()
 *       .withIdleTimeoutMs(5_000)
 *       .withMaxConnections(1_000);
 *     await system.http(8080, { host: '127.0.0.1' })
 *       .withServerOptions(serverOptions)
 *       .bind(routes);
 *
 * These are bounds on the **connection**, not on a route: they belong to the
 * one listening socket a `bind()` opens, so they are resolved once at `bind()`
 * and handed to the backend at `listen()` rather than consulted per request.
 * Precedence is the project's usual `withServerOptions(...)` > HOCON
 * (`actor-ts.http.server`) > built-in default, per field.
 *
 * **Four of the bounds ship no built-in default at all**, and that is the
 * point of them: `idleTimeoutMs`, `maxConnections`, `maxContentLength` and
 * `maxHeaderBytes` unset means *leave the backend alone*, which is not the
 * same as any number this file could name — see the constants below for why
 * there are only two.  The one exception is `idleTimeoutMs` on the Hono
 * backend under Bun, where leaving the runtime alone cut slow handlers with no
 * response, so the backend derives a value from the request deadline instead
 * (#1487).
 */
import { holdsCertificate, type TlsTransportOptionsType } from '../runtime/tcp/TcpBackend.js';
import { MAX_TIMER_DELAY_MS } from '../util/Constants.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/**
 * Whether the listening socket negotiates HTTP/2 — `false`.
 *
 * Off because it is meaningless without {@link HttpServerOptionsType.tls}
 * and the validator refuses the pair: this framework does not do h2c.
 * With TLS on, `true` offers `h2` through ALPN and keeps HTTP/1.1 on the
 * same port for a client that does not — measured on Bun 1.4.2 (`Bun.serve`
 * `http2: true`) and Node 26.7 (`http2.createSecureServer` +
 * `allowHTTP1`), a `node:http2` client negotiates `h2` and an `https`
 * client still gets `1.1`.  Deno negotiates h2 whenever TLS is on and has
 * no knob for it, so there the flag records intent rather than deciding.
 */
export const DEFAULT_HTTP_SERVER_HTTP2 = false;

/**
 * Time to receive a request's complete header block — 60 s.
 *
 * The slow-loris control, and the reason this block exists at all: a peer that
 * opens a socket and dribbles header bytes forever occupies a connection with
 * no request to time out, so neither a route-level `requestTimeout()`
 * middleware nor `requestTimeoutMs` ever sees it.  When it elapses the
 * connection is answered `408 Request Timeout` and destroyed.
 *
 * 60 s matches `http.createServer`'s own `headersTimeout`, and Fastify does not
 * override it, so publishing the number changes no bound that was already
 * being held.  What it buys is that the number is *movable* without a code
 * change, and written down where an operator can find it.
 *
 * **What holds the deadline is this framework, not the property.**  Writing
 * `server.headersTimeout` is enough only on Node.  Measured on a bare
 * `node:http` server against a socket that never sends its terminating blank
 * line: node v26.7.0 answers `408` and closes, but **bun 1.4.0 stores the
 * number, reports it back unchanged and enforces nothing** — `2000`, `40000`,
 * `120000` and `0` all closed at ~12 s with no bytes received, which is Bun's
 * own idle timeout rather than this guard — and **deno 2.6.8 ignores it and
 * never closes at all**.  So `applyServerOptions` arms the deadline itself on
 * every server that reports its accepted connections; see
 * `enforceHeaderTimeout` for the seam and for the one runtime that offers
 * none (#870).
 */
export const DEFAULT_HTTP_SERVER_HEADER_TIMEOUT_MS = 60_000;

/**
 * Time to receive a request in full — headers *and* body — 300 s.
 *
 * Bounds *receiving*, never answering, so it does not cut off a slow handler,
 * a long poll or an SSE stream: the clock stops once the request has arrived.
 * What it does bound is an upload, which is the half that can be held open by
 * a peer rather than by this process.
 *
 * 300 s is `http.createServer`'s own default, and it is the value that makes
 * the three backends **agree** rather than the value that changes the fewest
 * of them.  They do not agree today: measured on bun 1.4.0 and node v26.7.0,
 * `server.requestTimeout` reads 300000 on a bare `node:http` server and on
 * Express, and **0 — no bound at all — on Fastify**, which is the default
 * backend.  So an actor-ts server on Fastify would wait forever for a body
 * that never finishes arriving while the same application on Express gave up
 * after five minutes.  Publishing the number is the same decision #357 made
 * for `bodyLimit`: the cap is the framework's, not whichever backend happens
 * to be mounted.
 *
 * At the shipped 1 MiB body cap, 300 s is a client sending under 3.5 KB/s.
 * A deployment that legitimately accepts slower uploads raises this, or sets
 * `0` to opt out entirely.
 */
export const DEFAULT_HTTP_SERVER_REQUEST_TIMEOUT_MS = 300_000;

/**
 * The largest `idleTimeoutMs` a runtime can arm — one second under
 * {@link MAX_TIMER_DELAY_MS}, the most a timer holds.
 *
 * Both runtimes add a second to `keepAliveTimeout` before arming the socket's
 * idle timer, so it is the sum that has to fit, not the setting.  Measured on
 * bun 1.4.2 against a bare `node:http` server: `keepAliveTimeout =
 * 2_147_483_647` — the timer ceiling itself — closed a keep-alive connection
 * 14 ms after its response, Bun's own `TimeoutOverflowWarning` reporting the
 * padded delay "set to 1"; `2_147_482_647` held.  Node truncates the same
 * overflow to the ceiling and only warns, which survives but is not what was
 * configured either.
 */
const MAX_HTTP_SERVER_IDLE_TIMEOUT_MS = MAX_TIMER_DELAY_MS - 1_000;

/**
 * The largest `requestTimeoutMs` a runtime reads as written — 2^32 - 1.
 *
 * No timer holds this one: Node's connection sweep reads it as a 32-bit
 * unsigned number and wraps anything larger.  Measured on node v26.10.0 with a
 * 500 ms sweep: `requestTimeout = 4_294_967_295` left a stalled body open,
 * `4_294_969_296` — 2^32 + 2 000 — closed it at 2.0 s, and `5_184_000_000`
 * (HOCON's `60d`) behaved as about ten days.  Bun 1.4.2 does not wrap.
 */
const MAX_HTTP_SERVER_REQUEST_TIMEOUT_MS = 4_294_967_295;

/**
 * Connection-level bounds for one bound server.
 *
 * Every field is optional and `undefined` means **not set**, which has to
 * survive the merge: for the two fields that ship no default it is the only
 * way to say "keep whatever the backend chose", and there is no number that
 * spells that.
 */
export type HttpServerOptionsType = {
  /**
   * How long an idle connection is held before it is closed: a keep-alive
   * HTTP/1.1 connection between requests (`server.keepAliveTimeout`), and an
   * HTTP/2 session with nothing moving on it (the session's own timer, which
   * no HTTP/2 session reads `keepAliveTimeout` for).  An HTTP/2 session is
   * closed gracefully, so a stream still in flight finishes.
   *
   * **No built-in default** — unset leaves the backend's own, and the backends
   * deliberately disagree: 72 s on Fastify, for an HTTP/2 session too, and 5 s
   * on Express and on Hono-over-Node (measured).  On Hono-over-Node an HTTP/2
   * session is then not bounded at all; Express serves no HTTP/2, so there the
   * question does not arise.  Fastify's is high on purpose, so the server
   * outlives a load balancer's idle window and the balancer never posts a
   * request onto a socket the server is closing; five seconds is
   * `node:http`'s own.  Neither is wrong, so this ships no value rather than
   * picking a winner.  `0` disables the timeout, on both protocols.
   *
   * Bun fires an HTTP/2 session's timer at **twice** the value — measured on
   * bun 1.4.2, 1.6 s for 800 ms, where node v26.10.0 took 0.8 s.
   *
   * **On the Hono backend under Bun it is `Bun.serve`'s `idleTimeout`**, which
   * is a wider bound: whole-connection inactivity, so a handler that writes
   * nothing for that long, a long poll and a sparse SSE stream are cut too, and
   * an idle HTTP/2 session with them.  It counts whole seconds — the value is
   * rounded up, so 1–999 ms is 1 s and never the `0` that disables it — and is
   * checked on a 4 s sweep, so a connection can go up to one sweep early.  Above
   * 255 s `bind()` refuses it: `Bun.serve` holds no more.  Unset, the backend
   * does not keep Bun's own 10 s, which cut any handler slower than about 12 s
   * with no response: it derives the timeout from the server's longest request
   * deadline, so a `requestTimeout()` 503 is written first — 36 s for the
   * built-in 30 s deadline, and at most 255 s, which covers a deadline up to
   * 250 s and is warned about past that (#1487).  Hono under Deno has no such
   * knob, and holds none of it.
   */
  readonly idleTimeoutMs?: number;
  /**
   * How long a connection may take to deliver its complete header block
   * before it is answered `408` and destroyed.  Default 60 s.  Timed from the
   * accepted connection to the first completed header block — the shape of a
   * slow-loris — and held by this framework rather than by
   * `server.headersTimeout`, which two of the three supported runtimes accept
   * and ignore (#870).
   *
   * `0` disables the guard — which reopens the slow-loris hole this key exists
   * to close, so it is a deliberate act.  It clears the property too, and a
   * runtime may still apply an idle close of its own: on bun 1.4.0 a
   * connection with no complete request is dropped after about 12 s whatever
   * this says.
   *
   * A shorter {@link requestTimeoutMs} is the header deadline too, guard and
   * property alike: the headers are part of the request.
   */
  readonly headerTimeoutMs?: number;
  /**
   * How long a connection may take to deliver a request in full, headers and
   * body (`server.requestTimeout`).  Default 300 s.  Bounds *receiving* only,
   * so a slow handler, a long poll and an SSE stream are unaffected.  `0`
   * disables it.
   *
   * Below {@link headerTimeoutMs} it bounds the header phase as well — the
   * header guard is armed with it and `server.headersTimeout` is written as
   * it — rather than being quietly raised to the header deadline, which is
   * what Node does with the pair written as configured.
   */
  readonly requestTimeoutMs?: number;
  /**
   * Concurrent connections the listening socket accepts before it starts
   * closing new ones (`net.Server.maxConnections`).  **No built-in default** —
   * unset is unlimited, which is what every release before this key did, and
   * `Infinity` is the code-side spelling of the same thing.
   *
   * Server-wide, so it counts every connection the process accepts on this
   * binding — including the WebSocket upgrades that
   * `actor-ts.http.websocket.max-connections` caps per route, and including
   * DevTools when it is attached to the same server.
   */
  readonly maxConnections?: number;
  /**
   * The largest request body the server accepts, in bytes.  A body that
   * declares more is refused before a byte of it is read, and a chunked one
   * is abandoned once it crosses the cap — `413` either way, before the
   * handler runs.
   *
   * **No built-in default** — unset keeps each backend's own cap, which is
   * the shared `DEFAULT_HTTP_MAX_BODY_BYTES` (1 MiB) unless the backend was
   * built with another: `withMaxBodyBytes` on Express and Hono, `bodyLimit`
   * on a Fastify built by hand.  Set, it is the cap on every backend, and a
   * backend built with a *different* cap of its own is refused at `bind()`
   * rather than left to decide which of two numbers holds; an equal one
   * binds.  Fastify takes its cap at construction, so the framework-built
   * instance is built with this one and a hand-built instance adopts it
   * through `fastifyFactoryOptions(serverOptions)` (#1488).
   */
  readonly maxContentLength?: number;
  /**
   * The largest request header block the server accepts, in bytes
   * (`node:http`'s `maxHeaderSize`).  A request past it never reaches a
   * handler: the runtime answers `431`, though a client still writing when
   * the server gives up may see the connection reset instead.
   *
   * **No built-in default** — unset keeps the runtime's own: 16 KiB on
   * `node:http` and on `Bun.serve` (Bun's process-wide
   * `--max-http-header-size`), measured on node v26.10.0 and bun 1.4.2.
   *
   * A *construction* option, so it reaches a server only where actor-ts
   * builds one: Fastify (its factory options — a hand-built instance adopts
   * it through `fastifyFactoryOptions(serverOptions)` and is refused at
   * `bind()` without it), Express (the server the backend builds), and Hono on
   * Node (`@hono/node-server`'s `serverOptions`).  `Bun.serve` and
   * `Deno.serve` have no per-server option, so on the Hono backend under Bun
   * or Deno it is reported not in effect and `bind()` warns.  On an HTTP/2
   * listener it caps the HTTP/1.1 requests sharing the port, but on Node not an
   * HTTP/2 stream's header list: measured on node v26.10.0, a 4 KiB header
   * reached the handler over h2 through a 1 KiB cap (Bun refuses the stream).
   */
  readonly maxHeaderBytes?: number;
  /**
   * Terminate TLS on the listening socket itself.  Unset — the default —
   * serves plain HTTP, which is every release before #1522 and remains the
   * right answer behind a reverse proxy or an ingress that terminates for
   * you.  Set, the process is the TLS endpoint: `Bun.serve({ tls })`,
   * `https.createServer` / `http2.createSecureServer` under
   * `@hono/node-server`, `Deno.serve({ cert, key })`, Fastify's `{ https }`
   * factory option, and the `https.createServer` the Express backend builds
   * for itself.  `requestClientCert` needs a `ca` to verify against, and
   * `bind()` refuses it without one: `node:tls` would otherwise verify client
   * certificates against the runtime's default trust store, which admits any
   * certificate a public CA issued.  On Deno the demand is refused on every
   * backend, because neither `Deno.serve` (Hono) nor Deno's `node:https`
   * (Fastify, Express) enforces it.  A `ca` that holds no certificate — an
   * empty `ca-file`, a blank secret, `null` — would reach the default store
   * as well, so it is refused whatever `requestClientCert` says.
   *
   * The vocabulary is the raw TCP transport's ({@link HttpTlsOptionsType}):
   * PEM contents or DER bytes, never a file path — the HOCON leaves
   * `tls.cert-file` / `tls.key-file` / `tls.ca-file` are the paths, read
   * once when the block is.
   */
  readonly tls?: HttpTlsOptionsType;
  /**
   * Negotiate HTTP/2 over the TLS socket, keeping HTTP/1.1 available on the
   * same port.  Default {@link DEFAULT_HTTP_SERVER_HTTP2}.  Refused without
   * {@link tls}: h2c is not on the table.
   *
   * Refused on the Express backend too, which serves TLS but not HTTP/2:
   * Express reassigns each request and response onto `node:http`'s
   * prototypes, and `node:http2`'s compatibility objects do not survive that.
   * Measured with express 5.2.1, an h2 request was negotiated and never
   * answered on node v26.10.0 and bun 1.4.2, and deno 2.6.8 does not
   * implement `http2.createSecureServer`.
   */
  readonly http2?: boolean;
};

/**
 * What {@link HttpServerOptionsType.tls} carries — the server-side subset of
 * the TCP transport's TLS options, so the two halves of the process speak
 * one vocabulary.  `serverName` is the one field left out: it is the SNI a
 * *client* sends, and a listening socket has no use for it.
 *
 * `cert` and `key` are both required once the object exists; the validator
 * says so, because the type cannot without making `withTls({ cert })` a
 * compile error that reads worse than the runtime one.
 *
 * `requestClientCert` does not default from `ca` here, unlike on the TCP
 * transport whose field this is: unset, no client certificate is requested.
 * Set, it needs `ca` — the validator refuses the demand without an anchor, and
 * a `ca` that holds no certificate whatever the demand says, for the reasons
 * {@link HttpServerOptionsValidator} gives.
 */
export type HttpTlsOptionsType = Pick<
  TlsTransportOptionsType,
  'cert' | 'key' | 'ca' | 'requestClientCert' | 'rejectUnauthorized'
>;

/** Fluent builder for {@link HttpServerOptionsType}. */
export class HttpServerOptionsBuilder extends OptionsBuilder<HttpServerOptionsType> {
  /** Start a fresh builder.  Equivalent to `new HttpServerOptionsBuilder()`. */
  static create(): HttpServerOptionsBuilder {
    return new HttpServerOptionsBuilder();
  }

  /**
   * Idle window before a keep-alive connection or an HTTP/2 session is closed.
   * Unset leaves the backend's own.  On Hono under Bun it is whole-connection
   * inactivity in whole seconds, at most 255 s, and unset is derived from the
   * request deadline — see {@link HttpServerOptionsType.idleTimeoutMs}.
   */
  withIdleTimeoutMs(ms: number): this {
    return this.set('idleTimeoutMs', ms);
  }

  /** Time to receive the complete headers before a `408`.  Default 60 s. */
  withHeaderTimeoutMs(ms: number): this {
    return this.set('headerTimeoutMs', ms);
  }

  /** Time to receive the entire request, headers and body.  Default 300 s. */
  withRequestTimeoutMs(ms: number): this {
    return this.set('requestTimeoutMs', ms);
  }

  /** Concurrent connections accepted before new ones are closed.  Unset is unlimited. */
  withMaxConnections(connections: number): this {
    return this.set('maxConnections', connections);
  }

  /** The largest request body accepted, in bytes; a larger one is answered `413`.  Unset keeps each backend's own cap. */
  withMaxContentLength(bytes: number): this {
    return this.set('maxContentLength', bytes);
  }

  /** The largest request header block accepted, in bytes.  Unset keeps the runtime's own (16 KiB on `node:http`). */
  withMaxHeaderBytes(bytes: number): this {
    return this.set('maxHeaderBytes', bytes);
  }

  /** Terminate TLS on the listening socket — PEM or DER, never a path.  Unset serves plain HTTP. */
  withTls(tls: HttpTlsOptionsType): this {
    return this.set('tls', tls);
  }

  /** Negotiate HTTP/2 over TLS, HTTP/1.1 staying available on the same port.  Refused without `withTls`, and on the Express backend. */
  withHttp2(enabled = true): this {
    return this.set('http2', enabled);
  }
}

/**
 * Validates resolved {@link HttpServerOptionsType} settings, once, on the
 * merged result — so a builder, a plain object and a HOCON leaf are all
 * covered by the same rules.
 *
 * The three timeouts are **non-negative rather than positive**, unlike the
 * client's `defaultTimeoutMs`.  The asymmetry is deliberate and is the
 * runtime's, not a relaxation: `0` is `node:http`'s own spelling for "no
 * bound" on all three properties — and it is what `headerTimeoutMs` reads as
 * "arm no deadline", the one of the three this framework enforces itself — so
 * refusing it would leave an operator who
 * wants Fastify's historical unbounded `requestTimeout` back with no way to
 * ask for it.  What the rule still catches is the failure that has no
 * spelling: `NaN` and a negative both arm a guard that never fires, which
 * reads as "configured" and behaves as "off".
 *
 * All three are bounded from above as well, and for the mirror-image reason:
 * past what the runtime can represent where the value ends up, a deadline
 * meant as "effectively never" comes out short — see {@link ceiling}.
 */
export class HttpServerOptionsValidator extends OptionsValidator<HttpServerOptionsType> {
  constructor() {
    super('HttpServerOptions');
  }

  protected rules(s: Partial<HttpServerOptionsType>): void {
    this.nonNegativeNumber('idleTimeoutMs');
    this.nonNegativeNumber('headerTimeoutMs');
    this.nonNegativeNumber('requestTimeoutMs');
    const timerOverflow = 'a timer cannot hold a longer delay, and a runtime arms it as 1 ms instead';
    this.ceiling('idleTimeoutMs', s.idleTimeoutMs, MAX_HTTP_SERVER_IDLE_TIMEOUT_MS, timerOverflow);
    this.ceiling('headerTimeoutMs', s.headerTimeoutMs, MAX_TIMER_DELAY_MS, timerOverflow);
    this.ceiling(
      'requestTimeoutMs',
      s.requestTimeoutMs,
      MAX_HTTP_SERVER_REQUEST_TIMEOUT_MS,
      'Node\'s connection sweep reads it as a 32-bit number and wraps anything larger into a shorter deadline',
    );
    this.positiveIntOrUnbounded('maxConnections', s.maxConnections);
    // `0` is no spelling of "unbounded" for the two size caps: unset is how a
    // backend's own cap is kept, and a cap of nothing would refuse every body
    // or every request.  No ceiling either — neither runtime wraps a large
    // header cap the way Node's sweep wraps request-timeout: measured on node
    // v26.10.0 and bun 1.4.2, 2^32 + 1024 and 2^53 - 1 were read back verbatim
    // and let a 40 KB header block through, and a body cap is only ever
    // compared against.
    this.positiveInt('maxContentLength');
    this.positiveInt('maxHeaderBytes');
    this.tlsRules(s);
  }

  /**
   * Refuse a deadline larger than the runtime can represent where it ends up.
   *
   * Two of the three end up in a timer, and `setTimeout` arms anything above
   * 2^31 - 1 ms as 1 ms: an over-long `header-timeout` turned the slow-loris
   * guard into a switch that destroyed every fresh connection a millisecond
   * after accept, and an over-long `idle-timeout` closed every keep-alive
   * connection on Bun right after its response.  `request-timeout` ends up in
   * Node's connection sweep instead, which wraps it at 2^32 into a shorter
   * deadline — the same failure by another route.  HOCON reaches all three
   * ranges in one line (`30d` is 2 592 000 000 ms), so each is refused where the
   * value arrives rather than discovered as a server that cuts too early.
   *
   * Runs after `nonNegativeNumber`, so the value is finite by the time it gets
   * here.
   */
  private ceiling(
    field: 'idleTimeoutMs' | 'headerTimeoutMs' | 'requestTimeoutMs',
    value: number | undefined,
    ceilingMs: number,
    why: string,
  ): void {
    if (value === undefined || value <= ceilingMs) return;
    this.fail(field, `must be at most ${ceilingMs} ms — ${why}`, value);
  }

  /**
   * The incoherent shapes, refused at `bind()` rather than discovered at the
   * first handshake — or never.  A certificate without its key (or the
   * reverse) cannot open a listener anywhere; `http2` without `tls` would be
   * h2c on Bun, which accepts it, and an error on Node, which does not — and
   * this framework offers neither.
   *
   * `requestClientCert` without `ca` is the shape that would bind, which is
   * why it is refused here: it reads as mutual authentication but names no
   * trust anchor, and `node:tls` then verifies client certificates against the
   * runtime's default trust store.  Measured on node v26.10.0 and bun 1.4.2, a
   * server with `requestCert` and no `ca` admitted a client certificate signed
   * by a CA added to that store, and refused it once an unrelated `ca` was
   * named — so against the public roots a runtime ships, any client
   * certificate a public CA issued gets in.  A listener that is quietly less
   * secure than its configuration suggests behaves exactly like a correct one
   * until it is attacked, which is why the raw TCP transport fails closed on
   * the same shape (`assertListenerTlsIsCoherent`); this is its HTTP twin, and
   * it holds on every backend because it runs before one is built.
   *
   * A `ca` that is present and holds no certificate reaches the same store by
   * another route, so it is refused too, whatever `requestClientCert` says.
   * `node:tls` tests `ca` for truthiness and loads the default store when it
   * is falsy: measured on node v26.10.0, `ca: ''` — which is what an empty
   * `ca-file` reads as — and `ca: null` bound behind a demand on Express,
   * Fastify and Hono and admitted a client certificate signed by a CA in that
   * store, and on bun 1.4.2 `null` and `[]` did the same.  A blank string or an
   * empty byte array failed closed or did not bind, depending on runtime and
   * shape.  None of them is a way to ask for one-way TLS — leaving `ca` unset
   * is — so each is a broken configuration and is refused as one, naming the
   * field.  What counts as holding a certificate is `holdsCertificate`.
   *
   * The `tls` rules deliberately pass no value: `OptionsError` carries it as
   * a property and the message is logged at ERROR, and the object holds the
   * private key.  The reasons name the missing half, which is all a
   * diagnostic needs (the same line #590 drew for a URL's password).
   */
  private tlsRules(s: Partial<HttpServerOptionsType>): void {
    if (s.tls !== undefined) {
      if (!s.tls.cert && !s.tls.key) {
        this.fail('tls', 'needs cert and key — PEM contents or DER bytes, not file paths');
      } else if (!s.tls.cert) {
        this.fail('tls', 'has a key but no cert');
      } else if (!s.tls.key) {
        this.fail('tls', 'has a cert but no key');
      }
      if (s.tls.ca !== undefined && !holdsCertificate(s.tls.ca)) {
        this.fail(
          'tls.ca',
          'holds no certificate (an empty or blank string, an empty byte array or array, or null), and node:tls '
          + 'reads such a ca as none at all — client certificates would be verified against the runtime\'s default '
          + 'trust store rather than the CA you meant.  Check the secret or the ca-file it was read from: supply the '
          + 'CA bundle that signs your clients\' certificates, or leave ca unset for one-way TLS.',
        );
      }
      if (s.tls.requestClientCert === true && s.tls.ca === undefined) {
        this.fail(
          'tls.requestClientCert',
          'is true but no `ca` was supplied, so client certificates would be verified against the runtime\'s '
          + 'default trust store and any certificate a public CA issued would be admitted.  Provide the CA '
          + 'bundle that signs your clients\' certificates, or set requestClientCert: false for one-way TLS.',
        );
      }
    }
    if (s.http2 === true && s.tls === undefined) {
      this.fail('http2', 'needs tls — HTTP/2 is negotiated through ALPN on a TLS socket, and h2c is not offered', s.http2);
    }
  }

  /**
   * `positiveInt`, widened to admit `Infinity`.
   *
   * The same helper `WebsocketPolicyOptionsValidator` carries, for the same
   * reason and on the same-named field: `Infinity` is how code spells the
   * unlimited default, and the base helpers read the snapshot themselves and
   * reject it on the way.  A no-op on `undefined`, like every other helper.
   */
  private positiveIntOrUnbounded(field: string, value: number | undefined): void {
    if (value === undefined || value === Infinity) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      this.fail(field, 'must be a positive integer or Infinity', value);
    }
  }
}

/**
 * Accepted input for `newServerAt(...).withServerOptions(...)`: the fluent
 * {@link HttpServerOptionsBuilder} OR a plain {@link HttpServerOptionsType}
 * object.
 */
export type HttpServerOptions = HttpServerOptionsBuilder | Partial<HttpServerOptionsType>;
/** Value alias so `HttpServerOptions.create()` / `new HttpServerOptions()` resolve to the builder. */
export const HttpServerOptions = HttpServerOptionsBuilder;
