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
