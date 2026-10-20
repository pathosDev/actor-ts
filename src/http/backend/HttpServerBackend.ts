import { ConfigKeys } from '../../config/ConfigKeys.js';
import { detectRuntime } from '../../runtime/Detect.js';
import { DEFAULT_HTTP_MAX_BODY_BYTES, DEFAULT_WEBSOCKET_MAX_FRAME_BYTES } from '../Constants.js';
import type { HttpServerOptionsType } from '../HttpServerOptions.js';
import type { HttpMethod, HttpRequest, HttpResponse } from '../Types.js';
import type { PreAttachBufferLimits, WebsocketSocketAdapter } from '../websocket/SocketAdapter.js';

/** One route registration — supplied by the DSL after compilation. */
export type RouteRegistration = {
  readonly method: HttpMethod;
  /** Path pattern in the Fastify/Express style: `/users/:id` */
  readonly pattern: string;
  readonly handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse;
};

/**
 * One WebSocket route registration.  The backend accepts the HTTP
 * upgrade at `pattern` (a GET), MUST call `authorize` first (a non-null
 * result means: send that plain HTTP response and DO NOT upgrade), and
 * then call `onConnection` exactly once — **synchronously** inside its
 * native open/upgrade callback — handing over a normalised socket.
 * Everything actor-related lives behind `onConnection`; the backend
 * never sees the framework's actors.
 */
export type WebsocketRouteRegistration = {
  /** ':param'-style pattern, same dialect as {@link RouteRegistration.pattern}. */
  readonly pattern: string;
  /**
   * The route's resolved inbound frame cap — route options > HOCON >
   * built-in default, decided before `listen`.
   *
   * A backend that can hand its runtime a payload limit must derive that
   * limit from these rather than from the built-in default, or the number an
   * application configured governs only what the connection actor accepts and
   * not what the process buffers first (#373).  See
   * {@link transportFrameCapOf} for how a single shared transport reconciles
   * several routes.
   */
  readonly maxFrameBytes: number;
  /**
   * The route's resolved bound on the buffer that holds inbound events between
   * the upgrade completing and the connection actor attaching its listeners.
   *
   * It travels with the registration rather than reaching the buffer through
   * `onConnection` because the backend builds the adapter — and therefore the
   * buffer — *before* it calls `onConnection`, which is the whole point: the
   * buffer exists to catch what arrives in that window.  A backend that hands
   * this to `websocketPackageAdapter` (or to `bufferWebsocketEvents` directly)
   * makes the route's number the one that governs; one that forgets falls back
   * to the built-in bound, never to none (#717).
   */
  readonly preAttachBuffer: PreAttachBufferLimits;
  /** Pre-upgrade guard.  `null` → proceed; `HttpResponse` → reject with it. */
  readonly authorize: (request: HttpRequest) => Promise<HttpResponse | null>;
  /** Called once per accepted connection, synchronously in the upgrade callback. */
  readonly onConnection: (request: HttpRequest, socket: WebsocketSocketAdapter) => void;
};

export interface ServerBinding {
  readonly host: string;
  readonly port: number;
  /**
   * Which fields of the resolved `actor-ts.http.server` policy the backend put
   * into effect on this server — see {@link ServerOptionsReport}.
   *
   * Optional, and absent means *the backend did not say*, never *nothing took*:
   * a backend written outside this repository satisfies the interface without
   * it, and `HttpExtension.bind` warns about an inert bound only on a backend
   * that reported one.  Every shipped backend reports.
   */
  readonly serverOptionsReport?: ServerOptionsReport;
  /** Stop the server; waits up to `gracePeriodMs` for in-flight requests. */
  unbind(gracePeriodMs?: number): Promise<void>;
}

/**
 * Headers every shipped backend writes **before** a response's own, so an
 * explicit header from a handler still wins.
 *
 * `nosniff` and nothing else.  It is the one header of the helmet-style
 * bundle that cannot change how an existing application is embedded, framed
 * or referred to, so shipping it on by default breaks nobody while closing
 * the MIME-sniffing hole in every response the framework writes (#127).
 * `X-Frame-Options`, `Cross-Origin-Resource-Policy` and friends *would*
 * break iframes, cross-origin embedding and OAuth popups, so they stay
 * opt-in — `newServerAt(…).withSecurityHeaders(…)` for the whole server, or
 * the `securityHeaders()` middleware for a route subtree.
 *
 * This lives on the backend rather than in a middleware because a
 * middleware only decorates responses that flow back through it: the
 * backend's own 404, its body-parse 413 and every error short-circuit never
 * do.  The backend is the single point every response passes.
 */
export const DEFAULT_RESPONSE_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-content-type-options': 'nosniff',
});

/**
 * The answer every shipped backend writes once a request body exceeds the
 * cap — declared once so all three agree on status, body *and* content type.
 *
 * A client that posts too much has to be able to recognise the refusal
 * without knowing which backend served it, and before #357 it could not:
 * Express and Hono wrote this `text/plain` line while Fastify let its own
 * `FST_ERR_CTP_BODY_TOO_LARGE` JSON envelope through untouched — or, once
 * `withErrorHandler` was installed, reported the rejection as a 500.
 *
 * Passed through each backend's `writeResponse`, so the server-wide default
 * headers land on it like on any other response.
 */
export const PAYLOAD_TOO_LARGE_RESPONSE: HttpResponse = Object.freeze({
  status: 413,
  body: 'Payload Too Large',
  contentType: 'text/plain; charset=utf-8',
});

/**
 * What {@link enforceHeaderTimeout} writes to a socket that never finished its
 * header block, before hanging up.
 *
 * Raw wire bytes rather than an {@link HttpResponse}, and it has to be: there
 * is no request to answer.  The backend's `writeResponse` needs a parsed
 * request to reply to, and the whole point of this deadline is the connection
 * on which one never arrived — so the status line is assembled here, byte for
 * byte as `node:http` writes its own.  Matching it exactly is what keeps a
 * client unable to tell which half of the stack timed it out.
 */
const HEADER_TIMEOUT_RAW_RESPONSE = 'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n';

/**
 * True when a declared `Content-Length` exceeds `cap`.
 *
 * Shared by the backends that read a body themselves (Express, Hono) so both
 * refuse an over-long request before a byte of it is read — Fastify applies
 * the same rule inside its own body parser.  A missing or non-numeric header
 * returns `false`: a chunked body declares no length, so it can only be
 * measured while it arrives.  This is the fast path, never the whole cap —
 * each backend also counts the bytes it receives and abandons the read at the
 * cap, which is what bounds a request that announced nothing (#357).
 */
export function contentLengthExceeds(header: string | undefined, cap: number): boolean {
  if (header === undefined) return false;
  const declaredLength = Number(header);
  return Number.isFinite(declaredLength) && declaredLength > cap;
}

