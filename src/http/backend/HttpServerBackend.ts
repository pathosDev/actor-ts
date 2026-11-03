import { ConfigKeys } from '../../config/ConfigKeys.js';
import { detectRuntime, type RuntimeKind } from '../../runtime/Detect.js';
import { armChainedTimeout, type Cancellable, type HostTimers, unreferencedHostTimers } from '../../Scheduler.js';
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
   * Present on an HTTP/2 listener — `http2.Http2SecureServer` on Node and on
   * Bun, measured on node v26.10.0 and bun 1.4.2, and on no `node:http` or
   * `node:https` server — and read only for its presence: it is how
   * {@link applyServerOptions} knows the listener also takes HTTP/1.1
   * connections its HTTP/2 bounds do not cover.
   */
  updateSettings?: unknown;
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
   * Arm the runtime's own idle timer for the session, or clear it with `0`.
   * It counts quiet time on the whole connection, an open stream that is
   * merely waiting included — and on Bun a PING frame as activity, at twice
   * the value.  A later call replaces whatever timer an earlier one armed —
   * measured on node v26.10.0 and bun 1.4.2.  {@link enforceSessionIdleTimeout}
   * only ever clears it.
   */
  setTimeout: (milliseconds: number, callback?: () => void) => unknown;
  /** The graceful end: a GOAWAY, then the open streams finish and no new one starts. */
  close: () => void;
  /** The abrupt end: every open stream is cut. */
  destroy: () => void;
  /**
   * The session's own `'stream'` event, one per request opened on it, with
   * the stream first — how {@link enforceSessionIdleTimeout} counts what is
   * open.  Optional because the header deadline needs none of it.
   */
  on?: (event: 'stream', listener: (...eventArguments: ReadonlyArray<unknown>) => void) => unknown;
  /** `'close'`: the session is gone, from whichever end. */
  once?: (event: 'close', listener: () => void) => unknown;
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

/** One of the two protocols an HTTP/2 listener speaks: HTTP/1.1 stays available on the same port. */
export type ListenerProtocol = 'HTTP/1.1' | 'HTTP/2';

