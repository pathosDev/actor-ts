import type { HttpMethod, HttpRequest, HttpResponse } from '../Types.js';
import type { WebsocketSocketAdapter } from '../websocket/SocketAdapter.js';

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
 * Pluggable HTTP server abstraction.  Backends translate our generic
 * route registrations to their native framework (Fastify, Bun.serve,
 * Express, …).  The DSL only ever talks to this interface.
 */
export interface HttpServerBackend {
  readonly name: string;

  /** Register all routes before `listen` is called.  Duplicate paths must be rejected. */
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