/**
 * The body cap a backend that reads its own bodies — Express, Hono — holds on
 * the server it is about to bind: the server's `max-content-length` where one
 * is set, the backend's own otherwise (`withMaxBodyBytes`, else the shared
 * {@link DEFAULT_HTTP_MAX_BODY_BYTES}).
 *
 * Resolved at `listen()` rather than at construction, because the server
 * options are not known before then — which is why both backends keep what
 * `withMaxBodyBytes` said as `number | undefined` instead of collapsing it to
 * the default in the constructor: collapsed, an untouched backend and one
 * built with exactly 1 MiB look the same, and only the first may yield.
 *
 * A set key and a `withMaxBodyBytes` that **differ** are refused rather than
 * ranked.  Either ranking leaves one of two configured numbers silently not
 * held, and which one would be an accident of precedence nobody chose; the
 * same reasoning refuses a hand-built Fastify whose `bodyLimit` differs, in
 * `FastifyBackend.listen`.  Equal numbers say one thing twice and bind (#1488).
 */
export function bodyCapOf(backendName: string, maxBodyBytes: number | undefined, maxContentLength: number | undefined): number {
  if (maxContentLength === undefined) return maxBodyBytes ?? DEFAULT_HTTP_MAX_BODY_BYTES;
  if (maxBodyBytes !== undefined && maxBodyBytes !== maxContentLength) {
    throw new Error(
      `${backendName}: the server's max-content-length is ${maxContentLength} bytes `
      + `(${ConfigKeys.http.server.maxContentLength}, or withMaxContentLength in code), but this backend was built `
      + `withMaxBodyBytes(${maxBodyBytes}).  One server holds one body cap: drop withMaxBodyBytes and let the `
      + 'server option decide, or give both the same number.',
    );
  }
  return maxContentLength;
}

/**
 * The payload limit to install on the one transport a server's WebSocket
 * routes share — the largest frame any of them admits.
 *
 * **Server-level, and by decision** (#373).  That issue's title asks for a
 * *per-route* transport cap; its body sanctions "(or a server-level
 * configurable cap)" as an alternative, and the alternative is what shipped.
 * The per-route half was considered and declined, so read the `max` below as
 * the contract rather than as an unfinished half of one.
 *
 * The reason is that two of the three shipped backends cannot follow.
 * `@fastify/websocket` is registered once per instance, and Bun's
 * `maxPayloadLength` belongs to the entire `Bun.serve` — in both, one number
 * per server is imposed from outside.  Express is the exception: one `noServer`
 * `WebSocketServer` is this backend's own structure rather than something `ws`
 * dictates, and `completeUpgrade` already holds the matched registration when
 * it calls `handleUpgrade`, so a server per route is structurally available
 * there.  Building it would satisfy the title on one backend of three and
 * leave the other two silently different — a per-route promise that holds
 * wherever the reader does not check is worse than a server-level one that
 * holds everywhere, because the failure mode is a security expectation, and a
 * security expectation that is true on your laptop's backend and false in
 * production is not a weaker guarantee but a wrong one.  So: one number per
 * server, the same shape on all three.
 *
 * Given one number, the only safe direction is the widest: taking the smallest
 * would cut a route off below its own configured cap, which is a silent wrong
 * answer, while the widest merely leaves a stricter route's surplus frames to
 * the connection actor — which refuses them with a clean 1009 exactly as it
 * did before this existed.  The cost is real and worth naming: a 64 KiB route
 * sharing a server with an 8 MiB one gets an 8 MiB buffering window, which is
 * the allocation amplification the cap exists to prevent for that route.
 *
 * What this buys is the part that was missing: the number is now the
 * application's, so *lowering* `maxFrameBytes` (per route or in HOCON) really
 * does narrow the buffering window, and raising it above 1 MiB is no longer
 * silently undone by the transport.
 *
 * **One pair does not honour it.**  On Bun the `ws` specifier resolves to
 * Bun's built-in shim, which stores `maxPayload`, reads it back unchanged, and
 * enforces nothing — so on Bun with the Express or Fastify backend this number
 * is installed and ignored, and the frame is buffered in full before the
 * connection actor refuses it.  Returning a smaller number cannot repair that,
 * and the shim leaves no seam a backend could use instead; the guarantee that
 * survives there is the actor's, which is per route and unaffected.
 * `tests/integration/in-process/http/websocket/BackendTransportFrameCap.test.ts`
 * pins both halves, so the day the shim enforces the option that test goes red
 * and the caveat in the WebSocket docs can be lifted.
 *
 * An empty list falls back to the built-in default; no shipped backend calls
 * it that way, but the answer has to be a bound rather than `-Infinity`.
 */
export function transportFrameCapOf(registrations: ReadonlyArray<WebsocketRouteRegistration>): number {
  let cap = 0;
  for (const registration of registrations) cap = Math.max(cap, registration.maxFrameBytes);
  return cap > 0 ? cap : DEFAULT_WEBSOCKET_MAX_FRAME_BYTES;
}

/**
 * The slice of a `node:http` / `node:net` server the resolved server policy
 * writes to.  Every property is optional because the object is reached through
 * a runtime that may not be Node at all — see {@link applyServerOptions}.
 */
export type NodeHttpServerLike = {
  keepAliveTimeout?: number;
  headersTimeout?: number;
  requestTimeout?: number;
  maxConnections?: number;
  /**
   * Present on a TLS listener — `tls.Server`, which `https.Server` and
   * `http2.Http2SecureServer` both extend — and read only for its presence:
   * it is how {@link enforceHeaderTimeout} knows that `'connection'` hands out
   * a raw TCP socket beneath the one HTTP is spoken on.
   */
  setSecureContext?: unknown;
  /**
   * The server events the two guards below subscribe to, so the cap and the
   * header deadline are held in this repository rather than delegated — see
   * {@link enforceMaxConnections} and {@link enforceHeaderTimeout} for why.
   * A function-typed property rather than a method signature, so this stays a
   * data shape; the intersection is how a data shape spells an overload.
   *
   * `'request'`, `'upgrade'` and `'stream'` take their arguments as `unknown`
   * on purpose.  They are the ways a header block finishes and their shapes
   * differ — `(request, response)`, `(request, socket, head)` and HTTP/2's
   * `(stream, headers, flags)` — while the only thing wanted from any of them
   * is the connection, which {@link enforceHeaderTimeout} recognises by
   * identity rather than by position.  Naming the runtime's own types here
   * would be a second, weaker copy of `node:http`'s for no gain.
   */
  on?: ((event: 'connection' | 'secureConnection', listener: (socket: ServerSocketLike) => void) => unknown)
    & ((event: 'session', listener: (session: Http2SessionLike) => void) => unknown)
    & ((event: 'request' | 'upgrade' | 'stream', listener: (...args: ReadonlyArray<unknown>) => void) => unknown);
};

/**
 * The slice of an HTTP/2 session the two guards that reach one need: the
 * socket {@link enforceHeaderTimeout} names its connection by, the session's
 * own idle timer that {@link enforceSessionIdleTimeout} arms, and the two ways
 * to end it.
 */
export type Http2SessionLike = {
  /**
   * Neither object `'connection'` or `'secureConnection'` handed out — a Proxy
   * on Node, a wrapper of Bun's own — but one that reports their endpoints.
   */
  readonly socket?: unknown;
  /**
   * Arm the session's idle timer, or clear it with `0`.  It counts quiet time
   * on the whole connection, an open stream that is merely waiting included.
   * A later call replaces whatever timer an earlier one armed, while every
   * callback handed to it stays attached until the timer fires — measured on
   * node v26.10.0 and bun 1.4.2.
   */
  setTimeout: (milliseconds: number, callback?: () => void) => unknown;
  /** The graceful end: a GOAWAY, then the open streams finish and no new one starts. */
  close: () => void;
  /** The abrupt end: every open stream is cut. */
  destroy: () => void;
};

