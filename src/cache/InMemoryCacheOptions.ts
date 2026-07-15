import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/** Built-in default LRU cap on stored entries (see {@link InMemoryCacheOptionsType}). */
export const DEFAULT_MAX_ENTRIES = 10_000;
/** Built-in default background-sweep interval in ms (see {@link InMemoryCacheOptionsType}). */
export const DEFAULT_CLEANUP_MS = 60_000;

/** Plain options-object shape accepted by an {@link InMemoryCache}. */
export interface InMemoryCacheOptionsType {
  /** LRU cap on stored entries.  Default 10 000.  `Infinity` = unbounded. */
  readonly maxEntries?: number;
  /**
   * How often (ms) to sweep expired entries in the background.  Default
   * 60 000.  `0` / `Infinity` disables the sweep (lazy expiry still applies
   * on access).
   */
  readonly cleanupMs?: number;
}

/**
 * Fluent builder for {@link InMemoryCacheOptionsType}:
 *
 *     const cacheOptions = InMemoryCacheOptions.create().withMaxEntries(50_000);
 *     new InMemoryCache(cacheOptions);
 */
export class InMemoryCacheOptionsBuilder extends OptionsBuilder<InMemoryCacheOptionsType> {
  /** Start a fresh builder.  Equivalent to `new InMemoryCacheOptionsBuilder()`. */
  static create(): InMemoryCacheOptionsBuilder {
    return new InMemoryCacheOptionsBuilder();
  }

  /** LRU cap on stored entries.  `Infinity` opts out of eviction (unbounded). */
  withMaxEntries(maxEntries: number): this {
    return this.set('maxEntries', maxEntries);
  }

  /** Background expired-entry sweep interval (ms).  `0` / `Infinity` disables the sweep. */
  withCleanupMs(cleanupMs: number): this {
    return this.set('cleanupMs', cleanupMs);
  }
}

/**
 * Validates resolved {@link InMemoryCacheOptionsType} settings.  Both fields
 * legitimately admit `Infinity` (unbounded map / sweep disabled), which the
 * generic `positiveInt` / `positiveNumber` helpers reject, so the rules are
 * bespoke.
 */
export class InMemoryCacheOptionsValidator extends OptionsValidator<InMemoryCacheOptionsType> {
  constructor() {
    super('InMemoryCacheOptions');
  }
  protected rules(s: Partial<InMemoryCacheOptionsType>): void {
    const { maxEntries, cleanupMs } = s;
    if (
      maxEntries !== undefined && maxEntries !== Infinity &&
      (typeof maxEntries !== 'number' || !Number.isInteger(maxEntries) || maxEntries < 1)
    ) {
      this.fail('maxEntries', 'must be a positive integer or Infinity', maxEntries);
    }
    if (
      cleanupMs !== undefined &&
      (typeof cleanupMs !== 'number' || Number.isNaN(cleanupMs) || cleanupMs < 0)
    ) {
      this.fail('cleanupMs', 'must be a non-negative number (0 or Infinity disables the sweep)', cleanupMs);
    }
  }
}

/**
 * Accepted input for the {@link InMemoryCache} constructor: the fluent
 * {@link InMemoryCacheOptionsBuilder} OR a plain
 * {@link InMemoryCacheOptionsType} object.
 */
export type InMemoryCacheOptions = InMemoryCacheOptionsBuilder | Partial<InMemoryCacheOptionsType>;
/** Value alias so `InMemoryCacheOptions.create()` / `new InMemoryCacheOptions()` resolve to the builder. */
export const InMemoryCacheOptions = InMemoryCacheOptionsBuilder;
