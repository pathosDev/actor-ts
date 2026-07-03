import type { HttpMethod, HttpRequest, HttpResponse } from '../types.js';
import type { WebSocketSocketAdapter } from '../ws/SocketAdapter.js';

/** One route registration — supplied by the DSL after compilation. */
export interface RouteRegistration {
  readonly method: HttpMethod;
  /** Path pattern in the Fastify/Express style: `/users/:id` */
  readonly pattern: string;
  readonly handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;
}

/**
 * One WebSocket route registration.  The backend accepts the HTTP
 * upgrade at `pattern` (a GET), MUST call `authorize` first (a non-null
 * result means: send that plain HTTP response and DO NOT upgrade), and
 * then call `onConnection` exactly once — **synchronously** inside its
 * native open/upgrade callback — handing over a normalised socket.
 * Everything actor-related lives behind `onConnection`; the backend
 * never sees the framework's actors.
 */
export interface WebSocketRouteRegistration {
  /** ':param'-style pattern, same dialect as {@link RouteRegistration.pattern}. */
  readonly pattern: string;
  /** Pre-upgrade guard.  `null` → proceed; `HttpResponse` → reject with it. */
  readonly authorize: (req: HttpRequest) => Promise<HttpResponse | null>;
  /** Called once per accepted connection, synchronously in the upgrade callback. */
  readonly onConnection: (req: HttpRequest, socket: WebSocketSocketAdapter) => void;
}

export interface ServerBinding {
  readonly host: string;
  readonly port: number;
  /** Stop the server; waits up to `gracePeriodMs` for in-flight requests. */
  unbind(gracePeriodMs?: number): Promise<void>;
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

  /** Optionally register a catch-all not-found handler. */
  setNotFound?(handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse): void;

  /** Optionally register a global error handler. */
  setErrorHandler?(handler: (err: unknown, req: HttpRequest) => Promise<HttpResponse> | HttpResponse): void;

  /**
   * Optional capability: register a WebSocket endpoint.  Backends that
   * implement this support `websocket()` routes; absence is detected by
   * `HttpExtension.bind` and reported as a clear error.
   */
  registerWebSocket?(reg: WebSocketRouteRegistration): void;
}
