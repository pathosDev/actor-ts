import { DEFAULT_WEBSOCKET_MAX_FRAME_BYTES } from '../Constants.js';
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

  /** Start listening.  Returns a ServerBinding with the actual bound port. */
  listen(host: string, port: number): Promise<ServerBinding>;

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
