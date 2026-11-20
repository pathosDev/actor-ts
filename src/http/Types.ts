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
   * The **socket peer** — the address of whatever opened the TCP
   * connection — on all three backends (Fastify, Express, Hono).  No
   * forwarding header is consulted, so behind a reverse proxy this is the
   * proxy, not the client.  (Nor should it be `x-forwarded-for`: that is a
   * header the client can spoof, and one every common proxy *appends* to
   * rather than replacing, so no fixed position in it is trustworthy.)
   *
   * A consumer that needs the client's own address from behind a proxy
   * MUST say which proxies it trusts, because that is the only thing that
   * makes a position in the chain meaningful.  The supported way is
   * `clientIpResolver(trustedProxies)` (`http/middleware/ClientIp.ts`,
   * #1236) — the same walk `IpAllowlist`'s `trustedProxies` option runs —
   * for a rate-limit key, a log line or anything else.
   */
  readonly remoteAddress?: string;
  /**
   * Values a middleware established for the handlers inside it — the claims
   * `JwtAuth` verified, for instance — by key name.  Read and write them
   * through `attribute(request, key)` / `withAttribute(request, key, value)`
   * (see `RequestAttributes.ts`), never by indexing this record.
   *
   * A field of the request rather than a header, because a header is client
   * input: a value a middleware forwards as a header is indistinguishable,
   * on a route that middleware does not wrap, from the same header sent by
   * the client.  Nothing a client sends can become an attribute — backends
   * never set this field, so only server code inside the chain can.
   *
   * An own enumerable property, so it rides through every `{ ...request }`
   * a middleware builds when it replaces the request with `next(override)`.
   * HTTP routes only: a `websocket()` route's connect handler is handed the
   * upgrade request the backend adapted, not the one the middleware passed on.
   */
  readonly attributes?: Readonly<Record<string, unknown>>;
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
  /** A request body over the cap — the server-wide one, or a streamed route's own (#1868). */
  PayloadTooLarge: 413,
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

/**
 * The request a `streamedBody()` route's handler receives (#1868): everything
 * an {@link HttpRequest} carries, except that the body has not been read.
 *
 * `body` is pull-driven with a high-water mark of zero, so the server reads
 * nothing off the connection ahead of the handler's own reads, and the
 * client is held back by the transport's flow control in between.  It errors
 * with {@link RequestBodyTooLargeError} once more bytes arrive than the
 * route's `maxBytes`, and with {@link RequestBodyAbortedError} when the client
 * goes away mid-body.  Cancelling it is how a handler says it wants no more
 * of the body; the server then closes the connection after the response
 * rather than reading the remainder.
 *
 * Not assignable to {@link HttpRequest} and the other way round, on purpose:
 * a buffered handler is never handed a stream, and `entity(request)` on a
 * streamed request is a compile error rather than a `400 Missing request
 * body` at run time.
 */
export type StreamedHttpRequest = Omit<HttpRequest, 'body'> & {
  readonly body: ReadableStream<Uint8Array>;
  /** The declared `Content-Length`, when the client sent one; absent for a chunked body. */
  readonly contentLength?: number;
};

/**
 * What a streamed request body errors with once more bytes arrived than the
 * route admits — counted, not declared: a declared `Content-Length` over the
 * limit is answered 413 before the handler runs.
 *
 * An {@link HttpError} with status 413, so a handler that lets it propagate
 * answers `413 Payload Too Large` through the ordinary error mapping, and one
 * that catches it can still answer something else.
 */
export class RequestBodyTooLargeError extends HttpError {
  constructor(public readonly maxBytes: number) {
    super(Status.PayloadTooLarge, `request body exceeds ${maxBytes} bytes`, { maxBytes });
    this.name = 'RequestBodyTooLargeError';
  }
}

/**
 * What a streamed request body errors with when the client aborts or resets
 * the request before the body ended — the signal for a handler to abandon
 * the upstream work the body was feeding.
 *
 * An {@link HttpError} (400) rather than a plain `Error`, so a handler that
 * lets it propagate is not logged as a server fault: nothing the server did
 * caused it, and the client is usually no longer there to read the answer.
 */
export class RequestBodyAbortedError extends HttpError {
  constructor(cause?: unknown) {
    super(Status.BadRequest, 'request body aborted by the client');
    this.name = 'RequestBodyAbortedError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}
