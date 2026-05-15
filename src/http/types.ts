/**
 * Shared HTTP types.  Kept small and backend-agnostic: the Route DSL works
 * only with these shapes, and the different backends (Fastify, BunServe,
 * Express) translate to/from their native APIs.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | string[] | undefined>>;
  /** Path parameters extracted from `/users/:id` patterns. */
  readonly params: Readonly<Record<string, string>>;
  /** Raw bytes of the request body (undefined for GET / HEAD). */
  readonly body: Uint8Array | null;
  /**
   * Optional remote IP address of the client as the server saw it
   * (NOT the value of `x-forwarded-for` — that's a header the client
   * can spoof unless a trusted proxy stripped + replaced it).  Backends
   * SHOULD populate this from the underlying socket peer; consumers
   * that need to trust a forwarded header MUST do so explicitly (see
   * `IpAllowlist`'s `getClientIp` option).
   */
  readonly remoteAddress?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Body — if string or JSON object, the marshaller adds Content-Type. */
  readonly body?: string | Uint8Array | object | null;
  /** Forced content-type.  Overrides whatever the marshaller picks. */
  readonly contentType?: string;
}

/** Named HTTP status codes for callers that don't want magic numbers. */
export const Status = {
  OK: 200,
  Created: 201,
  Accepted: 202,
  NoContent: 204,
  MovedPermanently: 301,
  Found: 302,
  NotModified: 304,
  BadRequest: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  Conflict: 409,
  UnsupportedMediaType: 415,
  /** Used by the idempotency-key middleware when the same key is reused with a different body. */
  UnprocessableEntity: 422,
  TooManyRequests: 429,
  InternalServerError: 500,
  BadGateway: 502,
  ServiceUnavailable: 503,
} as const;

/** Error thrown from inside a handler to produce a 4xx/5xx with details. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly extra?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