/** The bounds that can hold for one protocol of an HTTP/2 listener and not the other. */
export type ProtocolHeldBound = 'idleTimeoutMs' | 'requestTimeoutMs' | 'maxHeaderBytes';

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
 * `true` means in effect **on every connection the listener accepts**, and for
 * the two bounds actor-ts holds itself it means the guard was installed, not
 * merely the property written: `headerTimeoutMs` is the `installed` flag of
 * {@link enforceHeaderTimeout}, and `maxConnections` the `installed` flag of
 * {@link enforceMaxConnections}.  A property alone does not count there, since
 * it is exactly what Bun accepts and ignores.  `idleTimeoutMs` and
 * `requestTimeoutMs` count where the property was written, which is where the
 * runtime reads it, together with the framework's own HTTP/2 halves —
 * {@link enforceSessionIdleTimeout} and {@link enforceStreamRequestTimeout} —
 * and `idleTimeoutMs` also where `Bun.serve` took it as `idleTimeout`, which it
 * validates, so it is read there too (#1487).
 *
 * `false` means not in effect, for one of three reasons the booleans do not
 * tell apart: the field was not set, this backend and runtime have nowhere to
 * put it, or it holds for only one of the two protocols an HTTP/2 listener
 * speaks — which {@link ServerOptionsReport.heldForOneProtocol} then names.
 * `HttpExtension.bind` knows which fields were set, so it only ever reads the
 * last two, and words its warning by which one it is.  A bound that holds for
 * HTTP/2 and not for the HTTP/1.1 connections on the same port is a bound a
 * client can step around by offering HTTP/1.1, so it is not reported as held:
 * that is the half-guarantee this report exists to say out loud.
 *
 * The report is as good as the event the guards rest on.  Deno's `node:http`
 * shim offers `on` but never emits `'connection'` (measured on deno 2.6.8), so
 * on Fastify or Express under Deno — pairs this project does not support —
 * neither guard fires, and both say so: on Deno each installs nothing and
 * reports itself not in effect, so a set `header-timeout` or `max-connections`
 * is warned about at `bind()`.  The same shim accepts `keepAliveTimeout` and
 * `requestTimeout` and applies neither, so `idle-timeout` and
 * `request-timeout` are reported not in effect there too.
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
   * On an HTTP/2 listener it is `true` only where the cap reaches an HTTP/2
   * stream's header list too — see {@link headerCapReachesHttp2Streams}.  Under
   * Node it does not: the cap binds the HTTP/1.1 requests sharing the port, and
   * an HTTP/2 stream is bounded only by Node's own 64 KiB header-list limit —
   * measured on node v26.10.0, a 60 KiB header list reached the handler
   * through a 1 KiB cap — so Fastify reports it `false` there, held for
   * HTTP/1.1 only.
   */
  readonly maxHeaderBytes?: boolean;
  /**
   * The fields above reported `false` that do hold for one of the two
   * protocols an HTTP/2 listener speaks, each with the protocol it holds for,
   * so the warning `bind()` logs can say what is bounded rather than claim
   * nothing is.  Present only on an HTTP/2 listener where such a field was set.
   *
   *   - **`idleTimeoutMs` and `requestTimeoutMs` under Bun** hold for HTTP/2,
   *     through {@link enforceSessionIdleTimeout} and
   *     {@link enforceStreamRequestTimeout}, and not for a connection that
   *     negotiates HTTP/1.1 on the same port: Bun's HTTP/2 server reads neither
   *     `keepAliveTimeout` nor `requestTimeout` for one.  Measured on bun 1.4.2
   *     with Fastify over TLS + HTTP/2, a keep-alive HTTP/1.1 connection was
   *     still open 8 s after its response under an 800 ms idle-timeout, and a
   *     stalled HTTP/1.1 body 40 s in under a 2 s request-timeout, where node
   *     closed the first at 1.8 s and answered the second `408` at 30.0 s.
   *   - **`maxHeaderBytes` under Node** holds for HTTP/1.1 — see the field.
   */
  readonly heldForOneProtocol?: {
    readonly [Field in ProtocolHeldBound]?: ListenerProtocol;
  };
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
  /**
   * Present only where the deployment set the idle timeout and the runtime
   * holds it as whole-connection inactivity that can cut a handler before the
   * request deadline has been answered: the earliest moment, in milliseconds
   * after a connection fell silent, at which it can be closed.
   *
   * Hono under Bun is again the one such pair (#1487).  `Bun.serve` checks
   * idleness on a 4 s sweep, so a value of `X` seconds cuts a handler that has
   * written nothing from one sweep before `X` on, and a cut less than 2 s past
   * the deadline closes the connection before its `503` goes out — measured on
   * bun 1.4.2, `idle-timeout = 32s` under the built-in 30 s deadline closed
   * three requests of eight without a byte at 28.5–29.5 s.  `bind()` names the
   * key, the value and the deadline in a warning; the value derived when the
   * key is unset never needs one.
   */
  readonly idleTimeoutEarliestCutMs?: number;
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
  'idleTimeoutMs' | 'headerTimeoutMs' | 'requestTimeoutMs' | 'maxConnections' | 'heldForOneProtocol'
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
  /** See {@link ServerOptionsReport.idleTimeoutEarliestCutMs}. */
  readonly idleTimeoutEarliestCutMs?: number;
  /**
   * The built-in fields reported `false` above that hold for one protocol of
   * an HTTP/2 listener — Fastify's header cap under Node, held for HTTP/1.1.
   * See {@link ServerOptionsReport.heldForOneProtocol}.
   */
  readonly heldForOneProtocol?: ServerOptionsReport['heldForOneProtocol'];
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
  const { heldForOneProtocol: heldAfterListen, ...installed } = installedAfterListen;
  const heldForOneProtocol = {
    ...heldAfterListen,
    // Only for a header cap the policy set: an unset one left nothing to hold.
    ...(options?.maxHeaderBytes !== undefined ? builtIn.heldForOneProtocol : undefined),
  };
  return {
    ...installed,
    // An idle timeout the runtime took at construction holds as surely as one
    // written after `listen()` — `Bun.serve`'s, on the Hono backend (#1487).
    ...(builtIn.idleTimeoutMs === true ? { idleTimeoutMs: true } : {}),
    ...(builtIn.idleTimeoutHeldAtCeilingMs !== undefined ? { idleTimeoutHeldAtCeilingMs: builtIn.idleTimeoutHeldAtCeilingMs } : {}),
    ...(builtIn.idleTimeoutEarliestCutMs !== undefined ? { idleTimeoutEarliestCutMs: builtIn.idleTimeoutEarliestCutMs } : {}),
    // Every shipped backend holds a set body cap: an untouched one adopts it
    // and one built with a different cap was refused before it bound.
    ...(options?.maxContentLength !== undefined ? { maxContentLength: true } : {}),
    ...(options?.maxHeaderBytes !== undefined ? { maxHeaderBytes: builtIn.maxHeaderBytes } : {}),
    ...(Object.keys(heldForOneProtocol).length > 0 ? { heldForOneProtocol } : {}),
  };
}

