/**
 * Options for the {@link rateLimit} middleware.  Follows the repo's
 * `XOptions.ts` convention (type / builder / validator / union), but the
 * builder is purely ADDITIVE: `rateLimit(...)` still accepts a plain
 * options object exactly as before.
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { Cache } from '../../cache/Cache.js';
import type { Logger } from '../../Logger.js';
import type { MetricsRegistry } from '../../metrics/Metrics.js';
import type { HttpRequest, HttpResponse } from '../Types.js';

/** Context handed to a custom {@link RateLimitOptionsType.onLimit} builder. */
export type RateLimitContext = {
  readonly key: string;
  readonly count: number;
  readonly max: number;
  readonly windowMs: number;
  readonly retryAfterSeconds: number;
};

/**
 * What the limiter does with a request when its cache cannot count it.
 * `'open'` lets it through, `'closed'` answers 503.
 */
export type RateLimitFailureMode = 'open' | 'closed';

/** Built-in default for {@link RateLimitOptionsType.failureMode}. */
export const DEFAULT_RATE_LIMIT_FAILURE_MODE: RateLimitFailureMode = 'open';

/** Context handed to {@link RateLimitOptionsType.onBackendError}. */
export type RateLimitBackendErrorContext = {
  /** The user key (without `keyPrefix`) whose count failed. */
  readonly key: string;
  /** What the limiter does with this request: the configured mode. */
  readonly failureMode: RateLimitFailureMode;
  /**
   * `true` when the cache rejected with the very same error object as the
   * failure before — a memoised rejection, such as `RedisCache`'s lazily
   * imported `ioredis` that never loaded.  That condition does not heal by
   * itself; a fresh error per call is a hiccup that might.
   */
  readonly permanent: boolean;
};

/** Plain options-object shape accepted by {@link rateLimit}. */
export type RateLimitOptionsType = {
  /** Backing cache.  Should be a shared/distributed one (Redis) in prod. */
  readonly cache: Cache;
  /** Length of the rolling window in milliseconds. */
  readonly windowMs: number;
  /** Maximum requests allowed per window per key. */
  readonly max: number;
  /** Identity function — typically derives from IP, user id, or API key. */
  readonly key: (request: HttpRequest) => string | Promise<string>;
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
  readonly onLimit?: (context: RateLimitContext) => HttpResponse;
  /**
   * What to do with a request when the cache cannot count it (#983).
   *
   * `'open'` (the default) lets the request through: a limiter is abuse
   * protection, and taking the whole API down because Redis blinked trades
   * an availability outage for a hypothetical one.  `'closed'` answers 503
   * instead — the choice for a limiter that guards something expensive or
   * abusable (login, password reset, a paid upstream), where an unlimited
   * window is worse than a refused request.
   *
   * Either way the failure is no longer silent: it is logged through
   * {@link logger}, counted on {@link metrics}, and handed to
   * {@link onBackendError}.
   */
  readonly failureMode?: RateLimitFailureMode;
  /**
   * Called on every cache failure, before the request is passed or refused —
   * the hook for an application that wants its own alerting or a circuit of
   * its own.  Must not throw; what it throws propagates to the request.
   */
  readonly onBackendError?: (error: unknown, context: RateLimitBackendErrorContext) => void;
  /**
   * Where cache failures are logged.  Default: a console logger at warn.
   * One line per `windowMs` while failures continue, with the count of the
   * suppressed ones, so an outage is one line a minute and not one per
   * request; a {@link RateLimitBackendErrorContext.permanent | permanent}
   * failure is logged once, at error.
   */
  readonly logger?: Logger;
  /**
   * Registry for `http_rate_limit_backend_errors_total{prefix}`, incremented
   * on every cache failure.  Unset: no metric — pass the system's registry
   * (`system.extension(MetricsExtensionId).enable()`) to alert on a limiter
   * that has stopped counting.
   */
  readonly metrics?: MetricsRegistry;
};

/**
 * Fluent builder for {@link RateLimitOptionsType}:
 *
 *     rateLimit(RateLimitOptions.create().withCache(cache).withWindowMs(60_000).withMax(100).withKey((request) => request.remoteAddress ?? '<anon>'))
 */
export class RateLimitOptionsBuilder extends OptionsBuilder<RateLimitOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RateLimitOptionsBuilder()`. */
  static create(): RateLimitOptionsBuilder {
    return new RateLimitOptionsBuilder();
  }

  /** Backing cache.  Should be a shared/distributed one (Redis) in prod. */
  withCache(cache: Cache): this {
    return this.set('cache', cache);
  }

  /** Length of the rolling window in milliseconds. */
  withWindowMs(windowMs: number): this {
    return this.set('windowMs', windowMs);
  }

  /** Maximum requests allowed per window per key. */
  withMax(max: number): this {
    return this.set('max', max);
  }

  /** Identity function — typically derives from IP, user id, or API key. */
  withKey(key: (request: HttpRequest) => string | Promise<string>): this {
    return this.set('key', key);
  }

  /** Cache-key namespace prepended to the user key.  Default `'rl:'`. */
  withKeyPrefix(keyPrefix: string): this {
    return this.set('keyPrefix', keyPrefix);
  }

  /** Custom 429 response builder — full control over the limit response. */
  withOnLimit(onLimit: (context: RateLimitContext) => HttpResponse): this {
    return this.set('onLimit', onLimit);
  }

  /** Pass (`'open'`, default) or refuse with 503 (`'closed'`) when the cache fails. */
  withFailureMode(failureMode: RateLimitFailureMode): this {
    return this.set('failureMode', failureMode);
  }

  /** Called on every cache failure, before the request is passed or refused. */
  withOnBackendError(onBackendError: (error: unknown, context: RateLimitBackendErrorContext) => void): this {
    return this.set('onBackendError', onBackendError);
  }

  /** Where cache failures are logged.  Default: a console logger at warn. */
  withLogger(logger: Logger): this {
    return this.set('logger', logger);
  }

  /** Registry for `http_rate_limit_backend_errors_total`.  Unset: no metric. */
  withMetrics(metrics: MetricsRegistry): this {
    return this.set('metrics', metrics);
  }
}

/**
 * Validates resolved {@link RateLimitOptionsType} settings: the rolling
 * window (`windowMs`) must be a positive finite number of milliseconds and
 * the per-window cap (`max`) a positive integer, and `failureMode` one of
 * its two literals.  (Presence of `cache` /
 * `key` is a required-field concern, not a domain-validity one.)
 */
export class RateLimitOptionsValidator extends OptionsValidator<RateLimitOptionsType> {
  constructor() {
    super('RateLimitOptions');
  }
  protected rules(_s: Partial<RateLimitOptionsType>): void {
    this.positiveNumber('windowMs');
    this.positiveInt('max');
    this.oneOf('failureMode', ['open', 'closed']);
  }
}

/**
 * Accepted input for {@link rateLimit}: the fluent
 * {@link RateLimitOptionsBuilder} OR a plain {@link RateLimitOptionsType}
 * object.
 */
export type RateLimitOptions = RateLimitOptionsBuilder | Partial<RateLimitOptionsType>;
/** Value alias so `RateLimitOptions.create()` / `new RateLimitOptions()` resolve to the builder. */
export const RateLimitOptions = RateLimitOptionsBuilder;
