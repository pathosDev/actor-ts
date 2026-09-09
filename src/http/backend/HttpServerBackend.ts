import { DEFAULT_WEBSOCKET_MAX_FRAME_BYTES } from '../Constants.js';
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
   * The server events the two guards below subscribe to, so the cap and the
   * header deadline are held in this repository rather than delegated — see
   * {@link enforceMaxConnections} and {@link enforceHeaderTimeout} for why.
   * A function-typed property rather than a method signature, so this stays a
   * data shape; the intersection is how a data shape spells an overload.
   *
   * `'request'` and `'upgrade'` take their arguments as `unknown` on purpose.
   * They are the two ways a header block finishes and their shapes differ —
   * `(request, response)` against `(request, socket, head)` — while the only
   * thing wanted from either is the socket, which
   * {@link enforceHeaderTimeout} recognises by identity rather than by
   * position.  Naming the runtime's own types here would be a second, weaker
   * copy of `node:http`'s for no gain.
   */
  on?: ((event: 'connection', listener: (socket: ServerSocketLike) => void) => unknown)
    & ((event: 'request' | 'upgrade', listener: (...args: ReadonlyArray<unknown>) => void) => unknown);
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
};

/** Which fields {@link applyServerOptions} actually wrote.  @internal */
export type AppliedServerOptions = {
  readonly idleTimeoutMs: boolean;
  readonly headerTimeoutMs: boolean;
  readonly requestTimeoutMs: boolean;
  readonly maxConnections: boolean;
};

const APPLIED_NOTHING: AppliedServerOptions = Object.freeze({
  idleTimeoutMs: false,
  headerTimeoutMs: false,
  requestTimeoutMs: false,
  maxConnections: false,
});

/**
 * Install a resolved `actor-ts.http.server` policy on the server a backend
 * just started listening on, and report what actually took.
 *
 * **Why post-listen and not at construction.**  All four are plain mutable
 * properties that the runtime re-reads per connection, so writing them after
 * `listen()` reaches every future connection — which is what lets one policy,
 * resolved once at `bind()`, cover a backend the framework built *and* a
 * backend the application constructed and passed to `useBackend(...)`.  The
 * knobs that are *factory* options instead — `maxHeaderSize`, Fastify's
 * `bodyLimit`, `connectionsCheckingInterval` — cannot be reached this way and
 * deliberately ship no key (#667 owns the seam they need).
 *
 * **An unset field is left alone, never defaulted here.**  `idleTimeoutMs` and
 * `maxConnections` ship no value precisely so the backend's own choice
 * survives, and writing `undefined` onto `keepAliveTimeout` would replace
 * Fastify's deliberate 72 s with `NaN` semantics rather than with nothing.
 *
 * **Where it does and does not reach** — the honest half, in the shape
 * {@link transportFrameCapOf} uses for the `ws` shim:
 *
 *   - **Fastify** — `this.app.server`.  All four.
 *   - **Express** — the `Server` returned by `app.listen`.  All four.
 *   - **Hono on Node** — `@hono/node-server` hands its `node:http` server back
 *     as `HonoServerHandle.raw`.  All four.
 *   - **Hono on Bun**, **Hono on Deno** — `Bun.serve` and `Deno.serve` expose
 *     no server object and no equivalent knob, so `raw` is absent and **none
 *     of the four is installed**.  Bun has a whole-connection `idleTimeout`
 *     on `Bun.serve` (in *seconds*), which is close enough to be tempting and
 *     different enough to be wrong; wiring it needs the clamp and the unit
 *     conversion that a `number` cannot carry, and it is not done here.
 *
 * Passing an absent server is therefore ordinary, not an error: it is how the
 * two unsupported pairs report themselves, and the return value says so.
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
 * answered `408` and closed at 30.0 s, and `0` left the connection open past
 * 45 s.  `keepAliveTimeout` is not swept and is exact; `headersTimeout` is not
 * swept either, because it is no longer the runtime that enforces it — see
 * {@link enforceHeaderTimeout}.
 */
