import type { Cache } from '../../cache/Cache.js';
import { complete } from '../Route.js';
import { type HttpRequest, type HttpResponse, Status } from '../types.js';

/**
 * HTTP rate-limiting middleware backed by a `Cache` (Redis recommended
 * for multi-process deployments; InMemoryCache for single-process).
 *
 * Algorithm: **fixed-window counter**.  The key derived from the request
 * is incremented on every request; the first increment seeds the TTL
 * to `windowMs`.  Once the counter exceeds `max`, the wrapper short-
 * circuits with a `429 Too Many Requests` response carrying a
 * `Retry-After` header.
 *
 * Why fixed-window over token-bucket / sliding-log?
 *   - One Redis op per request (`INCR + EXPIRE`).  Cheap, atomic.
 *   - Industry-standard for "X requests per minute" guarantees.
 *   - The well-known burst-at-window-boundary edge case (2× quota in a
 *     small window around the rollover) is acceptable for almost every
 *     real use-case.  If you need precision, a sliding window would be
 *     a separate primitive.
 *
 * Usage:
 *
 *   const limited = rateLimit({
 *     cache: ext.cache(),
 *     windowMs: 60_000,
 *     max: 100,
 *     key: (req) => req.headers['x-forwarded-for'] ?? '<anon>',
 *   });
 *   route(post('/api/expensive', limited(handler)));
 */

export interface RateLimitOptions {
  /** Backing cache.  Should be a shared/distributed one (Redis) in prod. */
  readonly cache: Cache;
  /** Length of the rolling window in milliseconds. */
  readonly windowMs: number;
  /** Maximum requests allowed per window per key. */
  readonly max: number;
  /** Identity function — typically derives from IP, user id, or API key. */
  readonly key: (req: HttpRequest) => string | Promise<string>;
  /**
   * Cache-key namespace prepended to the user key.  Defaults to
   * `'rl:'` so multiple rate-limiters in the same cache don't collide.
   */
  readonly keyPrefix?: string;
  /**
   * Custom 429 response builder.  Receives the limit context for
   * full control over the body / headers.  Default: a plain 429 with
   * `Retry-After` (seconds-rounded-up).
   */
  readonly onLimit?: (ctx: RateLimitContext) => HttpResponse;
}

export interface RateLimitContext {
  readonly key: string;
  readonly count: number;
  readonly max: number;
  readonly windowMs: number;
  readonly retryAfterSeconds: number;
}

/**
 * Build a rate-limiter higher-order handler.  The returned function
 * wraps a normal handler and returns a new one with rate-limit checks
 * in front.
 */
export function rateLimit(opts: RateLimitOptions) {
  if (!Number.isFinite(opts.windowMs) || opts.windowMs <= 0) {
    throw new Error(`rateLimit: windowMs must be a positive finite number, got ${opts.windowMs}`);
  }
  if (!Number.isInteger(opts.max) || opts.max <= 0) {
    throw new Error(`rateLimit: max must be a positive integer, got ${opts.max}`);
  }
  const prefix = opts.keyPrefix ?? 'rl:';
  const onLimit = opts.onLimit ?? defaultOnLimit;

  return function wrap(handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse) {
    return async function limited(req: HttpRequest): Promise<HttpResponse> {
      const userKey = await opts.key(req);
      const cacheKey = `${prefix}${userKey}`;
      let count: number;
      try {
        count = await opts.cache.incr(cacheKey, opts.windowMs);
      } catch {
        // Cache fault → fail open (let the request through).  Better to
        // serve traffic than to take down the API on Redis hiccups.
        return handler(req);
      }
      if (count > opts.max) {
        const retryAfter = Math.max(1, Math.ceil(opts.windowMs / 1000));
        return onLimit({
          key: userKey,
          count,
          max: opts.max,
          windowMs: opts.windowMs,
          retryAfterSeconds: retryAfter,
        });
      }
      const response = await handler(req);
      // Surface the standard X-RateLimit headers when we still have headroom.
      const headers: Record<string, string> = {
        'x-ratelimit-limit': String(opts.max),
        'x-ratelimit-remaining': String(Math.max(0, opts.max - count)),
      };
      return {
        ...response,
        headers: { ...(response.headers ?? {}), ...headers },
      };
    };
  };
}

function defaultOnLimit(ctx: RateLimitContext): HttpResponse {
  return complete(
    Status.TooManyRequests,
    { error: 'rate limited', retryAfter: ctx.retryAfterSeconds },
    {
      'retry-after': String(ctx.retryAfterSeconds),
      'x-ratelimit-limit': String(ctx.max),
      'x-ratelimit-remaining': '0',
    },
  );
}