/**
 * What {@link enforceMaxConnections} has observed since `listen`.
 *
 * It exists because the cap failed on one runtime and passed on another with
 * no way to tell which half was missing — whether the guard was installed at
 * all, whether the connection event ever reached it, or whether it refused a
 * socket the peer then did not see close.  Three numbers separate those, and
 * a test that asserts on them reports the cause in its failure message rather
 * than leaving the next reader to reason from a timeout (#870).
 */
export type ConnectionCapReport = {
  /** `false` when the server exposes no `on` — nothing was installed. */
  readonly installed: boolean;
  /** Accepted connections the guard has been handed. */
  readonly seen: number;
  /** Of those, the ones it hung up on because the cap was full. */
  readonly refused: number;
  /** Connections it currently counts as held. */
  readonly held: number;
};

/**
 * The slice of an accepted `net.Socket` the two guards need: something to hang
 * up, a way to learn it hung up, and a way to say why first.
 */
export type ServerSocketLike = {
  destroy: () => void;
  once?: (event: 'close', listener: () => void) => unknown;
  /**
   * Write a last response and half-close.  Optional because a runtime that
   * cannot offer it still gets the close from `destroy` — a peer that is
   * hung up on without a status line learns the same thing, later and less
   * politely.
   */
  end?: (data?: string) => unknown;
  /**
   * The connection's endpoints, which every object standing for one
   * connection reports alike — see {@link enforceHeaderTimeout}.  Optional
   * because a socket that is already gone, or a runtime that cannot say, has
   * none; such a socket is matched by identity alone.
   */
  readonly localAddress?: string;
  readonly localPort?: number;
  readonly remoteAddress?: string;
  readonly remotePort?: number;
};

/**
 * Which connection-level fields of a resolved `actor-ts.http.server` policy a
 * backend put into effect on the server it bound — the four written after
 * `listen()` as {@link applyServerOptions} reports them, the ones fixed when
 * the server is built as the backend that built it reports them — carried on
 * {@link ServerBinding.serverOptionsReport}, so `HttpExtension.bind` can say
 * when a bound the deployment set holds nothing.
 *
 * It exists because that state used to be silent.  Every shipped backend
 * dropped the answer, so `max-connections` set for the Hono backend under Bun —
 * where `Bun.serve` hands back no server to install it on — produced a server
 * that took every connection and a log with nothing to say about it.
 *
 * `true` means in effect, and for the two bounds actor-ts holds itself it
 * means the guard was installed, not merely the property written:
 * `headerTimeoutMs` is the boolean {@link enforceHeaderTimeout} returns, and
 * `maxConnections` the `installed` flag of {@link enforceMaxConnections}.  A
 * property alone does not count there, since it is exactly what Bun accepts
 * and ignores.  `idleTimeoutMs` and `requestTimeoutMs` count where the property
 * was written, which is where the runtime reads it — and `idleTimeoutMs` also
 * where `Bun.serve` took it as `idleTimeout`, which it validates, so it is read
 * there too (#1487).
 *
 * `false` means not in effect, for one of two reasons the report does not
 * tell apart: the field was not set, or this backend and runtime have nowhere
 * to put it.  `HttpExtension.bind` knows which fields were set, so it only
 * ever reads the second.
 *
 * The report is as good as the event the guards rest on.  Deno's `node:http`
 * shim offers `on` but never emits `'connection'` (measured on deno 2.6.8), so
 * on Fastify or Express under Deno — pairs this project does not support —
 * neither guard fires.  The header guard says so: on Deno it reports itself not
 * in effect.  The connection cap is still installed and reported, and never
 * fires — measured on deno 2.6.8, a second connection under a cap of one was
 * answered.
 */
export type ServerOptionsReport = {
  readonly idleTimeoutMs: boolean;
  readonly headerTimeoutMs: boolean;
  readonly requestTimeoutMs: boolean;
  readonly maxConnections: boolean;
  /**
   * Present when the policy set it, and then `true` on every shipped backend
   * and runtime: each counts a body's bytes in code of its own — Fastify's
   * parser, the Express and Hono readers — so the cap needs no server object
   * to hold, and Hono under Bun or Deno holds it as Fastify does (#1488).
   *
   * Optional, like the other field fixed when the server is built, and for
   * the reason {@link ServerBinding.serverOptionsReport} is: a backend written
   * before it existed still produces a report, and an absent field reads as
   * not in effect — so a cap set for such a backend is warned about, which is
   * the side to err on.
   */
  readonly maxContentLength?: boolean;
  /**
   * Present when the policy set it, and `true` where the server was built with
   * it and reports holding it: Fastify (verified at `listen()`, a hand-built
   * instance without it being refused), Express (the server the backend
   * builds) and Hono on Node (`@hono/node-server`'s `serverOptions`).  `false`
   * on Hono under Bun or Deno, whose `serve()` has no per-server header cap.
   *
   * It speaks for HTTP/1.1.  On an HTTP/2 listener under Node the cap binds
   * the HTTP/1.1 requests sharing the port and not an HTTP/2 stream's header
   * list — measured on node v26.10.0, a 4 KiB header list reached the handler
   * through a 1 KiB cap — so `true` there is not a claim about h2 streams.
   */
  readonly maxHeaderBytes?: boolean;
  /**
   * Present only where the backend chose the idle timeout itself and the
   * runtime would not let it choose one long enough: what it installed, in
   * milliseconds, held at the runtime's ceiling.
   *
   * Hono under Bun is the one such pair (#1487).  `Bun.serve`'s idle timeout
   * closes a connection whose handler has written nothing for that long, so
   * with `idle-timeout` unset the backend derives one from the longest
   * request deadline on the server, letting `requestTimeout()`'s `503` win —
   * and `Bun.serve` holds no more than 255 s, which covers a deadline up to
   * 250 s.  Past that this member is set, and `bind()` names the key and the
   * deadline it cannot cover in a warning: a handler silent that long is cut
   * with no response.  Setting `idle-timeout` is the way out.
   */
  readonly idleTimeoutHeldAtCeilingMs?: number;
};

/**
 * What `listen()` is handed: the resolved `actor-ts.http.server` policy, and
 * beside it what `HttpExtension.bind` worked out from the route tree — which
 * no configuration layer can say, so it is no field of
 * {@link HttpServerOptionsType}, has no HOCON leaf and no builder method.
 */
export type ServerListenOptions = Partial<HttpServerOptionsType> & {
  /**
   * The longest a handler on this server may take before the framework
   * answers it `503`, in milliseconds: `actor-ts.http.request-timeout.deadline`
   * (30 s built in), raised to the longest `requestTimeout()` deadline compiled
   * into the routes.  Absent on a `listen()` called directly.
   *
   * Internal: the Hono backend under Bun derives its idle timeout from it,
   * because `Bun.serve` closes a connection whose handler has written nothing
   * for the idle timeout, and the `503` has to be written before that
   * (#1487).  Every other backend ignores it.
   */
  readonly requestDeadlineMs?: number;
};

