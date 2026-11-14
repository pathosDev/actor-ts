import { systemClock } from '../../Clock.js';
import { ConsoleLogger, LogLevel, type Logger } from '../../Logger.js';
import type { Counter } from '../../metrics/Metrics.js';
import { complete } from '../Route.js';
import { type HttpRequest, type HttpResponse, Status } from '../Types.js';
import {
  DEFAULT_RATE_LIMIT_FAILURE_MODE,
  RateLimitOptionsValidator,
  type RateLimitBackendErrorContext,
  type RateLimitContext,
  type RateLimitFailureMode,
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
 *     cache: ext.cache('rate-limit'),
 *     windowMs: 60_000,
 *     max: 100,
 *     key: (request) => request.remoteAddress ?? '<anon>',
 *   });
 *   route(post('/api/expensive', limited(handler)));
 *
 * **Nest it outside `cached(...)`: `rateLimit(cached(handler))`** (#983).
 * The reverse, `cached(rateLimit(handler))`, answers a cache hit before the
 * limiter runs — cached routes go unlimited — and used to replay the first
 * caller's `x-ratelimit-*` headers to everyone; `cached` no longer stores
 * them, but the limiter still never sees a hit.
 *
 * **When the cache fails** the request is passed (`failureMode: 'open'`,
 * default) or refused with 503 (`'closed'`), and either way the failure is
 * logged, counted on `http_rate_limit_backend_errors_total` when `metrics`
 * is set, and handed to `onBackendError`.  Before #983 it was a bare
 * `catch {}`: a dead Redis — or an `ioredis` that never loaded — switched
 * the limiter off with nothing anywhere to alert on.
 *
 * **Security — give this middleware its own cache, or reserve its share
 * of a shared one (security audit HTTP-8):** the counter that enforces
 * the limit lives in the cache, and `InMemoryCache` is LRU-bounded at
 * `maxEntries`.  Since #1080 it counts a counter as carrying a guarantee
 * — `incr` with a `windowMs` created it — and evicts entries that carry
 * none first, so a flood of response-cache keys through a shared instance
 * no longer resets other clients' windows.  That ranks what an entry is
 * for; since #607 `prefixQuotas` ranks whose entry it is, so a shared
 * instance configured with `{ 'rl:': n, 'idem:': m, … }` confines each
 * consumer's flood to its own reservation.  Without one, an
 * attacker-chosen `Idempotency-Key` flood on the same instance is a flood
 * of claims, and once the map holds nothing cheaper the counters go with
 * them.
 *
 * **A flooder can reset its OWN limit, but only from outside the
 * limiter** (#607).  Two cases, and the difference is which of them the
 * flood's requests pass through:
 *
 *   - *Through this limiter* — safe.  Every wrapped request runs `incr`
 *     first, which bumps the flooder's counter to most-recently-used, so
 *     it is never the least-recently-used victim however long the flood
 *     runs.  This holds even after the limiter starts answering 429: the
 *     `incr` happens before the `max` comparison.
 *   - *Bypassing this limiter* — not safe by default.  A key-minting
 *     route on the same `Cache` that the limiter does not wrap never
 *     bumps the counter, so it ages like anyone else's.  Whether it
 *     survives then depends on what the flood writes: a `cached` flood is
 *     opportunistic and is drained first, but a flood of `idempotent`
 *     claims carries a guarantee too, and once the opportunistic half is
 *     empty the counters are what is left to take.  Measured on one
 *     shared `maxEntries: 4` instance: a client answered 429 by
 *     `max: 2` was answered 200 again after twenty off-limiter
 *     `Idempotency-Key` requests.  A `prefixQuotas` reservation for
 *     `rl:` closes exactly this: the same twenty requests then evict
 *     inside `idem:` and the 429 stands for the whole window.
 *
 * Pass a dedicated instance (`ext.cache('rate-limit')`) and size its
 * `maxEntries` above the number of distinct keys you expect to see within
 * one `windowMs`, under `actor-ts.cache.rate-limit.in-memory` — a client
 * with an IPv6 `/64` mints them freely, and every one is a counter this
 * cache protects.  Where one instance genuinely has to be shared, give it
 * `prefixQuotas` instead and size `rl:` the same way; what neither buys
 * is protection from a *co-tenant of the same prefix*, which is what
 * `keyPrefix` and a per-caller `key` are for.
 *
 * **Security — choosing `key` (security audit HTTP-3):** derive it from a
 * value the client can't freely forge.  Served directly, that is
 * `request.remoteAddress`, the socket peer.  Behind a reverse proxy the
 * socket peer is the proxy — every client in one bucket — so resolve the
 * client by naming the proxies you trust:
 *
 *   const clientIp = clientIpResolver(['10.0.0.0/8']);
 *   rateLimit({ …, key: (request) => clientIp(request) ?? '<unresolved>' });
 *
 * That is the trust-by-address walk `IpAllowlist` runs (#1236).  Never key on
 * a raw `x-forwarded-for`, and not on "the entry my proxy sets" either: NGINX,
 * AWS ALB and Cloudflare all *append* to the header, so whatever the client
 * typed is still in it (#715, #1248).  Keyed on the header, an attacker
 * rotates it per request for a fresh bucket each time (limit bypassed), while
 * clients without the header collapse into a single shared bucket (one client
 * can exhaust everyone's quota).
 */

/**
 * Build a rate-limiter higher-order handler.  The returned function
 * wraps a normal handler and returns a new one with rate-limit checks
 * in front.  Accepts a plain options object or the fluent
 * {@link RateLimitOptions} builder.
 */
export function rateLimit(options: RateLimitOptions) {
  const resolvedOptions = options as RateLimitOptionsType;
  new RateLimitOptionsValidator().validate(resolvedOptions);
  const prefix = resolvedOptions.keyPrefix ?? 'rl:';
  const onLimit = resolvedOptions.onLimit ?? defaultOnLimit;
  const failureMode = resolvedOptions.failureMode ?? DEFAULT_RATE_LIMIT_FAILURE_MODE;
  const failures = new BackendFailureReporter({
    prefix,
    failureMode,
    windowMs: resolvedOptions.windowMs,
    logger: resolvedOptions.logger ?? new ConsoleLogger(LogLevel.Warn),
    counter: resolvedOptions.metrics?.counter('http_rate_limit_backend_errors_total', { prefix }, {
      help: 'Requests a rate limiter could not count because its cache failed.',
    }),
    onBackendError: resolvedOptions.onBackendError,
  });

  return function wrap(handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse) {
    return async function limited(request: HttpRequest): Promise<HttpResponse> {
      const userKey = await resolvedOptions.key(request);
      const cacheKey = `${prefix}${userKey}`;
      let count: number;
      try {
        count = await resolvedOptions.cache.incr(cacheKey, resolvedOptions.windowMs);
      } catch (error) {
        // The cache could not count this request (#983).  Report it — log,
        // metric, callback — and then do what `failureMode` says: a silent
        // pass here is how a dead Redis used to switch the limiter off with
        // nothing to alert on.
        failures.report(error, userKey);
        if (failureMode === 'closed') return backendUnavailable();
        return handler(request);
      }
      if (count > resolvedOptions.max) {
        const retryAfter = Math.max(1, Math.ceil(resolvedOptions.windowMs / 1000));
        return onLimit({
          key: userKey,
          count,
          max: resolvedOptions.max,
          windowMs: resolvedOptions.windowMs,
          retryAfterSeconds: retryAfter,
        });
      }
      const response = await handler(request);
      // Surface the standard X-RateLimit headers when we still have headroom.
      const headers: Record<string, string> = {
        'x-ratelimit-limit': String(resolvedOptions.max),
        'x-ratelimit-remaining': String(Math.max(0, resolvedOptions.max - count)),
      };
      return {
        ...response,
        headers: { ...(response.headers ?? {}), ...headers },
      };
    };
  };
}

/**
 * The `failureMode: 'closed'` answer.  503 and not 429: the client has not
 * exceeded anything — the server cannot tell whether it has, and saying
 * "too many requests" would send a well-behaved client into a backoff for
 * a fault that is ours.
 */
function backendUnavailable(): HttpResponse {
  return complete(Status.ServiceUnavailable, { error: 'rate limiter unavailable' });
}

type BackendFailureReporterSettings = {
  readonly prefix: string;
  readonly failureMode: RateLimitFailureMode;
  readonly windowMs: number;
  readonly logger: Logger;
  readonly counter: Counter | undefined;
  readonly onBackendError: ((error: unknown, context: RateLimitBackendErrorContext) => void) | undefined;
};

/**
 * Makes a failing limiter cache visible without making it noisy (#983).
 *
 * Every failure reaches the metric and the callback; the log gets one line
 * per `windowMs` while failures continue, carrying the count it suppressed,
 * because an outage under load is thousands of failures a second and one
 * line per request would bury everything else in the log.
 *
 * A failure that repeats the **identical error object** is treated as
 * permanent and logged once, at error.  That is what a memoised rejection
 * looks like: `RedisCache` imports `ioredis` through a `Lazy`, which keeps
 * a rejected promise, so a missing peer rejects every later call with the
 * same `CacheError`.  A transient fault produces a fresh error per call.
 * Identity is the honest signal here — matching on message text would
 * misread a Redis that keeps answering "connection refused".
 */
class BackendFailureReporter {
  private lastError: unknown = undefined;
  private lastLoggedAt = Number.NEGATIVE_INFINITY;
  private suppressed = 0;
  private permanentReported = false;

  constructor(private readonly settings: BackendFailureReporterSettings) {}

  report(error: unknown, key: string): void {
    const permanent = this.lastError !== undefined && error === this.lastError;
    this.lastError = error;
    if (!permanent) this.permanentReported = false;
    this.settings.counter?.inc();
    this.settings.onBackendError?.(error, { key, failureMode: this.settings.failureMode, permanent });
    if (permanent) {
      if (this.permanentReported) return;
      this.permanentReported = true;
      this.settings.logger.error(
        `rateLimit(${this.settings.prefix}): the cache fails with the same error on every call — a permanent `
        + `condition such as a peer dependency that never loaded, not a hiccup: ${describeError(error)}.  `
        + `${this.consequence()} until this is fixed.`,
      );
      return;
    }
    const now = systemClock.now();
    if (now - this.lastLoggedAt < this.settings.windowMs) {
      this.suppressed += 1;
      return;
    }
    const suppressed = this.suppressed > 0 ? `  (${this.suppressed} further failure(s) since the last report.)` : '';
    this.lastLoggedAt = now;
    this.suppressed = 0;
    this.settings.logger.warn(
      `rateLimit(${this.settings.prefix}): the cache could not count a request: ${describeError(error)}.  `
      + `${this.consequence()} until it recovers.${suppressed}`,
    );
  }

  private consequence(): string {
    return this.settings.failureMode === 'closed'
      ? 'The limiter is set to fail closed, so requests are answered 503'
      : 'The limiter is set to fail open, so requests pass unlimited';
  }
}

/** The error's message, and its cause's — `wrapError` keeps the driver's own words in `cause`. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
}

function defaultOnLimit(context: RateLimitContext): HttpResponse {
  return complete(
    Status.TooManyRequests,
    { error: 'rate limited', retryAfter: context.retryAfterSeconds },
    {
      'retry-after': String(context.retryAfterSeconds),
      'x-ratelimit-limit': String(context.max),
      'x-ratelimit-remaining': '0',
    },
  );
}
