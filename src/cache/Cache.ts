import type { Option } from '../util/Option.js';

/**
 * Generic distributed-cache abstraction — used by HTTP middleware
 * (response-cache, rate-limit, idempotency-key) and the optional
 * `CachedSnapshotStore` decorator.  Three implementations ship:
 *
 *   - `InMemoryCache`  — single-process Map; default, ideal for tests/dev.
 *   - `RedisCache`     — wraps `ioredis` (optional peer dependency).
 *   - `MemcachedCache` — wraps `memjs` (optional peer dependency).
 *
 * The surface is intentionally small.  Seven operations cover ~95% of the
 * real cases in this codebase; we deliberately exclude pattern-scans
 * (anti-pattern at scale) and pub/sub (already provided by the cluster
 * layer).  Bulk `mget` / `mset` (#14) cut round-trips for the hot
 * sharded-entity-hydration path after a rebalance.
 *
 * **Failure model:** a cache is opportunistic by definition.  Backends
 * are encouraged to *return* a sensible default rather than throw on
 * transient connection errors — `get` returning None on network failure
 * is fine, since the caller's job is to fall back to the source of
 * truth anyway.  Exceptions are reserved for misuse (invalid TTL, etc).
 */
export interface Cache {
  /** Get a value; returns None on miss, expiry, or transient backend failure. */
  get<V = unknown>(key: string): Promise<Option<V>>;

  /** Set a value with optional TTL (milliseconds).  Omitting `ttlMs` means no expiry. */
  set<V = unknown>(key: string, value: V, ttlMs?: number): Promise<void>;

  /**
   * Atomic increment by 1 — returns the **new** value.  When `ttlMs` is
   * supplied AND the key was newly created (counter value is 1 after
   * the call), the TTL is set; subsequent increments do not refresh it.
   * This is the right semantics for a fixed-window rate-limiter.
   */
  incr(key: string, ttlMs?: number): Promise<number>;

  /**
   * Set only if the key does not yet exist.  Returns true on success
   * (the value was stored), false on collision (someone else got there
   * first).  Used as the kernel of idempotency-key dedup.
   *
   * **Atomicity is a hard guarantee, not best effort.**  Every backend
   * maps this onto a single native compare-and-set primitive — Redis
   * `SET … NX`, Memcached `ADD`, and a `Map` read/write pair that the
   * single-threaded event loop cannot interleave.  No backend may
   * implement it as `get`-then-`set`: that pair has a window in which
   * two callers both observe the key absent and both write, and every
   * caller of this method is relying on exactly one of them winning.
   * Contention is therefore safe by construction — with N concurrent
   * callers, precisely one sees `true`.
   *
   * The atomicity is **per key on one server**.  It does not survive a
   * Memcached cluster whose topology changes mid-flight, where a key can
   * be rehashed onto a server that has never seen it (see the Memcached
   * page); nor does it coordinate across Redis instances that are not
   * the same logical keyspace.
   *
   * And atomicity says nothing about **durability for the entry's TTL**:
   * any backend that evicts under pressure can drop the winning write
   * early, at which point the next caller wins the same key while the
   * first still believes it holds it.  This is not an exotic
   * configuration — it is the default one.  `InMemoryCache` is
   * LRU-bounded at 10 000 entries out of the box (it prefers to evict
   * entries that carry no guarantee, which covers this method's writes,
   * but the bound is still hard); Memcached's eviction is server-side
   * LRU with no client-side policy at all; and Redis under
   * `maxmemory-policy allkeys-lru` behaves the same.  So size the cache
   * for the number of live claims and don't share the instance with a
   * consumer whose key space a caller can enumerate.
   *
   * `ttlMs` is applied **only on the write that wins** — a losing call
   * leaves the incumbent entry's expiry untouched, so a retry loop can
   * never extend someone else's hold.  Sub-second precision is
   * backend-dependent: Memcached's protocol is second-granular and
   * rounds up, with a 1 s floor.
   *
   * **Pass a `ttlMs` whenever this is used as a lock.**  The pair
   * "acquire, then release by deleting" has no owner-side recovery: if
   * the holder crashes, is paused past its deadline, or loses the
   * network before it deletes the key, nothing else will ever remove
   * that entry.  Without a TTL the lock is wedged until an operator
   * intervenes; with one, the TTL bounds the maximum stall.  It is not
   * the *only* way the entry can vanish, though — eviction is the other
   * one, and it needs no crash and respects no deadline.  See
   * `acquireLock` in `CacheLock.ts` for a helper that wraps this in a
   * token-checked release, so a holder whose TTL already lapsed cannot
   * free the next owner's lock.
   */
  setIfAbsent<V = unknown>(key: string, value: V, ttlMs?: number): Promise<boolean>;

  /** Delete one or many keys.  Idempotent — missing keys are a no-op. */
  delete(...keys: string[]): Promise<void>;

  /**
   * Bulk get (#14) — fetch multiple keys in a single round-trip when
   * the backend supports it.  Returns a `Map` keyed by the input
   * keys; misses (no entry, expired, malformed payload, transient
   * backend failure) are simply absent from the result rather than
   * mapped to `undefined`.  `Map.get(k)` therefore returns `V |
   * undefined` with the same "missing key" semantics as the
   * single-key `get`.
   *
   * Order of the returned Map matches the order of the input keys
   * for backends that support it (Redis MGET); backends that fall
   * back to parallel single-key reads (Memcached) may surface a
   * different iteration order — don't rely on it.
   */
  mget<V = unknown>(keys: ReadonlyArray<string>): Promise<Map<string, V>>;

  /**
   * Bulk set (#14) — write multiple key/value pairs with a shared
   * TTL.  The atomicity guarantee is per backend: Redis emits a
   * single `MSET` (no-TTL) or pipelined `SET ... PX` (with-TTL);
   * Memcached has no native bulk write so the calls go out in
   * parallel.  Single-process backends (InMemory) trivially see
   * the whole bag at once.  `ttlMs` applies to every entry.
   */
  mset<V = unknown>(entries: ReadonlyMap<string, V>, ttlMs?: number): Promise<void>;

  /** Best-effort teardown.  Idempotent. */
  close?(): Promise<void>;
}

/** Generic cache failure — backends may extend this. */
export class CacheError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CacheError';
  }
}