/**
 * The part of a {@link ServerOptionsReport} that {@link applyServerOptions}
 * decides: the four bounds it writes onto a server that is already
 * listening.  The others are fixed when the server is built, so the backend
 * that built it — and knows what it built it with — reports them, through
 * {@link serverOptionsReportOf}.
 */
export type ListenServerOptionsReport = Pick<
  ServerOptionsReport,
  'idleTimeoutMs' | 'headerTimeoutMs' | 'requestTimeoutMs' | 'maxConnections'
>;

/**
 * What only a backend can say about the server it built — see
 * {@link serverOptionsReportOf}.  The idle members are the Hono backend's under
 * Bun, whose runtime takes the idle timeout when the server is built rather
 * than as a property written after `listen()`; every other backend leaves them
 * out.
 */
export type BuiltInServerOptions = {
  /** Whether the server it built holds the header cap. */
  readonly maxHeaderBytes: boolean;
  /** Whether the server it built holds a set idle timeout. */
  readonly idleTimeoutMs?: boolean;
  /** See {@link ServerOptionsReport.idleTimeoutHeldAtCeilingMs}. */
  readonly idleTimeoutHeldAtCeilingMs?: number;
};

/**
 * The report a shipped backend returns on its binding: what
 * {@link applyServerOptions} installed after `listen()`, and the fields fixed
 * when the server was built — each present only when `options` set it, since
 * an unset one left nothing to build in.  `builtIn` is what only the backend
 * can say about the server it built.
 */
export function serverOptionsReportOf(
  installedAfterListen: ListenServerOptionsReport,
  options: Partial<HttpServerOptionsType> | undefined,
  builtIn: BuiltInServerOptions,
): ServerOptionsReport {
  return {
    ...installedAfterListen,
    // An idle timeout the runtime took at construction holds as surely as one
    // written after `listen()` — `Bun.serve`'s, on the Hono backend (#1487).
    ...(builtIn.idleTimeoutMs === true ? { idleTimeoutMs: true } : {}),
    ...(builtIn.idleTimeoutHeldAtCeilingMs !== undefined ? { idleTimeoutHeldAtCeilingMs: builtIn.idleTimeoutHeldAtCeilingMs } : {}),
    // Every shipped backend holds a set body cap: an untouched one adopts it
    // and one built with a different cap was refused before it bound.
    ...(options?.maxContentLength !== undefined ? { maxContentLength: true } : {}),
    ...(options?.maxHeaderBytes !== undefined ? { maxHeaderBytes: builtIn.maxHeaderBytes } : {}),
  };
}

const NOTHING_IN_EFFECT: ListenServerOptionsReport = Object.freeze({
  idleTimeoutMs: false,
  headerTimeoutMs: false,
  requestTimeoutMs: false,
  maxConnections: false,
});

/**
 * Install a resolved `actor-ts.http.server` policy on the server a backend
 * just started listening on, and report what actually took — the
 * {@link ListenServerOptionsReport} half of the report a backend hands back on
 * its binding.
 *
 * **Why post-listen and not at construction.**  All four are plain mutable
 * properties that the runtime re-reads per connection, so writing them after
 * `listen()` reaches every future connection — which is what lets one policy,
 * resolved once at `bind()`, cover a backend the framework built *and* a
 * backend the application constructed and passed to `useBackend(...)`.  The
 * bounds fixed when the server is built are not reached from here at all, and
 * each has its own seam instead.  `max-content-length` is held where each
 * backend reads its bodies — Fastify's `bodyLimit`, which the framework-built
 * instance takes from `fastifyFactoryOptions`, and {@link bodyCapOf} on
 * Express and Hono.  `max-header-bytes` is `maxHeaderSize` on the server the
 * backend builds: Fastify's factory options, the `http.createServer` Express
 * calls itself — `https.createServer` under `tls`, with the certificate beside
 * it — and `@hono/node-server`'s `serverOptions`.  A hand-built
 * Fastify whose own cap differs from either is refused at `listen()`.
 * `connectionsCheckingInterval`, the sweep `requestTimeout` rides on, is left
 * at the runtime's 30 s.
 *
 * **An unset field is left alone, never defaulted here.**  `idleTimeoutMs` and
 * `maxConnections` ship no value precisely so the backend's own choice
 * survives, and writing `undefined` onto `keepAliveTimeout` would replace
 * Fastify's deliberate 72 s with `NaN` semantics rather than with nothing.
 *
 * **`idleTimeoutMs` is two writes, because HTTP/2 does not read the first.**
 * `keepAliveTimeout` bounds an idle HTTP/1.1 connection; an HTTP/2 session
 * never consults it, so on an HTTP/2 listener the setting reaches the session
 * through the session's own timer instead — see
 * {@link enforceSessionIdleTimeout}.
 *
 * **Where it does and does not reach** — the honest half, in the shape
 * {@link transportFrameCapOf} uses for the `ws` shim:
 *
 *   - **Fastify** — `this.app.server`.  All four.
 *   - **Express** — the server the backend builds and listens on: `node:http`,
 *     or `node:https` under `tls`, which carries the same four properties and
 *     events.  All four, on either.
 *   - **Hono on Node** — `@hono/node-server` hands its `node:http` server back
 *     as `HonoServerHandle.raw`.  All four.
 *   - **Hono on Bun** — `Bun.serve` exposes no server object, so `raw` is
 *     absent and none of the four is installed *here*.  `idleTimeoutMs`
 *     reaches the connection anyway, by another route: `Bun.serve` takes it
 *     as `idleTimeout` when the server is built, so the Bun runner writes it
 *     there and the backend reports it in effect (#1487).  It is a different
 *     bound from `keepAliveTimeout`, though — **whole-connection inactivity**,
 *     so a handler that writes nothing, a long poll or a sparse SSE stream is
 *     cut too — in whole seconds rounded up, checked on a 4 s sweep that can
 *     close a connection up to one sweep early, and at most 255 s: a longer
 *     one is refused at `listen()`.  Unset, the runner derives it from the
 *     server's longest request deadline, 36 s for the built-in 30 s, so that
 *     `requestTimeout()`'s `503` is written before Bun cuts the connection —
 *     see `bunIdleTimeoutOf` in `src/runtime/http/BunHonoRunner.ts`.  An idle
 *     HTTP/2 session is bound by it too.
 *   - **Hono on Deno** — `Deno.serve` exposes no server object and no
 *     equivalent knob for any of the four, so `raw` is absent and **none is
 *     installed**.
 *
 * Passing an absent server is therefore ordinary, not an error: it is how the
 * pairs without a `node:http` server report themselves.  Every field comes
 * back not in effect from here, the backend adds what it built in, and
 * `HttpExtension.bind` names each one the deployment set that still holds
 * nothing in a warning, so the gap is said once per bind rather than
 * discovered.
 *
 * **`Infinity` is not written.**  It is the code-side spelling of the
 * unlimited default for `maxConnections`, and `net.Server` wants the property
 * absent for that, not set to a non-finite number.
 *
 * `requestTimeout` carries a caveat worth knowing before trusting the number:
 * the runtime enforces it on a periodic sweep whose interval
 * (`connectionsCheckingInterval`) is a *factory* option defaulting to 30 s, so
 * a connection is closed no earlier than the configured value and no later
 * than one sweep after it.  Measured on bun 1.4.0: a 2 s `requestTimeout`
 * closed a stalled body at 30.0 s, and `0` left the connection open past
 * 45 s.  Whether the peer learns why is the backend's doing rather than the
 * runtime's: a bare `node:http` server answers `408` before closing, but
 * Fastify's `clientError` handler writes its `408` and then destroys, and on
 * bun 1.4.2 a handler of that shape delivers nothing — on the default backend
 * the close carries zero bytes.  `keepAliveTimeout` is not swept and is exact;
 * `headersTimeout` is not swept either, because it is no longer the runtime
 * that enforces it — see {@link enforceHeaderTimeout}.
 *
 * **`headersTimeout` is written as the shorter of the two deadlines** — see
 * {@link headerDeadlineOf} — and the framework-held guard is armed with that
 * same number, so a `request-timeout` below `header-timeout` bounds the header
 * phase on every runtime the guard reaches rather than only where a sweep
 * happens to apply it.
 */
