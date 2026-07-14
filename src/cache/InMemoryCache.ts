import { none, some, type Option } from '../util/Option.js';
import type { Cache } from './Cache.js';

/**
 * In-process `Cache` backed by a `Map` with **LRU eviction** and per-entry
 * TTL.
 *
 * Bounded by `maxEntries` (default 10 000): inserting a new key beyond the cap
 * evicts the least-recently-used entry, so a flood of distinct keys — e.g.
 * attacker-chosen `Idempotency-Key` or rate-limit keys — cannot grow the map
 * without limit (security audit HTTP-2).  Set `maxEntries: Infinity` to opt
 * out (unbounded — OOMs eventually; only do this when you control the key
 * space).
 *
 * Expiry has two paths: **lazy** (checked on every `get`/`incr`/`setIfAbsent`/
 * `mget`) and an optional **periodic sweep** every `cleanupMs` (default
 * 60 000) that reclaims expired-but-never-re-read entries.  Set `cleanupMs` to
 * `0` / `Infinity` to disable the background sweep.
 *
 * Suitable for tests, single-process dev servers, and as a per-process
 * front-end to a slower remote cache.  Not suitable for multi-process
 * coordination (use `RedisCache` for that).
 */
export interface InMemoryCacheSettings {
  /** LRU cap on stored entries.  Default 10 000.  `Infinity` = unbounded. */
  readonly maxEntries?: number;
  /**
   * How often (ms) to sweep expired entries in the background.  Default
   * 60 000.  `0` / `Infinity` disables the sweep (lazy expiry still applies
   * on access).
   */
  readonly cleanupMs?: number;
}

interface Entry {
  value: unknown;
  /** Absolute timestamp in ms.  `Infinity` means "no TTL". */
  expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_CLEANUP_MS = 60_000;

export class InMemoryCache implements Cache {
  private readonly store = new Map<string, Entry>();
  private readonly maxEntries: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(settings: InMemoryCacheSettings = {}) {
    const maxEntries = settings.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (maxEntries !== Infinity && (!Number.isInteger(maxEntries) || maxEntries < 1)) {
      throw new Error(
        `InMemoryCache: maxEntries must be a positive integer or Infinity, got ${maxEntries}`,
      );
    }
    this.maxEntries = maxEntries;

    const cleanupMs = settings.cleanupMs ?? DEFAULT_CLEANUP_MS;
    if (Number.isFinite(cleanupMs) && cleanupMs > 0) {
      this.sweepTimer = setInterval(() => this.sweepExpired(), cleanupMs);
      // Best-effort: the sweep must not keep the process alive on its own.
      (this.sweepTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  async get<V>(key: string): Promise<Option<V>> {
    const entry = this.store.get(key);
    if (!entry) return none;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return none;
    }
    this.bump(key, entry);
    return some(entry.value as V);
  }

  async set<V>(key: string, value: V, ttlMs?: number): Promise<void> {
    this.assertTtl('set', ttlMs);
    const expiresAt = ttlMs === undefined ? Infinity : Date.now() + ttlMs;
    this.evictIfNeeded(key);
    this.store.set(key, { value, expiresAt });
  }

  async incr(key: string, ttlMs?: number): Promise<number> {
    this.assertTtl('incr', ttlMs);
    const now = Date.now();
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= now) {
      // Fresh counter — set TTL only on creation, matching Redis semantics.
      const expiresAt = ttlMs === undefined ? Infinity : now + ttlMs;
      this.evictIfNeeded(key);
      this.store.set(key, { value: 1, expiresAt });
      return 1;
    }
    if (typeof entry.value !== 'number') {
      throw new Error(`InMemoryCache.incr: key '${key}' holds a non-numeric value (${typeof entry.value})`);
    }
    const next = entry.value + 1;
    entry.value = next;
    this.bump(key, entry);
    return next;
  }

  async setIfAbsent<V>(key: string, value: V, ttlMs?: number): Promise<boolean> {
    this.assertTtl('setIfAbsent', ttlMs);
    const now = Date.now();
    const entry = this.store.get(key);
    if (entry && entry.expiresAt > now) return false;
    const expiresAt = ttlMs === undefined ? Infinity : now + ttlMs;
    this.evictIfNeeded(key);
    this.store.set(key, { value, expiresAt });
    return true;
  }

  async delete(...keys: string[]): Promise<void> {
    for (const k of keys) this.store.delete(k);
  }

  async mget<V>(keys: ReadonlyArray<string>): Promise<Map<string, V>> {
    const out = new Map<string, V>();
    const now = Date.now();
    for (const k of keys) {
      const entry = this.store.get(k);
      if (!entry) continue;
      if (entry.expiresAt <= now) {
        this.store.delete(k);    // lazy-expire matches `get` semantics
        continue;
      }
      this.bump(k, entry);
      out.set(k, entry.value as V);
    }
    return out;
  }

  async mset<V>(entries: ReadonlyMap<string, V>, ttlMs?: number): Promise<void> {
    this.assertTtl('mset', ttlMs);
    const expiresAt = ttlMs === undefined ? Infinity : Date.now() + ttlMs;
    for (const [k, v] of entries) {
      this.evictIfNeeded(k);
      this.store.set(k, { value: v, expiresAt });
    }
  }

  async close(): Promise<void> {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.store.clear();
  }

  /** Test hook — current entry count, including expired-but-not-cleaned entries. */
  sizeForTest(): number { return this.store.size; }

  /* ------------------------------ internals ------------------------------ */

  private assertTtl(op: string, ttlMs?: number): void {
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error(`InMemoryCache.${op}: ttlMs must be a positive finite number, got ${ttlMs}`);
    }
  }

  /** Move a still-valid entry to the tail so it counts as most-recently-used. */
  private bump(key: string, entry: Entry): void {
    // Re-insertion moves the key to the end of the Map's iteration order,
    // so the first key stays the least-recently-used (the eviction victim).
    this.store.delete(key);
    this.store.set(key, entry);
  }

  /**
   * Evict least-recently-used entries until there is room for a NEW key.
   * No-op when unbounded (`Infinity`) or when overwriting an existing key
   * (that doesn't grow the map).  The Map's first key is the LRU entry
   * because {@link bump} moves touched keys to the tail.
   */
  private evictIfNeeded(incomingKey: string): void {
    if (!Number.isFinite(this.maxEntries)) return;
    if (this.store.has(incomingKey)) return;
    while (this.store.size >= this.maxEntries) {
      const lru = this.store.keys().next().value as string | undefined;
      if (lru === undefined) break;
      this.store.delete(lru);
    }
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [k, e] of this.store) {
      if (e.expiresAt <= now) this.store.delete(k);
    }
  }
}
