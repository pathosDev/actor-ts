/**
 * `streamedBody()` — the route-level opt-in to a request body read as a
 * stream (#1868).
 *
 *     const uploadLimit = StreamedBodyOptions.create().withMaxBytes(25 * 1024 * 1024);
 *     path('files', path(':id', put(streamedBody(uploadLimit, async (request) => {
 *       if (!validToken(request.query.token)) return complete(Status.Unauthorized);
 *       await store.put(request.params.id, request.body, request.contentLength);
 *       return complete(Status.Created);
 *     }))));
 *
 * The handler runs before any body byte is read: method, path, params, query
 * and headers are there, and the body is a pull-driven stream (see
 * {@link StreamedHttpRequest}).  A handler that answers without reading it
 * costs the server nothing beyond the headers — the connection is closed
 * rather than the remainder read, unless that remainder is declared and small.
 *
 * Passed to `put` / `post` / `patch` / `del` in place of a handler, rather than
 * wrapped around a finished route, because the handler's own type is what
 * changes: a `streamed(options, put(handler))` could only check at run time
 * that `handler` expected a stream.
 */
import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import {
  DEFAULT_STREAMED_BODY_MAX_BYTES,
  type StreamedBodyOptions,
  type StreamedBodyOptionsType,
  StreamedBodyOptionsValidator,
} from './StreamedBodyOptions.js';
import type { HttpResponse, StreamedHttpRequest } from './Types.js';

/** A handler for a streamed route: it gets the unread body as a stream. */
export type StreamedBodyHandler = (request: StreamedHttpRequest) => Promise<HttpResponse> | HttpResponse;

/**
 * What `streamedBody()` returns and the method combinators accept beside a
 * plain handler.  An object, not a function, so it can never be mistaken for
 * a buffered handler — and so a wrapper typed against buffered handlers, such
 * as `idempotent()` or `cached()`, cannot be put around it.
 */
export type StreamedBodyRoute = {
  readonly kind: 'streamed-body';
  readonly options: Partial<StreamedBodyOptionsType>;
  readonly handler: StreamedBodyHandler;
};

/** What a compiled streamed route carries to the backend: its resolved limit. */
export type ResolvedStreamedBody = {
  readonly maxBytes: number;
};

/** Opt a route into a streamed request body, under `actor-ts.http.streamed-body` and the built-in limit. */
export function streamedBody(handler: StreamedBodyHandler): StreamedBodyRoute;
/** Opt a route into a streamed request body, with its own limit. */
export function streamedBody(options: StreamedBodyOptions, handler: StreamedBodyHandler): StreamedBodyRoute;
export function streamedBody(
  first: StreamedBodyOptions | StreamedBodyHandler,
  second?: StreamedBodyHandler,
): StreamedBodyRoute {
  if (typeof first === 'function') return { kind: 'streamed-body', options: {}, handler: first };
  if (second === undefined) throw new TypeError('streamedBody(options, handler): the handler is missing.');
  // A snapshot: the route is compiled at bind(), and a builder the caller
  // keeps changing after this line should not move the limit under it.
  return { kind: 'streamed-body', options: { ...(first as Partial<StreamedBodyOptionsType>) }, handler: second };
}

/**
 * The `actor-ts.http.streamed-body` layer, as a partial — an unset leaf is
 * left out, so the built-in default below it is reached rather than shadowed.
 * `max-bytes` is read with `getBytes`, so `64MiB` and a bare byte count both
 * work; validation is left to the merged result.
 */
export function readStreamedBodyOptionsFromConfig(config: Config): Partial<StreamedBodyOptionsType> {
  const keys = ConfigKeys.http.streamedBody;
  if (!config.hasPath(keys.root)) return {};
  const out: { -readonly [K in keyof StreamedBodyOptionsType]: StreamedBodyOptionsType[K] } = {};
  if (config.hasPath(keys.maxBytes)) out.maxBytes = config.getBytes(keys.maxBytes);
  return out;
}

/**
 * A streamed route's limit under `config`: the route's options > HOCON > the
 * built-in {@link DEFAULT_STREAMED_BODY_MAX_BYTES}, validated once on the
 * merged result.  Without a `config` — a tree compiled outside `bind()` — the
 * HOCON layer is skipped.
 */
export function resolveStreamedBody(options: Partial<StreamedBodyOptionsType>, config: Config | undefined): ResolvedStreamedBody {
  const resolved = mergeOptions<{ maxBytes: number }>(
    { maxBytes: DEFAULT_STREAMED_BODY_MAX_BYTES },
    config === undefined ? {} : readStreamedBodyOptionsFromConfig(config),
    options,
  );
  new StreamedBodyOptionsValidator().validate(resolved);
  return { maxBytes: resolved.maxBytes };
}

/** Whether a method combinator's argument is a `streamedBody()` route rather than a plain handler. */
export function isStreamedBodyRoute(value: unknown): value is StreamedBodyRoute {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'streamed-body';
}
