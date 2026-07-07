import type { Cache } from '../../cache/Cache.js';
import type { Snapshot } from '../JournalTypes.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import { none, some, type Option } from '../../util/Option.js';
import type { CachedSnapshotStoreOptions, CachedSnapshotStoreOptionsType } from './CachedSnapshotStoreOptions.js';

/**
 * Read-through cache decorator for any `SnapshotStore`.  Targets the hot
 * `loadLatest` path that fires whenever a sharded entity wakes up — at
 * scale (rebalancing, deploys), thousands of cold-starts hammer the
 * underlying store (Cassandra, S3, …) with the same query shape.  A
 * Redis cache in front cuts that to a single round-trip in 99% of cases.
 *
 * Cache semantics:
 *   - `loadLatest` is read-through with TTL.
 *   - `save` is **write-through-with-invalidate**: we delegate to the
 *     underlying store, then *delete* the cache entry.  We deliberately
 *     do NOT write the new snapshot into the cache, because in a
 *     cluster two nodes might race on save and the local-write would
 *     leave a stale entry.  Letting the next read repopulate is
 *     simpler and safe.
 *   - `loadBefore` is **not cached** — it has too many possible `seq`
 *     values to cache profitably and it's used much less often (only
 *     during recovery when seeking past a corrupt snapshot).
 *   - `delete` invalidates the cache entry.
 *
 * **Correctness:**  TTL is the safety net.  Even if a node crashes
 * between `save` and `cache.delete`, the cache entry expires within
 * `ttlMs` and the next read fetches the fresh snapshot from the
 * underlying store.  Pick a TTL on the order of minutes (default: 5
 * min) — short enough that stale reads after a missed invalidation
 * never matter, long enough to absorb cold-start storms.
 *
 *   const cassandra = new CassandraSnapshotStore(...);
 *   const cached    = new CachedSnapshotStore(
 *     cassandra,
 *     CachedSnapshotStoreOptions.create().withCache(cache).withTtlMs(5 * 60_000),
 *   );
 *   ext.setSnapshotStore(cached);
 */

const DEFAULT_TTL_MS = 5 * 60_000;

interface CachedSnapshot<S> {
  readonly persistenceId: string;
  readonly sequenceNr: number;
  readonly state: S;
  readonly timestamp: number;
}

export class CachedSnapshotStore implements SnapshotStore {
  private readonly cache: Cache;
  private readonly ttlMs: number;
  private readonly keyPrefix: string;

  constructor(
    private readonly underlying: SnapshotStore,
    options: CachedSnapshotStoreOptions,
  ) {
    const s = (options as CachedSnapshotStoreOptionsType);
    if (s.cache === undefined) throw new Error('CachedSnapshotStore: cache is required (call withCache()).');
    this.cache = s.cache;
    this.ttlMs = s.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error(`CachedSnapshotStore: ttlMs must be a positive finite number, got ${this.ttlMs}`);
    }
    this.keyPrefix = s.keyPrefix ?? 'snap:';
  }

  async save<S>(pid: string, seq: number, state: S, options?: PersistenceOptions): Promise<Snapshot<S>> {
    const written = await this.underlying.save<S>(pid, seq, state, options);
    // Invalidate, do NOT write — see class doc for the cluster-race rationale.
    await this.cache.delete(this.keyFor(pid));
    return written;
  }

  async loadLatest<S>(pid: string, options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const key = this.keyFor(pid);
    const hit = await this.cache.get<CachedSnapshot<S>>(key);
    if (hit.isSome()) return some(hit.value as Snapshot<S>);
    const fetched = await this.underlying.loadLatest<S>(pid, options);
    if (fetched.isNone()) return none;
    await this.cache.set<CachedSnapshot<S>>(key, fetched.value, this.ttlMs);
    return fetched;
  }

  async loadBefore<S>(pid: string, seq: number, options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    // Not cached — see class doc.
    return this.underlying.loadBefore<S>(pid, seq, options);
  }

  async delete(pid: string, toSeq: number): Promise<void> {
    await this.underlying.delete(pid, toSeq);
    await this.cache.delete(this.keyFor(pid));
  }

  async close(): Promise<void> {
    await this.underlying.close?.();
    // We do NOT close the cache — it's owned by the caller (the same
    // cache typically backs HTTP middleware, etc.).
  }

  private keyFor(pid: string): string {
    return `${this.keyPrefix}${pid}`;
  }
}
