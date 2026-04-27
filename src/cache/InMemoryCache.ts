import { none, some, type Option } from '../util/Option.js';
import type { Cache } from './Cache.js';

/**
 * In-process `Cache` backed by a plain `Map`.  Lazy-expiry: an entry's
 * `expiresAt` is checked at every `get`/`incr`/`setIfAbsent`, so stale
 * entries don't linger after their TTL — but we don't run a background
 * sweep either (no timers, no GC pressure surprise).
 *
 * Suitable for tests, single-process dev servers, and as a per-process
 * front-end to a slower remote cache.  Not suitable for multi-process
 * coordination (use `RedisCache` for that).
 */
interface Entry {
  value: unknown;
  /** Absolute timestamp in ms.  `Infinity` means "no TTL". */
  expiresAt: number;
}

export class InMemoryCache implements Cache {
  private readonly store = new Map<string, Entry>();

  async get<V>(key: string): Promise<Option<V>> {
    const entry = this.store.get(key);
    if (!entry) return none;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return none;
    }
    return some(entry.value as V);
  }

  async set<V>(key: string, value: V, ttlMs?: number): Promise<void> {
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error(`InMemoryCache.set: ttlMs must be a positive finite number, got ${ttlMs}`);
    }
    const expiresAt = ttlMs === undefined ? Infinity : Date.now() + ttlMs;
    this.store.set(key, { value, expiresAt });
  }

  async incr(key: string, ttlMs?: number): Promise<number> {
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error(`InMemoryCache.incr: ttlMs must be a positive finite number, got ${ttlMs}`);
    }
    const now = Date.now();
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= now) {
      // Fresh counter — set TTL only on creation, matching Redis semantics.
      const expiresAt = ttlMs === undefined ? Infinity : now + ttlMs;
      this.store.set(key, { value: 1, expiresAt });
      return 1;
    }
    if (typeof entry.value !== 'number') {
      throw new Error(`InMemoryCache.incr: key '${key}' holds a non-numeric value (${typeof entry.value})`);
    }
    const next = entry.value + 1;
    entry.value = next;
    return next;
  }

  async setIfAbsent<V>(key: string, value: V, ttlMs?: number): Promise<boolean> {
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error(`InMemoryCache.setIfAbsent: ttlMs must be a positive finite number, got ${ttlMs}`);
    }
    const now = Date.now();
    const entry = this.store.get(key);
    if (entry && entry.expiresAt > now) return false;
    const expiresAt = ttlMs === undefined ? Infinity : now + ttlMs;
    this.store.set(key, { value, expiresAt });
    return true;
  }

  async delete(...keys: string[]): Promise<void> {
    for (const k of keys) this.store.delete(k);
  }

  async close(): Promise<void> {
    this.store.clear();
  }

  /** Test hook — current entry count, including expired-but-not-cleaned entries. */
  sizeForTest(): number { return this.store.size; }
}