export function applyServerOptions(
  server: NodeHttpServerLike | null | undefined,
  options: Partial<HttpServerOptionsType> | undefined,
): AppliedServerOptions {
  if (!server || !options) return APPLIED_NOTHING;
  const applied = {
    idleTimeoutMs: false,
    headerTimeoutMs: false,
    requestTimeoutMs: false,
    maxConnections: false,
  };
  if (options.idleTimeoutMs !== undefined) {
    server.keepAliveTimeout = options.idleTimeoutMs;
    applied.idleTimeoutMs = true;
  }
  if (options.headerTimeoutMs !== undefined) {
    server.headersTimeout = options.headerTimeoutMs;
    applied.headerTimeoutMs = true;
    // `0` is the documented opt-out, and arming a zero-length deadline would
    // read it as "close every connection at once" — the exact inversion of
    // what it asks for.  Same "not folded into `applied`" reasoning as the
    // connection cap below.
    if (options.headerTimeoutMs > 0) enforceHeaderTimeout(server, options.headerTimeoutMs);
  }
  if (options.requestTimeoutMs !== undefined) {
    server.requestTimeout = options.requestTimeoutMs;
    applied.requestTimeoutMs = true;
  }
  if (options.maxConnections !== undefined && options.maxConnections !== Infinity) {
    server.maxConnections = options.maxConnections;
    applied.maxConnections = true;
    // Deliberately not folded into `applied`, which reports which fields the
    // policy *wrote*: the guard is a second, independent enforcement of the
    // field just written, and a server that cannot host it has still had the
    // property set.
    enforceMaxConnections(server, options.maxConnections);
  }
  return applied;
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
 * complete request there fires `'request'` and nothing else — so on Deno there
 * is no seam and this returns `false`, the same way an absent `on` does.
 *
 * `'upgrade'` is not an optional extra: a WebSocket handshake completes its
 * headers and then holds the socket open for hours, so a deadline that only
 * watched `'request'` would tear down every WebSocket connection one header
 * timeout after it opened.
 *
 * The deadline is per **connection**, not per request: it bounds the window
 * from accept to the first complete header block, which is the shape of the
 * attack.  A later request on a kept-alive connection is bounded by
 * `idle-timeout` and by the runtime's own `headersTimeout` where that works.
 *
 * The cost is one timer per accepted connection, cleared on the first request.
 * That is the price of not delegating; the runtime's sweep is cheaper and, on
 * two runtimes out of three, imaginary.
 *
 * Returns whether the guard was installed, so a server that cannot host it
 * reports itself rather than pretending.
 */
export function enforceHeaderTimeout(server: NodeHttpServerLike, deadlineMs: number): boolean {
  if (typeof server.on !== 'function') return false;
  // Weak because a socket that closes before its headers complete must not be
  // held alive by the bookkeeping meant to hang up on it.
  const armed = new WeakMap<object, ReturnType<typeof setTimeout>>();
  const disarm = (candidate: unknown): boolean => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const timer = armed.get(candidate);
    if (timer === undefined) return false;
    clearTimeout(timer);
    armed.delete(candidate);
    return true;
  };
  const onHeadersComplete = (...args: ReadonlyArray<unknown>): void => {
    // `'request'` hands (request, response) and `'upgrade'` hands (request,
    // socket, head), so the socket is at a different index in each — and on a
    // runtime this repository has not measured, at neither.  Trying every
    // argument, and the `.socket` of every argument, finds it by identity in
    // all three shapes and cannot mistake a foreign object for one of ours.
    for (const argument of args) {
      if (disarm(argument)) return;
      if (disarm((argument as { socket?: unknown } | null | undefined)?.socket)) return;
    }
  };
  server.on('connection', (socket) => {
    const timer = setTimeout(() => {
      armed.delete(socket);
      // `end` first so the peer learns why, `destroy` after so it goes even if
      // the write cannot flush.  Measured on bun 1.4.0 and node v26.7.0: the
      // client receives the full status line in that order.
      socket.end?.(HEADER_TIMEOUT_RAW_RESPONSE);
      socket.destroy();
    }, deadlineMs);
    // Unreferenced, or an idle server with one open connection would hold the
    // process up for a header timeout after everything else had finished.
    (timer as { unref?: () => void }).unref?.();
    armed.set(socket, timer);
    socket.once?.('close', () => { disarm(socket); });
  });
  server.on('request', onHeadersComplete);
  server.on('upgrade', onHeadersComplete);
  return true;
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
   */
  listen(host: string, port: number, serverOptions?: Partial<HttpServerOptionsType>): Promise<ServerBinding>;

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