export function applyServerOptions(
  server: NodeHttpServerLike | null | undefined,
  options: Partial<HttpServerOptionsType> | undefined,
): ListenServerOptionsReport {
  if (!server || !options) return NOTHING_IN_EFFECT;
  const report = {
    idleTimeoutMs: false,
    headerTimeoutMs: false,
    requestTimeoutMs: false,
    maxConnections: false,
  };
  if (options.idleTimeoutMs !== undefined) {
    server.keepAliveTimeout = options.idleTimeoutMs;
    enforceSessionIdleTimeout(server, options.idleTimeoutMs);
    report.idleTimeoutMs = true;
  }
  if (options.headerTimeoutMs !== undefined) {
    const headerDeadlineMs = headerDeadlineOf(options.headerTimeoutMs, options.requestTimeoutMs);
    server.headersTimeout = headerDeadlineMs;
    // `0` is the documented opt-out, and arming a zero-length deadline would
    // read it as "close every connection at once" — the exact inversion of
    // what it asks for.  Arming nothing is then the whole of what it asks, so
    // it is in effect wherever the policy reached a server at all; reported
    // otherwise, the opt-out would be warned about on every backend that
    // honours it.
    report.headerTimeoutMs = headerDeadlineMs > 0 ? enforceHeaderTimeout(server, headerDeadlineMs) : true;
  }
  if (options.requestTimeoutMs !== undefined) {
    server.requestTimeout = options.requestTimeoutMs;
    report.requestTimeoutMs = true;
  }
  if (options.maxConnections !== undefined && options.maxConnections !== Infinity) {
    server.maxConnections = options.maxConnections;
    // The guard, not the property, is what the report counts: the property is
    // the one some runtimes accept and ignore, and a cap reported in effect on
    // that alone would be the silent failure the report exists to end.
    report.maxConnections = enforceMaxConnections(server, options.maxConnections)().installed;
  }
  return report;
}

/**
 * The header deadline a policy actually asks for: `header-timeout`, or
 * `request-timeout` where that is shorter — the headers are part of the
 * request, so a request that must be received within 30 s must have its
 * headers within 30 s too.
 *
 * Writing the two properties as configured made the pair incoherent in the
 * one direction the docs' own example took (`request-timeout = 30s` under the
 * 60 s header default).  Both runtimes' `http.createServer` refuse a
 * `headersTimeout` above `requestTimeout` outright, but a post-`listen()`
 * write skips that check, and Node's sweep then swaps the two: measured on
 * node v26.10.0, a 2 s `requestTimeout` under a 60 s `headersTimeout` closed a
 * stalled body at 60.0 s, against 30.0 s under a 1 s one.  Bun does not swap —
 * and ignores `headersTimeout` altogether, which is why the guard is armed
 * with the result as well.
 *
 * Refusing the pair at `bind()` was the alternative, and the worse one: an
 * operator who lowers `request-timeout` has said something complete, and an
 * error until they also lower a default they never touched would turn that
 * into a puzzle about two keys.
 *
 * `0` on either side is "no bound", never the smaller number: a
 * `request-timeout` of `0` leaves `header-timeout` standing, and a
 * `header-timeout` of `0` — the guard's documented opt-out — stays off.  The
 * request deadline still reaches the header phase there, through the runtime:
 * measured with a 500 ms sweep, `headersTimeout = 0` and `requestTimeout =
 * 2000` answered a connection that never finished its headers `408` at 2.0 s
 * on node v26.10.0 and 2.5 s on bun 1.4.2.
 */
function headerDeadlineOf(headerTimeoutMs: number, requestTimeoutMs: number | undefined): number {
  return requestTimeoutMs !== undefined && requestTimeoutMs > 0
    ? Math.min(headerTimeoutMs, requestTimeoutMs)
    : headerTimeoutMs;
}

/**
 * Bound an idle HTTP/2 session by `idleTimeoutMs`, through the session's own
 * timer — the HTTP/2 half of `idle-timeout`, whose HTTP/1.1 half is
 * `keepAliveTimeout`.
 *
 * **Why a second mechanism.**  `keepAliveTimeout` is read by the HTTP/1.1
 * connection handling only.  Measured on node v26.10.0 and bun 1.4.2, an h2
 * session that completed one request under `keepAliveTimeout = 800` was still
 * open past 5 s, on Fastify and on a bare `http2.createSecureServer({
 * allowHTTP1 })` alike — so an idle HTTP/2 client was held by Fastify's own
 * 72 s `http2SessionTimeout`, and on Hono over Node by nothing at all, whatever
 * `idle-timeout` said.  A bound that holds on one protocol of the two a TLS
 * listener speaks is the half-guarantee this module refuses elsewhere.
 *
 * **What it measures, per runtime.**  From the end of the response: node
 * closed the session 0.80 s and 2.00 s later for 800 and 2000 ms, bun 1.60 s
 * and 4.00 s later — Bun fires a session timer at twice its value.  That is
 * not compensated here: halving the number on one runtime would encode an
 * implementation detail as a contract, and the documentation states both.
 *
 * **`close`, not `destroy`.**  The timer counts quiet time on the whole
 * connection, and a stream whose handler has not answered yet is quiet: on
 * both runtimes it fired mid-request.  `close` sends the GOAWAY then and lets
 * the open stream finish — a handler answering after 2.5 s under an 800 ms
 * bound was delivered whole — where `destroy` cut it.  So a slow handler, a long
 * poll and an SSE stream outlive the bound exactly as they do on HTTP/1.1,
 * where `keepAliveTimeout` only counts between requests.
 *
 * **`0` clears the timer**, which is the documented "0 disables it" on HTTP/2
 * too — and it clears Fastify's 72 s with it.  Fastify arms that from a
 * `'session'` listener of its own, registered at construction and so ahead
 * of this one; a later `setTimeout` replaces the earlier timer, measured on both
 * runtimes against a 1 s timer armed first.  For a non-zero value the same
 * rule makes this one the timer that governs, and Fastify's callback merely
 * closes the session a second time when it fires.
 *
 * A server that emits no `'session'` — every HTTP/1.1-only listener — is
 * subscribed and never called, which costs one listener.
 */
export function enforceSessionIdleTimeout(server: NodeHttpServerLike, idleTimeoutMs: number): void {
  if (typeof server.on !== 'function') return;
  server.on('session', (session) => {
    session.setTimeout(idleTimeoutMs, () => { session.close(); });
  });
}

