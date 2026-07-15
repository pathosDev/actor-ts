import { complete } from '../Route.js';
import { type HttpRequest, type HttpResponse, Status } from '../types.js';
import {
  RateLimitOptionsValidator,
  type RateLimitContext,
  type RateLimitOptions,
  type RateLimitOptionsType,
} from './RateLimitOptions.js';

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
 *     key: (req) => req.remoteAddress ?? '<anon>',
 *   });
 *   route(post('/api/expensive', limited(handler)));
 *
 * **Security — choosing `key` (security audit HTTP-3):** derive it from a
 * value the client can't freely forge.  `req.remoteAddress` (the socket peer)
 * is the safe default.  Do NOT key on a client-settable header such as
 * `x-forwarded-for` unless a trusted proxy strips and re-sets it — otherwise
 * an attacker rotates the header per request for a fresh bucket each time
 * (limit bypassed), while clients without the header collapse into a single
 * shared bucket (one client can exhaust everyone's quota).
 */

/**
 * Build a rate-limiter higher-order handler.  The returned function
 * wraps a normal handler and returns a new one with rate-limit checks
 * in front.  Accepts a plain options object or the fluent
 * {@link RateLimitOptions} builder.
 */
export function rateLimit(options: RateLimitOptions) {
  const opts = options as RateLimitOptionsType;
  new RateLimitOptionsValidator().validate(opts);
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
