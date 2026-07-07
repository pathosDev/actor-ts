import type { Cache } from '../../cache/Cache.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { CachedSnapshotStoreSettings } from './CachedSnapshotStore.js';

/**
 * Fluent builder for {@link CachedSnapshotStoreSettings}.  The `cache` is
 * required:
 *
 *     new CachedSnapshotStore(
 *       underlying,
 *       CachedSnapshotStoreOptions.create().withCache(cache).withTtlMs(5 * 60_000),
 *     )
 */
export class CachedSnapshotStoreOptions extends OptionsBuilder<CachedSnapshotStoreSettings> {
  /** Start a fresh builder.  Equivalent to `new CachedSnapshotStoreOptions()`. */
  static create(): CachedSnapshotStoreOptions {
    return new CachedSnapshotStoreOptions();
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