/**
 * Hold the header-phase deadline here, timing it from the accepted connection
 * rather than trusting the runtime to honour the `headersTimeout` property
 * written above.
 *
 * **Why this exists, given the property is written anyway.**  On the primary
 * toolchain the property does nothing.  Measured on a bare `node:http` server,
 * a socket that sends `GET / HTTP/1.1\r\nHost: x\r\n` and then never sends the
 * terminating blank line:
 *
 *   - **node v26.7.0** — honours it.  `headersTimeout = 2000` answered
 *     `408 Request Timeout` and closed at 30.0 s (the configured value, plus
 *     the sweep `requestTimeout` also rides on); `0` left the connection open
 *     past 45 s, which is the documented opt-out working.
 *   - **bun 1.4.0** — stores the number, reads it back unchanged, and enforces
 *     nothing.  `2000`, `40000`, `120000` and `0` all produced the same close
 *     at ~12.0 s with **zero bytes received** — Bun's own whole-connection
 *     idle timeout, not this guard, and no `408`.  `0`, which is documented as
 *     disabling the guard, disabled nothing.
 *   - **deno 2.6.8** — stores it, enforces nothing, and applies no idle close
 *     either: the connection was **still open after 45 s**.
 *
 * That is the slow-loris hole the key exists to close, standing open on two of
 * the three supported runtimes while five surfaces said it was shut (#870).  A
 * security control that holds on the runtime a reader is least likely to be
 * using is not a weaker guarantee but a wrong one — the same reasoning
 * {@link enforceMaxConnections} carries, arrived at from the other direction.
 *
 * **The seam, and where it runs out.**  Arm a timer when the connection is
 * accepted; disarm it the moment the header block completes, which is exactly
 * what `'request'` and `'upgrade'` announce.  Measured on bun 1.4.0 and node
 * v26.7.0: a manual 1500 ms deadline delivered the `408` and closed at 1531 ms
 * and 1536 ms respectively, and the socket `'request'`/`'upgrade'` hand back
 * is the *same object* `'connection'` gave us, so identity is enough to match
 * them.  **Deno's `node:http` shim emits no `'connection'` event at all** — a
 * complete request there fires `'request'` and nothing else (measured again on
 * deno 2.6.8) — so on Deno there is no seam, and its `node:https` adds no
 * `'secureConnection'` either.  The shim offers `on` like any server, so the
 * event hook cannot tell; the runtime can.  Measured on deno 2.6.8 against
 * both, through {@link applyServerOptions}: no event fired, and a slow-loris was
 * still open 3 s after an 800 ms deadline, while this function returned
 * `true` and `bind()` therefore had nothing to warn about.  On Deno it now
 * installs nothing and returns `false`, so the report says the deadline is not
 * in effect and a set `header-timeout` is warned about, the way the header cap
 * the same shim reads back as `undefined` already is.
 *
 * **One connection, several objects.**  Identity is enough only while the
 * socket `'request'` hands back is the one `'connection'` handed out, which is
 * plaintext HTTP/1.1.  On the two transports a server terminates itself it is
 * not — measured on node v26.10.0 and bun 1.4.2, with the listeners registered
 * after `listen()` as they are here:
 *
 *   - **TLS on Node** — `'connection'` hands the raw TCP socket and
 *     `'secureConnection'` a separate TLS socket, the one requests arrive on.
 *     Keyed by the TCP socket alone the deadline never cleared: a healthy
 *     keep-alive connection was reset one header timeout after it opened, and
 *     a slow-loris had its `408` written beneath TLS, where no client could
 *     read it.  Bun hands all three events one object, and was right by
 *     accident.
 *   - **HTTP/2 on both** — `'session'` arrives *before* this module's
 *     `'secureConnection'` listener runs, because the server's own creates the
 *     session, and its `socket` is neither object: a Proxy on Node, a wrapper
 *     of Bun's own.  A request's `socket` is per stream.  Every HTTP/2 session
 *     was closed at the deadline, healthy or not.
 *
 * What every one of those objects reports alike is the connection's endpoint
 * pair — see {@link connectionEndpointOf} — so the deadline is carried across
 * the hops by it: to the TLS socket at `'secureConnection'`, which from then on
 * is where the `408` goes, inside TLS; and to the session at `'session'`, whose
 * first stream clears it.  The TLS handshake therefore stays inside the
 * window — a peer that never finishes negotiating is the slow-loris one layer
 * down — and one that expires mid-handshake is hung up on without a status
 * line, since there is no HTTP to answer yet.  A session that never opens a
 * stream is closed as a session, which its client sees as a GOAWAY rather than
 * an HTTP/1.1 line nobody on that connection speaks.  One gap is the
 * runtime's: Bun's HTTPS listener reports a connection only once its handshake
 * is done, so there a stalled handshake is bounded by Bun's own ~12 s idle
 * close, not by this.
 *
 * `'upgrade'` is not an optional extra: a WebSocket handshake completes its
 * headers and then holds the socket open for hours, so a deadline that only
 * watched `'request'` would tear down every WebSocket connection one header
 * timeout after it opened.
 *
 * The deadline is per **connection**, not per request or stream: it bounds the
 * window from accept to the first complete header block, which is the shape of
 * the attack.  A later request on a kept-alive connection is bounded by
 * `idle-timeout` and by the runtime's own `headersTimeout` where that works.
 *
 * The cost is one timer per accepted connection, cleared on the first request,
 * and one map entry under its endpoint pair, dropped with it.  That is the
 * price of not delegating; the runtime's sweep is cheaper and, on two runtimes
 * out of three, imaginary.
 *
 * Returns whether the guard was installed — whether the server offers `on`, on
 * a runtime that emits the events it rests on — so a server that cannot host
 * it reports itself rather than pretending.  It is what
 * {@link ServerOptionsReport.headerTimeoutMs} counts.
 */
