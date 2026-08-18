/**
 * Shared HTTP types.  Kept small and backend-agnostic: the Route DSL works
 * only with these shapes, and the different backends (Fastify, Express,
 * Hono) translate to/from their native APIs.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export type HttpRequest = {
  readonly method: HttpMethod;
  /**
   * The **pathname only** — `/orders/42`, never `/orders/42?page=2`.
   * The query lives in `query`, already parsed; a backend that receives
   * a raw request target splits it before handing the request over.
   * Every backend must normalise to this shape, because anything built
   * by appending to `path` — the static-file directory redirect, the
   * DevTools shell redirect, a directory-listing heading, an
   * idempotency fingerprint — is otherwise silently wrong on one
   * backend and right on the next.
   *
   * Percent-escapes are NOT decoded here: decoding is the consumer's
   * job and must happen once, before validation (see
   * `resolveStaticPath`), so that an encoded traversal cannot slip past
   * a check performed on the decoded form.
   */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | string[] | undefined>>;
  /** Path parameters extracted from `/users/:id` patterns. */
  readonly params: Readonly<Record<string, string>>;
  /** Raw bytes of the request body (undefined for GET / HEAD). */
  readonly body: Uint8Array | null;
  /**
   * Optional remote IP address of the client as the server saw it
   * (NOT the value of `x-forwarded-for` — that's a header the client can
   * spoof, and one every common proxy *appends* to rather than replacing,
   * so no fixed position in it is trustworthy either).  Backends SHOULD
   * populate this from the underlying socket peer; a consumer that needs
   * the client's own address from behind a proxy MUST say which proxies it
   * trusts (see `IpAllowlist`'s `trustedProxies` option), because that is
   * the only thing that makes a position in the chain meaningful.
   */
  readonly remoteAddress?: string;
};

export type HttpResponse = {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Body.  A string or plain object is marshalled (JSON) with a
   * Content-Type; a `Uint8Array` or web `ReadableStream` is sent as raw
   * bytes (default `application/octet-stream`).  Streams are one-shot, so
   * the caching middleware must not wrap a streaming response.
   */
  readonly body?: string | Uint8Array | ReadableStream<Uint8Array> | object | null;
  /** Forced content-type.  Overrides whatever the marshaller picks. */
  readonly contentType?: string;
};

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
    /**
     * Response headers to emit alongside the error — e.g.
     * `WWW-Authenticate` on a 401 or `Retry-After` on a 429.  Without
     * this the value could only reach the body (`extra`), never the
     * wire as a real header.  Names SHOULD be lower-case; backends emit
     * them verbatim after the status and before the body.
     */
    public readonly headers?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
