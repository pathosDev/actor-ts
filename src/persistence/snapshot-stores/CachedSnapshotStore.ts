import type { Cache } from '../../cache/Cache.js';
import { JournalError, type Snapshot } from '../JournalTypes.js';
import type { PersistenceOptionSupport } from '../PersistenceCapabilities.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import type { StorageLocality } from '../StorageLocality.js';
import { none, some, type Option } from '../../util/Option.js';
import { CachedSnapshotStoreOptionsValidator, DEFAULT_SNAPSHOT_CACHE_TTL_MS } from './CachedSnapshotStoreOptions.js';
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
 * **Security — the cache holds plaintext (#782).**  What gets cached is
 * whatever `SnapshotStore.loadLatest` returns, and that is the *decoded*
 * domain state: decompressed, and for the object-storage stores decrypted.
 * Compose this decorator with client-side snapshot encryption and the
 * deployment ends up with two copies of the state — one encrypted in the
 * bucket, one in plaintext in a cache the caller owns, shares with other
 * subsystems (see `close()` below) and very often runs unauthenticated on a
 * "private" network.  Reading the second copy needs neither the bucket nor
 * the master key, and a Redis RDB dump keeps it readable afterwards.
 * Nothing at rest in the bucket is weakened; the second copy is the whole
 * exposure, which is why this is a composition hazard rather than a defect
 * in either component.
 *
 * The decorator therefore refuses to cache a snapshot whose `loadLatest`
 * carried `encryption` with a mode other than `'none'`: that call is
 * delegated straight through, and the decorator warns once.
 * `withAllowPlaintextCache(true)` is the operator's acknowledgement that the
 * cache is as protected as the bucket, and restores the caching.
 *
 * What this check can and cannot see is worth stating, because the gap is
 * not obvious.  It sees the **per-call** `PersistenceOptions` an actor's
 * `encryption()` hook produces, which is what reaches every read and write.
 * It does not see a store configured with encryption at *construction* and
 * never told about it per call — `SnapshotStore` has no member that would
 * report that, and `persistenceOptionSupport` answers a different question
 * ("could this store encrypt?", not "is it going to?").  Adding one is a
 * change to the store contract rather than to this decorator.
 *
 *   const cassandra = new CassandraSnapshotStore(...);
 *   const cached    = new CachedSnapshotStore(
 *     cassandra,
 *     CachedSnapshotStoreOptions.create().withCache(cache).withTtlMs(5 * 60_000),
 *   );
 *   ext.setSnapshotStore(cached);
 */

type CachedSnapshot<S> = {
  readonly persistenceId: string;
  readonly sequenceNr: number;
  readonly state: S;
  readonly timestamp: number;
};

/**
 * The advisory logged the first time an encrypted-state load reaches an
 * unacknowledged cache (#782).
 *
 * `console.warn` for the reason `ObjectStoragePlugin.assertMasterKeyRings`
 * gives: a snapshot store is constructed by the operator and holds no
 * `ActorSystem`, so there is no system logger to reach, and threading one
 * through the decorator for one advisory line is the worse trade.  The
 * stable needle is `caches decoded snapshot state` — filter on that, not on
 * the sentence around it.
 */
function plaintextCacheWarning(storeName: string): string {
  return `persistence: CachedSnapshotStore caches decoded snapshot state, and this loadLatest on `
    + `'${storeName}' asked for encryption — so the cached copy would be the plaintext of data the `
    + 'wrapped store keeps encrypted at rest, in a cache the caller owns and typically shares with '
    + 'other subsystems (#782). The snapshot is being served straight from the wrapped store '
    + 'instead, uncached, and this warning is logged once per store. Call '
    + 'withAllowPlaintextCache(true) to acknowledge the exposure and take the cold-start win, once '
    + 'the cache is as protected as the bucket is.';
}

export class CachedSnapshotStore implements SnapshotStore {
  private readonly cache: Cache;
  private readonly ttlMs: number;
  private readonly keyPrefix: string;
  private readonly allowPlaintextCache: boolean;
  private reportedPlaintextCache = false;

  constructor(
    private readonly underlying: SnapshotStore,
    options: CachedSnapshotStoreOptions,
  ) {
    const resolvedOptions = (options as CachedSnapshotStoreOptionsType);
    new CachedSnapshotStoreOptionsValidator().validate(resolvedOptions);
    this.cache = resolvedOptions.cache;
    this.ttlMs = resolvedOptions.ttlMs ?? DEFAULT_SNAPSHOT_CACHE_TTL_MS;
    this.keyPrefix = resolvedOptions.keyPrefix ?? 'snap:';
    this.allowPlaintextCache = resolvedOptions.allowPlaintextCache ?? false;
  }

  /** The cache is in-process; locality is whatever the wrapped store declares (#1356). */
  get storageLocality(): StorageLocality | undefined { return this.underlying.storageLocality; }

  /**
   * Delegating, never a literal (#960).  This decorator forwards `options`
   * to the wrapped store verbatim and adds no codec of its own, so its
   * support genuinely *is* the inner store's — a hard-coded `false` would
   * refuse an actor whose object-storage store can encrypt, and a hard-coded
   * `true` would wave one through over Postgres.  Undefined delegates too:
   * a wrapper that turned "unknown" into a confident answer would be the one
   * way this member could start lying.
   *
   * Note this reports the *inner store's* at-rest behaviour and says nothing
   * about the cache, which holds decoded snapshots in whatever cache is
   * wired — see the security section on the class (#782).  A `true` here is
   * not the acknowledgement `allowPlaintextCache` is; if anything it is the
   * signal that the acknowledgement is worth asking for.
   */
  get persistenceOptionSupport(): PersistenceOptionSupport | undefined {
    return this.underlying.persistenceOptionSupport;
  }

  /** Identity is the wrapped store's, for the same reason (#1358). */
  async storageIdentity(): Promise<string> {
    if (this.underlying.storageIdentity === undefined) {
      throw new JournalError('CachedSnapshotStore.storageIdentity: the wrapped store declares none');
    }
    return this.underlying.storageIdentity();
  }

  async save<S>(persistenceId: string, seq: number, state: S, options?: PersistenceOptions): Promise<Snapshot<S>> {
    const written = await this.underlying.save<S>(persistenceId, seq, state, options);
    // Invalidate, do NOT write — see class doc for the cluster-race rationale.
    await this.cache.delete(this.keyFor(persistenceId));
    return written;
  }

  async loadLatest<S>(persistenceId: string, options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    if (this.refusesPlaintextCache(options)) return this.underlying.loadLatest<S>(persistenceId, options);
    const key = this.keyFor(persistenceId);
    const hit = await this.cache.get<CachedSnapshot<S>>(key);
    if (hit.isSome()) return some(hit.value as Snapshot<S>);
    const fetched = await this.underlying.loadLatest<S>(persistenceId, options);
    if (fetched.isNone()) return none;
    await this.cache.set<CachedSnapshot<S>>(key, fetched.value, this.ttlMs);
    return fetched;
  }

  async loadBefore<S>(persistenceId: string, seq: number, options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    // Not cached — see class doc.
    return this.underlying.loadBefore<S>(persistenceId, seq, options);
  }

  async delete(persistenceId: string, toSeq: number): Promise<void> {
    await this.underlying.delete(persistenceId, toSeq);
    await this.cache.delete(this.keyFor(persistenceId));
  }

  async close(): Promise<void> {
    await this.underlying.close?.();
    // We do NOT close the cache — it's owned by the caller (the same
    // cache typically backs HTTP middleware, etc.).
  }

  private keyFor(persistenceId: string): string {
    return `${this.keyPrefix}${persistenceId}`;
  }

  /**
   * Whether this call's state must not enter the cache — see the security
   * section on the class (#782).  Warns on the first refusal only, because
   * the condition is a deployment-shaped one: it holds for every load of
   * every entity, and a line per cold start is a line nobody reads.
   *
   * `{ mode: 'none' }` is not a refusal.  It is the explicit way to say
   * "deliberately unprotected", exactly as `unhonouredPersistenceOptions`
   * treats it, and turning an opt-*out* into a cache bypass would be the one
   * shape of this check nobody would expect.
   */
  private refusesPlaintextCache(options: PersistenceOptions | undefined): boolean {
    if (this.allowPlaintextCache) return false;
    if (options?.encryption === undefined || options.encryption.mode === 'none') return false;
    if (!this.reportedPlaintextCache) {
      this.reportedPlaintextCache = true;
      console.warn(plaintextCacheWarning(this.underlying.constructor.name));
    }
    return true;
  }
}