/**
 * Whether a `maxHeaderSize` an HTTP/2 server was built with also caps an
 * HTTP/2 stream's header list on `runtime`, rather than only the HTTP/1.1
 * requests sharing its port.
 *
 * Measured with Fastify over TLS + HTTP/2 under a 1 KiB cap.  **Bun**: yes —
 * a 4 KiB header list was reset over HTTP/2 and answered `431` over HTTP/1.1,
 * where with no cap 60 KiB went through.  It counts the HTTP/2 way, each field
 * plus 32 bytes with the pseudo-headers included, so a block near the cap
 * that HTTP/1.1 admits can be refused over HTTP/2: a 900-byte header passed
 * HTTP/1.1 and was reset over HTTP/2.  **Node**: no — 900 bytes, 4 KiB and
 * 60 KiB all reached the handler over HTTP/2 while HTTP/1.1 got `431` at
 * 4 KiB.  An HTTP/2 stream there is bounded only by Node's own header-list
 * limit, 63 KiB through and 64 KiB refused, and `settings.maxHeaderListSize =
 * 1024` on the server did not lower it either — so there is no setting to
 * reach for, and the cap is reported held for HTTP/1.1 only.  **Deno** builds
 * no HTTP/2 server for Fastify at all (`createSecureServer` is not
 * implemented in deno 2.6.8), so it answers no.
 */
