/**
 * How a streamed request body travels from the backend that accepted the
 * request, through the middleware wrapped around its route, to the
 * `streamedBody()` handler at the end of the chain (#1868).
 *
 * Middleware is typed against {@link HttpRequest}, whose `body` is bytes or
 * `null`.  A streamed route hands it exactly that — `body: null`, because no
 * byte has been read — and carries the stream beside it in a symbol-keyed own
 * property.  Own and enumerable, like `attributes`, so it rides through every
 * `{ ...request }` a middleware builds for `next(override)`; symbol-keyed, so
 * it is invisible to `Object.keys`, to JSON and to code that does not hold the
 * symbol.  The handler wrapper `streamedBody()` compiles to is the one place
 * that takes it back out and builds the {@link StreamedHttpRequest} the
 * handler is typed against.
 *
 * Internal: the barrel exports none of this, so nothing outside the framework
 * can attach a stream to a buffered route's request.
 */
import type { HttpRequest, StreamedHttpRequest } from './Types.js';

/** The streamed half of a request: the unread body and its declared length. */
export type StreamedBody = {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentLength?: number;
};

const STREAMED_BODY: unique symbol = Symbol('actor-ts.streamed-request-body');

type CarryingRequest = HttpRequest & { readonly [STREAMED_BODY]?: StreamedBody };

/** `request` with its body left unread — `body: null` — and `streamed` carried beside it. */
export function withStreamedBody(request: HttpRequest, streamed: StreamedBody): HttpRequest {
  const carrying: CarryingRequest = { ...request, body: null, [STREAMED_BODY]: streamed };
  return carrying;
}

/** The streamed body `request` carries, if a backend attached one. */
export function streamedBodyOf(request: HttpRequest): StreamedBody | undefined {
  return (request as CarryingRequest)[STREAMED_BODY];
}

/**
 * The {@link StreamedHttpRequest} a `streamedBody()` handler receives, built
 * from the request the innermost middleware passed on.
 *
 * Throws when the request carries no stream.  Two ways to get there, both
 * defects to name rather than to paper over with an empty body: a backend
 * that does not stream request bodies (bind refuses that one before it
 * listens), and a middleware that replaced the request with an object of its
 * own instead of spreading the one it was given.
 */
export function toStreamedRequest(request: HttpRequest): StreamedHttpRequest {
  const streamed = streamedBodyOf(request);
  if (streamed === undefined) {
    throw new Error(
      'streamedBody(): the request reached the handler without its body stream.  A middleware around this route '
      + 'passed next() a request it built from scratch — build it as { ...request, … } so the stream rides along.',
    );
  }
  const { body: _unread, ...rest } = request;
  return {
    ...rest,
    body: streamed.body,
    ...(streamed.contentLength !== undefined ? { contentLength: streamed.contentLength } : {}),
  };
}