export function enforceHeaderTimeout(server: NodeHttpServerLike, deadlineMs: number): boolean {
  if (typeof server.on !== 'function') return false;
  // Deno emits neither 'connection' nor 'secureConnection', so a deadline
  // installed there would never be armed (see above).
  if (detectRuntime() === 'deno') return false;
  const secureListener = typeof server.setSecureContext === 'function';
  // Weak because a socket that closes before its headers complete must not be
  // held alive by the bookkeeping meant to hang up on it.  A settled deadline
  // stays in here on purpose: the next request on the same socket or session
  // then stops at the first lookup that names it instead of trying every
  // argument.
  const byObject = new WeakMap<object, HeaderDeadline>();
  // Strong, so an entry leaves only by `settle` — which every deadline reaches:
  // by completing, by closing, or by expiring.
  const byEndpoint = new Map<string, HeaderDeadline>();

  const settle = (deadline: HeaderDeadline): boolean => {
    if (deadline.settled) return false;
    deadline.settled = true;
    clearTimeout(deadline.timer);
    // Only our own entry: a newer connection on the same pair may have taken
    // it since, and it would then never be carried into TLS.
    if (deadline.endpoint !== undefined && byEndpoint.get(deadline.endpoint) === deadline) {
      byEndpoint.delete(deadline.endpoint);
    }
    return true;
  };
  const expire = (deadline: HeaderDeadline): void => {
    if (!settle(deadline)) return;
    if (deadline.session !== undefined) {
      deadline.session.destroy();
      return;
    }
    if (deadline.answerOn !== undefined) {
      // `end` first so the peer learns why, `destroy` after so it goes even if
      // the write cannot flush.  Measured on bun 1.4.0 and node v26.7.0: the
      // client receives the full status line in that order — and on node
      // v26.10.0 through TLS too, once it is written to the TLS socket.
      deadline.answerOn.end?.(HEADER_TIMEOUT_RAW_RESPONSE);
      deadline.answerOn.destroy();
      return;
    }
    deadline.socket.destroy();
  };
  /** The deadline `candidate` stands for — by identity, else by endpoint.  Used once per hop, never per request. */
  const deadlineOf = (candidate: unknown): HeaderDeadline | undefined => {
    if (typeof candidate !== 'object' || candidate === null) return undefined;
    const known = byObject.get(candidate);
    if (known !== undefined) return known;
    const endpoint = connectionEndpointOf(candidate);
    return endpoint === undefined ? undefined : byEndpoint.get(endpoint);
  };
  const completedBy = (candidate: unknown): boolean => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const deadline = byObject.get(candidate);
    if (deadline === undefined) return false;
    settle(deadline);
    return true;
  };
  const onHeadersComplete = (...args: ReadonlyArray<unknown>): void => {
    // `'request'` hands (request, response), `'upgrade'` hands (request,
    // socket, head) and `'stream'` hands (stream, headers, flags), so the
    // connection sits at a different place in each — and on a runtime this
    // repository has not measured, at none.  Trying every argument, its
    // `.socket` and its `.session` finds it by identity in all of them, and
    // cannot mistake a foreign object for one of ours.
    for (const argument of args) {
      if (completedBy(argument)) return;
      const carrier = argument as { socket?: unknown; session?: unknown } | null | undefined;
      if (completedBy(carrier?.socket)) return;
      if (completedBy(carrier?.session)) return;
    }
  };

  server.on('connection', (socket) => {
    const endpoint = connectionEndpointOf(socket);
    const deadline: HeaderDeadline = {
      socket,
      answerOn: secureListener ? undefined : socket,
      session: undefined,
      endpoint,
      timer: undefined,
      settled: false,
    };
    deadline.timer = setTimeout(() => { expire(deadline); }, deadlineMs);
    // Unreferenced, or an idle server with one open connection would hold the
    // process up for a header timeout after everything else had finished.
    (deadline.timer as { unref?: () => void }).unref?.();
    byObject.set(socket, deadline);
    if (endpoint !== undefined) byEndpoint.set(endpoint, deadline);
    socket.once?.('close', () => { settle(deadline); });
  });
  server.on('secureConnection', (socket) => {
    const deadline = deadlineOf(socket);
    if (deadline === undefined || deadline.settled) return;
    deadline.answerOn = socket;
    byObject.set(socket, deadline);
  });
  server.on('session', (session) => {
    const deadline = deadlineOf(session.socket);
    if (deadline === undefined || deadline.settled) return;
    deadline.session = session;
    byObject.set(session, deadline);
  });
  server.on('request', onHeadersComplete);
  server.on('upgrade', onHeadersComplete);
  server.on('stream', onHeadersComplete);
  return true;
}

/**
 * One armed header deadline, and what it has learned about its connection
 * since `'connection'`.  @internal
 */
type HeaderDeadline = {
  /** The socket `'connection'` handed out: the TCP connection itself. */
  readonly socket: ServerSocketLike;
  /**
   * Where the `408` goes — the socket HTTP/1.1 is spoken on.  The TCP socket
   * on a plaintext listener; on a TLS listener unknown until
   * `'secureConnection'`, because a status line written before the handshake
   * would land in the middle of it.
   */
  answerOn: ServerSocketLike | undefined;
  /** Set once the connection turns out to carry an HTTP/2 session. */
  session: Http2SessionLike | undefined;
  /** The key this deadline is filed under in the endpoint map, if its socket could name one. */
  readonly endpoint: string | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
};

/**
 * A connection's endpoint pair — local and remote address and port — as the
 * key every object standing for one TCP connection agrees on, or `undefined`
 * when `candidate` cannot name all four.
 *
 * The pair is not a stand-in for the connection, it is its definition: no two
 * connections open at once share one.  What does happen is that a pair comes
 * back once its connection has closed, when a client reuses the port — which
 * is why an entry is removed when its connection settles, and removed only if
 * it is still the one filed there.
 *
 * `undefined` is deliberately not a key.  A runtime that reported no endpoint
 * would otherwise file every connection under one name, and a request on any
 * of them would clear every deadline; such a socket is matched by identity
 * alone.  Reading can throw — Node's HTTP/2 session socket is a Proxy that
 * does once its session is gone — and that is an unknown endpoint too.
 */
function connectionEndpointOf(candidate: object): string | undefined {
  try {
    const { localAddress, localPort, remoteAddress, remotePort } = candidate as ServerSocketLike;
    if (typeof localAddress !== 'string' || typeof remoteAddress !== 'string') return undefined;
    if (typeof localPort !== 'number' || typeof remotePort !== 'number') return undefined;
    // Brackets, because an IPv6 address is made of colons.
    return `[${localAddress}]:${localPort} [${remoteAddress}]:${remotePort}`;
  } catch {
    return undefined;
  }
}

/**
 * Hold `cap` concurrent accepted connections, counting them here rather than
 * trusting the runtime to honour the `maxConnections` property written above.
 *
 * **Why this exists, given the property is written anyway.**  The property is
 * the cheaper enforcement and runs earlier — `net.Server` refuses the socket
 * before `'connection'` is emitted, so a runtime that honours it never reaches
 * this listener and the count never sees a refused connection.  What it is not
 * is dependable: the design this replaces rested on a measurement that
 * `keepAliveTimeout`, `headersTimeout`, `requestTimeout` and `maxConnections`
 * are "honoured, identically" on bun and node (#870), and that measurement was
 * taken on one operating system — and, for `headersTimeout`, was wrong on that
 * one too, which is what {@link enforceHeaderTimeout} exists to fix.  On
 * GitHub's Linux runners the same bun
 * release does not close the second connection, so three tests asserting the
 * documented cap have been red on `develop` while passing locally — twice, in
 * two independent workflows, which is what distinguishes it from a flake.  The
 * three sibling knobs pass there, so this is per-property rather than a blanket
 * `node:http` gap.
 *
 * **What the event is worth, measured rather than assumed (#1505).**  Adding
 * this guard did not turn those three tests green, and the reason is a second
 * platform difference underneath the first.  On bun 1.4.0 an `http.Server`
 * emits `'connection'` for an accepted socket **immediately on Windows and
 * only on its first byte on Linux** — until then `getConnections()` answers
 * `0` as well, so a silent socket is not merely uncounted there, it is
 * invisible.  The three tests opened silent sockets, which is a connection the
 * Linux server does not have; they now send a request and pass on both.
 *
 * That also resolves the split #1409 could not explain — why the header
 * deadline held on that runner while the cap did not, on what looked like the
 * same event.  A slow-loris writes a partial header block, so its socket
 * speaks and the event fires for it; the cap's cases connected and said
 * nothing.  Both observations follow from the one rule above.
 *
 * Two consequences worth keeping in view.  A connection that speaks is capped
 * identically everywhere, which is every real client — verified against a live
 * server on both platforms in `tests/unit/http/MaxConnectionsGuard.test.ts`.  A
 * connection that never speaks is capped by neither mechanism on Linux, because
 * the property is ignored and the event has not fired; `http/security.mdx`
 * carries that gap and names the OS- or proxy-level limit that closes it.
 *
 * A cap an operator sets and the process does not hold is worse than one that
 * is absent, because `http/security.mdx` offers it as the connection-flood
 * answer.  Counting here makes the knob mean the same thing on every runtime
 * that can emit the event, which is the property the documentation claims and
 * the one a security control has to have.
 *
 * Returns a live {@link ConnectionCapReport} reader rather than a boolean: a
 * server object without `on` — the `Bun.serve` and `Deno.serve` handles Hono
 * exposes — reports `installed: false` rather than pretending, and the three
 * counters beside it are what let a failing cap say which half is missing.
 */
