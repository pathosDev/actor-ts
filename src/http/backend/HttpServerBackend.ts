import type { HttpMethod, HttpRequest, HttpResponse } from '../types.js';

/** One route registration — supplied by the DSL after compilation. */
export interface RouteRegistration {
  readonly method: HttpMethod;
  /** Path pattern in the Fastify/Express style: `/users/:id` */
  readonly pattern: string;
  readonly handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;
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
}
