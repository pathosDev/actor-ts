/**
 * Options for a `streamedBody()` route (#1868).
 *
 * `maxBytes` has a leaf, `max-bytes`, in `actor-ts.http.streamed-body`, merged
 * when the route tree is compiled inside `bind()`: the route's options > HOCON
 * > {@link DEFAULT_STREAMED_BODY_MAX_BYTES}, then this validator once on the
 * result.  Independent of `http.server.max-content-length`, which caps the
 * buffered routes only — that the two can differ is the point: a server whose
 * JSON routes hold to 1 MiB can still take a 25 MiB upload on the one route
 * built for it.
 */
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/**
 * Built-in limit of a streamed request body, 64 MiB — what a `streamedBody()`
 * route admits when neither its options nor HOCON name a limit.
 *
 * Larger than the buffered routes' 1 MiB because a streamed body never sits
 * in memory whole, so the number bounds a client's upload rather than the
 * server's heap; still finite, because a route that streams into storage is a
 * disk- and bandwidth-filling primitive, and "unlimited" should be a decision
 * written down per route.
 */
export const DEFAULT_STREAMED_BODY_MAX_BYTES = 64 * 1024 * 1024;

/** Plain settings shape for a streamed route. */
export type StreamedBodyOptionsType = {
  /**
   * The most body bytes the route admits.  A declared `Content-Length` over it
   * is answered 413 before the handler runs; a body that grows past it while
   * streaming errors the stream with `RequestBodyTooLargeError`.  Default
   * {@link DEFAULT_STREAMED_BODY_MAX_BYTES}.
   */
  readonly maxBytes?: number;
};

/** Fluent builder for {@link StreamedBodyOptionsType}. */
export class StreamedBodyOptionsBuilder extends OptionsBuilder<StreamedBodyOptionsType> {
  static create(): StreamedBodyOptionsBuilder {
    return new StreamedBodyOptionsBuilder();
  }
  withMaxBytes(maxBytes: number): this {
    return this.set('maxBytes', maxBytes);
  }
}

/** Accepted input: the builder or a plain object. */
export type StreamedBodyOptions = StreamedBodyOptionsBuilder | Partial<StreamedBodyOptionsType>;
export const StreamedBodyOptions = StreamedBodyOptionsBuilder;

/**
 * Validates resolved {@link StreamedBodyOptionsType} settings: `maxBytes` must
 * be a positive integer no larger than `Number.MAX_SAFE_INTEGER`, past which a
 * byte count can no longer be compared exactly.
 */
export class StreamedBodyOptionsValidator extends OptionsValidator<StreamedBodyOptionsType> {
  constructor() {
    super('StreamedBodyOptions');
  }
  protected rules(s: Partial<StreamedBodyOptionsType>): void {
    this.positiveInt('maxBytes');
    if (s.maxBytes !== undefined && Number.isInteger(s.maxBytes) && s.maxBytes > Number.MAX_SAFE_INTEGER) {
      this.fail('maxBytes', `must be at most ${Number.MAX_SAFE_INTEGER}`, s.maxBytes);
    }
  }
}
