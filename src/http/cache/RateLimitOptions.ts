/**
 * Options for the {@link rateLimit} middleware.  Follows the repo's
 * `XOptions.ts` convention (type / builder / validator / union), but the
 * builder is purely ADDITIVE: `rateLimit(...)` still accepts a plain
 * options object exactly as before.
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { Cache } from '../../cache/Cache.js';
import type { HttpRequest, HttpResponse } from '../types.js';

/** Context handed to a custom {@link RateLimitOptionsType.onLimit} builder. */
export interface RateLimitContext {
  readonly key: string;
  readonly count: number;
  readonly max: number;
  readonly windowMs: number;
  readonly retryAfterSeconds: number;
}

/** Plain options-object shape accepted by {@link rateLimit}. */
export interface RateLimitOptionsType {
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

/**
 * Fluent builder for {@link RateLimitOptionsType}:
 *
 *     rateLimit(RateLimitOptions.create().withCache(cache).withWindowMs(60_000).withMax(100).withKey((req) => req.remoteAddress ?? '<anon>'))
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
  withKey(key: (req: HttpRequest) => string | Promise<string>): this {
    return this.set('key', key);
  }

  /** Cache-key namespace prepended to the user key.  Default `'rl:'`. */
  withKeyPrefix(keyPrefix: string): this {
    return this.set('keyPrefix', keyPrefix);
  }

  /** Custom 429 response builder — full control over the limit response. */
  withOnLimit(onLimit: (ctx: RateLimitContext) => HttpResponse): this {
    return this.set('onLimit', onLimit);
  }
}

/**
 * Validates resolved {@link RateLimitOptionsType} settings: the rolling
 * window (`windowMs`) must be a positive finite number of milliseconds and
 * the per-window cap (`max`) a positive integer.  (Presence of `cache` /
 * `key` is a required-field concern, not a domain-validity one.)
 */
export class RateLimitOptionsValidator extends OptionsValidator<RateLimitOptionsType> {
  constructor() {
    super('RateLimitOptions');
  }
  protected rules(_s: Partial<RateLimitOptionsType>): void {
    this.positiveNumber('windowMs');
    this.positiveInt('max');
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