export function headerCapReachesHttp2Streams(runtime: RuntimeKind = detectRuntime()): boolean {
  return runtime === 'bun';
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
 * **`idleTimeoutMs` and `requestTimeoutMs` are two writes each, because
 * HTTP/2 reads neither property.**  `keepAliveTimeout` bounds an idle HTTP/1.1
 * connection and `requestTimeout` an HTTP/1.1 request's receive; an HTTP/2
 * session and stream consult neither, so on an HTTP/2 listener the settings
 * also reach them through timers of the framework's own — see
 * {@link enforceSessionIdleTimeout} and {@link enforceStreamRequestTimeout}.
 *
 * **Where it does and does not reach** — the honest half, in the shape
 * {@link transportFrameCapOf} uses for the `ws` shim:
 *
 *   - **Fastify** — `this.app.server`.  All four — except on its HTTP/2
 *     listener under Bun, where a connection that negotiates HTTP/1.1 reads
 *     neither `keepAliveTimeout` nor `requestTimeout`: there `idleTimeoutMs`
 *     and `requestTimeoutMs` hold for HTTP/2 only and are reported so, in
 *     {@link ServerOptionsReport.heldForOneProtocol}.
 *   - **Express** — the server the backend builds and listens on: `node:http`,
 *     or `node:https` under `tls`, which carries the same four properties and
 *     events.  All four, on either.
 *   - **Fastify and Express under Deno** — none of the four.  Deno's
 *     `node:http` shim accepts `keepAliveTimeout` and `requestTimeout` and
 *     applies neither: measured on deno 2.6.8 with both backends under
 *     `idle-timeout = 600ms` and `request-timeout = 2s`, a keep-alive
 *     connection was still open 3 s after its response and a stalled body
 *     still open after 40 s with no `408`, where node v26.10.0 and bun 1.4.2
 *     closed the first at 1.6 s and answered the second at 30.0 s.  It emits
 *     no `'connection'` either, so the two guards install nothing.  Each is
 *     reported not in effect, and `bind()` names the ones that were set.
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
  // Bun's HTTP/2 listener hands a connection that negotiated HTTP/1.1 to
  // handling that reads neither `keepAliveTimeout` nor `requestTimeout`, so
  // there the two bounds hold for HTTP/2 alone — through the framework's own
  // halves — and are reported as such rather than as in effect.  A set `0`
  // asks for no bound, which every protocol honours.
  const http1Unbounded = typeof server.updateSettings === 'function' && detectRuntime() === 'bun';
  // Deno's node:http shim accepts `keepAliveTimeout` and `requestTimeout` and
  // applies neither, so a value above `0` is written and reported not in
  // effect there; `0` asks for no bound, which arming nothing honours.
  const timeoutsIgnored = detectRuntime() === 'deno';
  const heldForOneProtocol: { -readonly [Field in ProtocolHeldBound]?: ListenerProtocol } = {};
  if (options.idleTimeoutMs !== undefined) {
    server.keepAliveTimeout = options.idleTimeoutMs;
    enforceSessionIdleTimeout(server, options.idleTimeoutMs);
    if (http1Unbounded && options.idleTimeoutMs > 0) heldForOneProtocol.idleTimeoutMs = 'HTTP/2';
    else report.idleTimeoutMs = !timeoutsIgnored || options.idleTimeoutMs === 0;
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
    report.headerTimeoutMs = headerDeadlineMs > 0 ? enforceHeaderTimeout(server, headerDeadlineMs)().installed : true;
  }
  if (options.requestTimeoutMs !== undefined) {
    server.requestTimeout = options.requestTimeoutMs;
    // `0` is "no bound" on HTTP/2 as it is on HTTP/1.1, so it arms nothing.
    if (options.requestTimeoutMs > 0) enforceStreamRequestTimeout(server, options.requestTimeoutMs);
    if (http1Unbounded && options.requestTimeoutMs > 0) heldForOneProtocol.requestTimeoutMs = 'HTTP/2';
    else report.requestTimeoutMs = !timeoutsIgnored || options.requestTimeoutMs === 0;
  }
  if (options.maxConnections !== undefined && options.maxConnections !== Infinity) {
    server.maxConnections = options.maxConnections;
    // The guard, not the property, is what the report counts: the property is
    // the one some runtimes accept and ignore, and a cap reported in effect on
    // that alone would be the silent failure the report exists to end.
    report.maxConnections = enforceMaxConnections(server, options.maxConnections)().installed;
  }
  return Object.keys(heldForOneProtocol).length > 0 ? { ...report, heldForOneProtocol } : report;
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
 * Bound an idle HTTP/2 session by `idleTimeoutMs` — the HTTP/2 half of
 * `idle-timeout`, whose HTTP/1.1 half is `keepAliveTimeout`.  Idle means no
 * stream open: the timer is armed when the session starts and whenever its
 * last open stream closes, disarmed while any is open, and `close()`s the
 * session when it fires — a GOAWAY on a session with nothing left to finish.
 *
 * **Why a mechanism of its own.**  `keepAliveTimeout` is read by the HTTP/1.1
 * connection handling only: measured on node v26.10.0 and bun 1.4.2, an h2
 * session that completed one request under `keepAliveTimeout = 800` was still
 * open past 5 s, on Fastify and on a bare `http2.createSecureServer({
 * allowHTTP1 })` alike.  The runtime's own session timer — what this used to
 * arm — is three bounds rather than one.  It counts quiet time on the whole
 * connection, so it fired under a handler still working and sent the GOAWAY
 * mid-request.  Bun fires it at twice its value: 1.60 s for 800 ms where node
 * took 0.80 s.  And Bun counts a PING frame as activity, so a client pinging
 * every 300 ms held an idle session open indefinitely — 19 pings and still open
 * at 6 s, where node closed at 0.81 s.  A timer of the framework's own,
 * counting open streams, is the same bound on both runtimes, ignores every
 * frame that is not a request, and is `keepAliveTimeout`'s rule exactly: a
 * slow handler, a long poll or an SSE stream holds its session as it holds an
 * HTTP/1.1 connection, and the bound starts when it ends.  A request whose
 * body never finishes is `request-timeout`'s to cut — see
 * {@link enforceStreamRequestTimeout} — after which the session is idle here.
 *
 * **The runtime's timer is cleared** with `setTimeout(0)`, so the configured
 * value is the one that governs: Fastify arms one from a `'session'` listener
 * of its own, registered at construction and so ahead of this one — 72 s,
 * which Bun's doubling makes 144 s — and a longer `idle-timeout` would
 * otherwise be cut short by it.  `0` stops there, which is the documented "0
 * disables it" on HTTP/2 too: no idle bound at all.
 *
 * A session that cannot report its streams falls back to the runtime's timer,
 * the one shape that still bounds it.  A stream that cannot report its close
 * is not counted, so it cannot hold the session open for ever.  Unreferenced,
 * so an idle session never holds the process up on its own.  A server that
 * emits no `'session'` — every HTTP/1.1-only listener — is subscribed and
 * never called, which costs one listener.  `hostTimers` is the seam a test
 * fires the timer through.
 */
export function enforceSessionIdleTimeout(
  server: NodeHttpServerLike,
  idleTimeoutMs: number,
  hostTimers: HostTimers = unreferencedHostTimers,
): void {
  if (typeof server.on !== 'function') return;
  server.on('session', (session) => {
    session.setTimeout(0);
    if (idleTimeoutMs === 0) return;
    if (typeof session.on !== 'function') {
      session.setTimeout(idleTimeoutMs, () => { session.close(); });
      return;
    }
    let openStreams = 0;
    let idle: Cancellable | undefined;
    const arm = (): void => { idle = armChainedTimeout(() => { session.close(); }, idleTimeoutMs, hostTimers); };
    const disarm = (): void => {
      idle?.cancel();
      idle = undefined;
    };
    arm();
    session.on('stream', (opened: unknown) => {
      const stream = opened as { once?: (event: 'close', listener: () => void) => unknown } | null | undefined;
      if (typeof stream?.once !== 'function') return;
      openStreams++;
      disarm();
      stream.once('close', () => {
        openStreams--;
        if (openStreams === 0) arm();
      });
    });
    session.once?.('close', disarm);
  });
}

/**
 * The slice of a server-side HTTP/2 stream {@link enforceStreamRequestTimeout}
 * reads and ends — `node:http2`'s `ServerHttp2Stream` on Node, Bun's own on
 * Bun, which carry every member alike (measured on node v26.10.0 and bun
 * 1.4.2).
 */
export type Http2StreamLike = {
  /** True when the request's HEADERS frame ended the stream: a request with no body. */
  readonly endAfterHeaders?: boolean;
  /**
   * The protocol state of the stream.  `remoteClose` is `1` once the client
   * has sent END_STREAM — whether or not anything has read the body, which is
   * why it is asked rather than the readable side's `'end'`.
   */
  readonly state?: { readonly remoteClose?: number };
  readonly headersSent?: boolean;
  /** Whether the response has been ended — its last frame written or queued. */
  readonly writableEnded?: boolean;
  readonly closed?: boolean;
  readonly destroyed?: boolean;
  respond: (headers: Readonly<Record<string, string | number>>, options?: { readonly endStream?: boolean }) => void;
  /** Send RST_STREAM with `code`, once what is queued has gone when that is `NO_ERROR`. */
  close: (code?: number) => void;
  once: (event: 'close', listener: () => void) => unknown;
};

/**
 * RST_STREAM error codes, RFC 9113 §7: `NO_ERROR` asks a client to stop
 * sending a request that has been answered in full; `CANCEL` says the stream
 * is no longer wanted.
 */
const HTTP2_NO_ERROR = 0x0;
const HTTP2_CANCEL = 0x8;

/**
 * Bound the receive of each HTTP/2 stream by `requestTimeoutMs` — the HTTP/2
 * half of `request-timeout`, whose HTTP/1.1 half is the runtime's
 * `requestTimeout` sweep.
 *
 * **Why a mechanism of its own.**  `requestTimeout` is read by the HTTP/1.1
 * connection handling only, and nothing at the session level can stand in for
 * it.  Measured on node v26.10.0 and bun 1.4.2 with the framework-built
 * Fastify over TLS + HTTP/2, `request-timeout = 2s` and `idle-timeout =
 * 800ms`: a POST that announced 1000 bytes and sent 10 was still open 12 s
 * later on both, as was a body trickled every 500 ms.  The session's idle
 * timer sent its GOAWAY for the stalled one and then, by design, let the open
 * stream finish; the trickled one never let the timer fire.  Cutting the
 * session some grace period after its GOAWAY was the other shape on the
 * table, and it bounds neither a trickle nor anything when the idle timeout
 * is unset — and it would cut a long poll the HTTP/1.1 rules leave alone.
 *
 * **What it bounds is the request, never the response.**  The deadline is
 * armed when a stream opens and spent once the client has finished sending:
 * a request with no body never arms one, and one whose client has sent
 * END_STREAM by the deadline is left to its handler however long that takes
 * — the HTTP/1.1 rule, where `requestTimeout` bounds the receive.  Finished
 * sending is the protocol's answer, not a reader's: a five-byte body nothing
 * read never emits `'end'`, and was rightly left alone on both runtimes.
 *
 * **At the deadline**, a stream still receiving is answered `408` and reset
 * with `NO_ERROR`, the RFC's way to stop a client sending a request that has
 * been answered (§8.1).  One the handler already answered in full keeps that
 * answer and is reset the same way; one whose answer is still being written is
 * reset with `CANCEL`, so a half-written answer is not presented as complete.
 * The stream goes and the session stays: other streams on it are someone
 * else's requests, and a session with nothing open is `idle-timeout`'s to
 * close.
 *
 * Armed through {@link armChainedTimeout}, because `request-timeout` may be
 * as long as 2^32 - 1 ms and a host timer armed with more than 2^31 - 1 fires
 * after 1 ms on Bun and Node.  Unreferenced, as the header deadline is, so an
 * open stream never holds the process up on its own.
 *
 * A server that emits no `'stream'` — every HTTP/1.1-only listener — is
 * subscribed and never called, which costs one listener.  `hostTimers` is the
 * seam a test fires the deadline through.
 */
export function enforceStreamRequestTimeout(
  server: NodeHttpServerLike,
  requestTimeoutMs: number,
  hostTimers: HostTimers = unreferencedHostTimers,
): void {
  if (typeof server.on !== 'function') return;
  server.on('stream', (stream: unknown) => {
    if (!isHttp2Stream(stream) || requestReceivedInFull(stream)) return;
    const deadline = armChainedTimeout(() => { expireStreamRequest(stream); }, requestTimeoutMs, hostTimers);
    stream.once('close', () => { deadline.cancel(); });
  });
}

/** Whether `candidate` offers what {@link enforceStreamRequestTimeout} calls; anything else is not its to bound. */
function isHttp2Stream(candidate: unknown): candidate is Http2StreamLike {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const { respond, close, once } = candidate as Partial<Http2StreamLike>;
  return typeof respond === 'function' && typeof close === 'function' && typeof once === 'function';
}

/**
 * Whether the client has finished sending.  A state that cannot be read
 * counts as unfinished: the deadline then holds rather than lapses.
 */
function requestReceivedInFull(stream: Http2StreamLike): boolean {
  if (stream.endAfterHeaders === true) return true;
  try {
    return stream.state?.remoteClose === 1;
  } catch {
    return false;
  }
}

function expireStreamRequest(stream: Http2StreamLike): void {
  if (stream.closed === true || stream.destroyed === true || requestReceivedInFull(stream)) return;
  try {
    if (stream.headersSent !== true) {
      stream.respond({ ':status': 408 }, { endStream: true });
      stream.close(HTTP2_NO_ERROR);
      return;
    }
    stream.close(stream.writableEnded === true ? HTTP2_NO_ERROR : HTTP2_CANCEL);
  } catch {
    // A stream that went away between the checks above and the write: the
    // cut is what was wanted, so make sure of it and say nothing.
    try { stream.close(HTTP2_CANCEL); } catch { /* already gone */ }
  }
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
 * Returns a live {@link HeaderDeadlineReport} reader rather than a boolean, the
 * shape {@link enforceMaxConnections} has: whether the guard was installed —
 * whether the server offers `on`, on a runtime that emits the events it rests
 * on — so a server that cannot host it reports itself rather than pretending,
 * which is what {@link ServerOptionsReport.headerTimeoutMs} counts; and how
 * many deadlines the endpoint map holds, which is the one way to see that it
 * empties.  Nothing else does: an entry `settle` failed to drop holds its
 * socket for the life of the server and changes no answer the guard gives, so
 * a leak there is invisible to every behaviour a test can observe.
 */
export function enforceHeaderTimeout(server: NodeHttpServerLike, deadlineMs: number): () => HeaderDeadlineReport {
  if (typeof server.on !== 'function') return HEADER_DEADLINE_NOT_INSTALLED;
  // Deno emits neither 'connection' nor 'secureConnection', so a deadline
  // installed there would never be armed (see above).
  if (detectRuntime() === 'deno') return HEADER_DEADLINE_NOT_INSTALLED;
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
  return () => ({ installed: true, endpointEntries: byEndpoint.size });
}

/**
 * What {@link enforceHeaderTimeout} holds, read when asked rather than copied
 * at install time.
 */
export type HeaderDeadlineReport = {
  /** `false` when the server offers no `on`, or the runtime emits none of the events the guard rests on. */
  readonly installed: boolean;
  /**
   * Deadlines filed under their connection's endpoint pair right now — one per
   * accepted connection that has neither completed a header block, closed,
   * nor expired, so it is back at zero once every connection has settled.
   */
  readonly endpointEntries: number;
};

/** The reader a server that cannot host the guard gets: installed nowhere, holding nothing. */
const HEADER_DEADLINE_NOT_INSTALLED = (): HeaderDeadlineReport => ({ installed: false, endpointEntries: 0 });

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
 * Deno is where the event runs out altogether: its `node:http` and
 * `node:https` emit no `'connection'`, so a cap installed there counts nothing.
 * Measured on deno 2.6.8 through {@link applyServerOptions} with a cap of one: a
 * second kept-alive connection was answered while the first was still open —
 * node v26.10.0 and bun 1.4.2 refused it — while this reported the cap
 * installed and `bind()` therefore had nothing to warn about.  The shim offers
 * `on` like any server, so the event hook cannot tell; the runtime can, and on
 * Deno nothing is installed, as {@link enforceHeaderTimeout} does there too.
 *
 * Returns a live {@link ConnectionCapReport} reader rather than a boolean: a
 * server object without `on` — the `Bun.serve` and `Deno.serve` handles Hono
 * exposes — and any server on Deno report `installed: false` rather than
 * pretending, and the three counters beside it are what let a failing cap say
 * which half is missing.
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
  // Deno emits no 'connection', so a cap installed there would never count a
  // connection (see above).
  if (detectRuntime() === 'deno') return report;
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