export function enforceMaxConnections(
  server: NodeHttpServerLike,
  cap: number,
): () => ConnectionCapReport {
  let seen = 0;
  let refused = 0;
  let held = 0;
  let installed = false;
  const report = (): ConnectionCapReport => ({ installed, seen, refused, held });
  if (typeof server.on !== 'function') return report;
  installed = true;
  server.on('connection', (socket) => {
    seen++;
    // `>=` because this connection is the one being decided: at `cap` already
    // held, admitting it would make `cap + 1`.
    if (held >= cap) {
      refused++;
      // `end` first, then `destroy`, which is the order `enforceHeaderTimeout`
      // measured as the one a client actually observes on bun and node — a
      // bare `destroy` on a socket that has neither read nor written is the
      // shape whose close the peer was not seeing.  No body: there is no
      // request to answer, and a status line would be a lie about having
      // considered one.
      socket.end?.();
      socket.destroy();
      return;
    }
    held++;
    // A runtime that cannot report a close leaves the count rising, which
    // turns the cap into a lifetime budget rather than a concurrency bound.
    // That is stricter than asked for and wrong; it is not *open*, which the
    // previous shape was: it decremented on the spot when `once` was missing,
    // so `held` never grew and the cap never fired at all.  A security
    // control that degrades has to degrade towards refusing.
    socket.once?.('close', () => { held--; });
  });
  return report;
}

/**
 * Pluggable HTTP server abstraction.  Backends translate our generic
 * route registrations to their native framework (Fastify, Bun.serve,
 * Express, …).  The DSL only ever talks to this interface.
 */
export interface HttpServerBackend {
  readonly name: string;

  /**
   * Register all routes before `listen` is called.
   *
   * A repeat of a `method` + `pattern` pair already registered **must throw**,
   * rather than be dropped or appended.  Left to the router, a duplicate is
   * answered by whichever registration arrived first, which turns the
   * argument order of a `concat(...)` into the boundary deciding whether an
   * auth-guarded route or its unguarded twin is the one that serves — and
   * nothing anywhere says so.  Only Fastify's router used to enforce this, on
   * one of three backends; now each backend refuses in its own words and
   * `HttpExtension.bind` refuses backend-independently before any of them
   * sees the route (#759).
   *
   * Patterns that merely *overlap* — `/users/:id` against `/users/me`, a
   * wildcard against a literal — are not this, and are the router's business
   * as before.
   */
  registerRoute(route: RouteRegistration): void;

  /**
   * Start listening.  Returns a ServerBinding with the actual bound port.
   *
   * `serverOptions` is the resolved `actor-ts.http.server` policy —
   * `withServerOptions(...)` > HOCON > built-in default, decided once at
   * `bind()` for the same reason `WebsocketRouteRegistration.maxFrameBytes`
   * is: the numbers belong to the listening socket, so resolving them per
   * connection would be work repeated to reach the same answer, and a
   * malformed value would surface at the first request instead of at `bind()`.
   *
   * **Optional, and it stays optional.**  A backend written outside this
   * repository still satisfies the interface without it, and a `listen(host,
   * port)` called directly — every backend suite here does — behaves exactly
   * as it did before the parameter existed.  A backend that ignores it is not
   * broken, only untuned; {@link applyServerOptions} is the shared
   * implementation and documents which backend/runtime pairs can honour it at
   * all.
   *
   * What it put into effect goes back on the binding, as
   * {@link ServerBinding.serverOptionsReport} — what `applyServerOptions`
   * installed and what the backend built in, joined by
   * {@link serverOptionsReportOf} and handed on rather than dropped — and
   * `HttpExtension` warns at `bind()` about every field the deployment set
   * that the report says holds nothing.  A backend that leaves the member off
   * has said nothing, and is not warned about.
   *
   * The fields a server takes at construction — `maxContentLength` and
   * `maxHeaderBytes` — cannot be applied here to a server built without them,
   * so a backend that finds a set one disagreeing with what it was built with
   * refuses rather than binds: `FastifyBackend` against its `bodyLimit` and its
   * server's `maxHeaderSize`, Express and Hono against `withMaxBodyBytes`
   * through {@link bodyCapOf}.  A backend that builds its server inside
   * `listen()` — Express, and Hono through its runner — has nothing to
   * disagree with on the header cap, and builds it in.
   *
   * Beside the policy, `bind()` hands over the server's longest request
   * deadline ({@link ServerListenOptions.requestDeadlineMs}), which only the
   * Hono backend under Bun reads.  A backend's own `listen()` may keep the
   * narrower `Partial<HttpServerOptionsType>` parameter and never see it.
   */
  listen(host: string, port: number, serverOptions?: ServerListenOptions): Promise<ServerBinding>;

  /**
   * Optional: register a method-agnostic not-found handler, invoked for
   * any request that matched no route (including unmatched OPTIONS/HEAD).
   * `HttpExtension` wires `fallback()` here.  If the handler throws, the
   * backend applies its default error mapping.
   */
  setNotFound?(handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse): void;

  /**
   * Optional: register a last-resort error handler.  It MUST see both
   * errors thrown by route handlers AND backend-internal errors (body
   * parsing, etc.); if it throws, the backend falls back to its default
   * error mapping.  `HttpExtension` wires `withErrorHandler` here.
   */
  setErrorHandler?(handler: (err: unknown, request: HttpRequest) => Promise<HttpResponse> | HttpResponse): void;

  /**
   * Optional capability: register a WebSocket endpoint.  Backends that
   * implement this support `websocket()` routes; absence is detected by
   * `HttpExtension.bind` and reported as a clear error.
   */
  registerWebSocket?(reg: WebsocketRouteRegistration): void;

  /**
   * Optional: replace the header map the backend writes ahead of every
   * response it emits — including the error, not-found and upgrade-reject
   * responses no middleware ever sees.  A response's own header must still
   * win, so these are written first and overwritten, not merged over.
   *
   * `HttpExtension` wires `withSecurityHeaders(...)` here and passes `{}`
   * for the opt-out.  It is only called when that was configured: a backend
   * comes with its own default ({@link DEFAULT_RESPONSE_SECURITY_HEADERS}
   * for the shipped ones), so an untouched builder must not overwrite it.
   */
  setDefaultResponseHeaders?(headers: Readonly<Record<string, string>>): void;
}
