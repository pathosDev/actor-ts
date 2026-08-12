import type { Cache } from '../../cache/Cache.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

/**
 * Built-in default for {@link CachedSnapshotStoreOptionsType.ttlMs}.  5 min
 * suits the typical "actor restarts a few times during deploy" pattern
 * without holding stale data forever — see {@link CachedSnapshotStore} for
 * why the TTL is the correctness net rather than a mere optimisation.
 */
export const DEFAULT_SNAPSHOT_CACHE_TTL_MS = 5 * 60_000;

export type CachedSnapshotStoreOptionsType = {
  /** Backing cache — typically Redis in production. */
  readonly cache: Cache;
  /** Cache TTL in milliseconds.  Default: 5 minutes. */
  readonly ttlMs?: number;
  /** Key prefix (default: `'snap:'`) prevents collisions in shared caches. */
  readonly keyPrefix?: string;
};

/**
 * Fluent builder for {@link CachedSnapshotStoreOptionsType}.  The `cache` is
 * required:
 *
 *     new CachedSnapshotStore(
 *       underlying,
 *       CachedSnapshotStoreOptions.create().withCache(cache).withTtlMs(5 * 60_000),
 *     )
 */
export class CachedSnapshotStoreOptionsBuilder extends OptionsBuilder<CachedSnapshotStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new CachedSnapshotStoreOptionsBuilder()`. */
  static create(): CachedSnapshotStoreOptionsBuilder {
    return new CachedSnapshotStoreOptionsBuilder();
  }

  /** Backing cache — typically Redis in production. */
  withCache(cache: Cache): this {
    return this.set('cache', cache);
  }

  /** Cache TTL in milliseconds.  Default: 5 minutes. */
  withTtlMs(ttlMs: number): this {
    return this.set('ttlMs', ttlMs);
  }

  /** Key prefix (default: `'snap:'`) — prevents collisions in shared caches. */
  withKeyPrefix(keyPrefix: string): this {
    return this.set('keyPrefix', keyPrefix);
  }
}

/**
 * Validates resolved {@link CachedSnapshotStoreOptionsType} settings — the
 * backing `cache` is required and `ttlMs` (when set) must be a positive
 * duration.
 */
export class CachedSnapshotStoreOptionsValidator extends OptionsValidator<CachedSnapshotStoreOptionsType> {
  constructor() {
    super('CachedSnapshotStoreOptions');
  }
  protected rules(s: Partial<CachedSnapshotStoreOptionsType>): void {
    if (s.cache === undefined) this.fail('cache', 'is required (call withCache())');
    this.positiveNumber('ttlMs');
  }
}

/**
 * Accepted input for the cached snapshot-store constructor: the fluent
 * {@link CachedSnapshotStoreOptionsBuilder} OR a plain {@link CachedSnapshotStoreOptionsType} object.
 */
export type CachedSnapshotStoreOptions = CachedSnapshotStoreOptionsBuilder | Partial<CachedSnapshotStoreOptionsType>;
/** Value alias so `CachedSnapshotStoreOptions.create()` / `new CachedSnapshotStoreOptions()` resolve to the builder. */
export const CachedSnapshotStoreOptions = CachedSnapshotStoreOptionsBuilder;
