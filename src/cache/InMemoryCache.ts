import { none, some, type Option } from '../util/Option.js';
import type { Cache } from './Cache.js';
import {
  DEFAULT_CLEANUP_MS,
  DEFAULT_MAX_ENTRIES,
  InMemoryCacheOptionsValidator,
  type InMemoryCacheOptions,
  type InMemoryCacheOptionsType,
} from './InMemoryCacheOptions.js';

type Entry = {
  value: unknown;
  /** Absolute timestamp in ms.  `Infinity` means "no TTL". */
  expiresAt: number;
};

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
 * **Eviction chooses its victim by what an entry carries, then by recency**
 * (security audit HTTP-8, #1080).  The map is kept in two halves and the
 * write that created an entry decides which half it lands in:
 *
 *   - **Guarantee-carrying** — a `setIfAbsent` claim (a lock, an idempotency
 *     marker) or an `incr` counter (a rate-limit window), *with a finite TTL*.
 *     For these the cache IS the source of truth: dropping one does not cost a
 *     round-trip, it voids the guarantee — the lock gets handed out a second
 *     time, the limit resets, the retry re-executes the handler.
 *   - **Opportunistic** — everything written by `set` / `mset`.  Per
 *     {@link Cache}'s failure model these have a source of truth behind them,
 *     so losing one is a cache miss and the caller already handles it.
 *
 * A victim is taken from the opportunistic half first, least-recently-used
 * end onwards.  So a flood of distinct response-cache keys can no longer push
 * a live lock or another client's rate-limit counter out — which it could
 * before, at the *default* configuration.
 *
 * **The bound is unchanged, and that is the hard upper limit.**  Carrying a
 * guarantee re-orders the victims; it never blocks an eviction.  When every
 * entry in the map carries one — a cache holding nothing but locks, or one
 * flooded through `setIfAbsent` itself — the least-recently-used of *those*
 * goes, so the map still never exceeds `maxEntries` and HTTP-2's bound holds
 * exactly as before.  Which is also the limit of the guarantee: size
 * `maxEntries` above the number of claims, counters and locks live inside one
 * TTL, give each consumer its own named cache (`ext.cache('rate-limit')`,
 * `ext.cache('idempotency')`) and size *that* instance for its own key space
 * under `actor-ts.cache.<name>.in-memory` (#607 — before it, the name reached
 * the registry but not the settings, so every named instance shared one
 * bound), and where the guarantee must hold against an adversary use
 * `RedisCache` — a cache the framework does not evict at all.
 *
 * Three things this deliberately does not do.  A guarantee you store yourself
 * with `set` is indistinguishable from a cached body and is *not* protected —
 * except in the one case where it replaces a live claim under the same key,
 * which is how an idempotency record inherits its marker's protection.  A
 * claim with **no** TTL is not protected either: an unbounded lock is the
 * wedge {@link Cache.setIfAbsent} warns about, and pinning one would make it
 * permanent.  And it cannot follow a remote backend — Redis under
 * `maxmemory-policy allkeys-lru` and Memcached both evict server-side, where
 * no client-side policy reaches.
 *
 * Which operations count as a "use" matters for the same reason, and is
 * narrower than it looks: only `get`, `incr` and `mget` move a key to the
 * most-recently-used end.  `set`, `mset` and `setIfAbsent` do not, so an
 * entry that is written once and never read back — an idempotency record
 * still waiting for the client's retry — ages towards eviction from the
 * moment it is stored, and stays the first victim within its own half.
 *
 * Expiry has two paths: **lazy** (checked on every `get`/`incr`/`setIfAbsent`/
 * `mget`) and an optional **periodic sweep** every `cleanupMs` (default
 * 60 000) that reclaims expired-but-never-re-read entries.  Set `cleanupMs` to
 * `0` / `Infinity` to disable the background sweep.  The sweep covers both
 * halves, so a claim whose holder crashed stops occupying a slot at its TTL
 * rather than at the end of its consumer's retry window.
 *
 * Configure via an {@link InMemoryCacheOptions} builder or plain object; through
 * the {@link CacheExtension} the same fields resolve from the HOCON block
 * `actor-ts.cache.in-memory` (every in-memory instance) with
 * `actor-ts.cache.<name>.in-memory` layered on top (just the instance resolved
 * as `<name>`).  Out-of-range values throw `OptionsError`.
 *
 * Suitable for tests, single-process dev servers, and as a per-process
 * front-end to a slower remote cache.  Not suitable for multi-process
 * coordination (use `RedisCache` for that).
 */
export class InMemoryCache implements Cache {
  /**
   * Entries whose loss is a cache miss — every `set` / `mset` write.  Drained
   * first by {@link evictIfNeeded}, so this half absorbs a key flood on its
   * own for as long as it is non-empty.
   */
  private readonly opportunistic = new Map<string, Entry>();
  /**
   * Entries whose loss voids a guarantee, and every one of them has a finite
   * TTL — see the class header.  Held in a second `Map` rather than behind a
   * flag on {@link Entry} for two reasons: victim selection stays O(1) (the
   * alternative is scanning past pinned entries on the hot path of every
   * insert), and an overwrite that replaces the `Entry` object cannot silently
   * drop the marking, because the marking is the membership.
   */
  private readonly guaranteed = new Map<string, Entry>();
  private readonly maxEntries: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: InMemoryCacheOptions = {}) {
    const settings: Partial<InMemoryCacheOptionsType> = { ...(options as Partial<InMemoryCacheOptionsType>) };
    new InMemoryCacheOptionsValidator().validate(settings);
    this.maxEntries = settings.maxEntries ?? DEFAULT_MAX_ENTRIES;

    const cleanupMs = settings.cleanupMs ?? DEFAULT_CLEANUP_MS;
    if (Number.isFinite(cleanupMs) && cleanupMs > 0) {
      this.sweepTimer = setInterval(() => this.sweepExpired(), cleanupMs);
      // Best-effort: the sweep must not keep the process alive on its own.
      (this.sweepTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  async get<V>(key: string): Promise<Option<V>> {
    const entry = this.lookup(key);
    if (!entry) return none;
    if (entry.expiresAt <= Date.now()) {
      this.remove(key);
      return none;
    }
    this.bump(key, entry);
    return some(entry.value as V);
  }

  async set<V>(key: string, value: V, ttlMs?: number): Promise<void> {
    this.assertTtl('set', ttlMs);
    const now = Date.now();
    const expiresAt = ttlMs === undefined ? Infinity : now + ttlMs;
    // Read the incumbent before evicting: `evictIfNeeded` leaves an existing
    // key alone, but the order is what makes that independent of it.
    const carriesGuarantee = this.inheritsGuarantee(key, now, expiresAt);
    this.evictIfNeeded(key);
    this.write(key, { value, expiresAt }, carriesGuarantee);
  }

  async incr(key: string, ttlMs?: number): Promise<number> {
    this.assertTtl('incr', ttlMs);
    const now = Date.now();
    const entry = this.lookup(key);
    if (!entry || entry.expiresAt <= now) {
      // Fresh counter — set TTL only on creation, matching Redis semantics.
      const expiresAt = ttlMs === undefined ? Infinity : now + ttlMs;
      this.evictIfNeeded(key);
      this.write(key, { value: 1, expiresAt }, Number.isFinite(expiresAt));
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
    const entry = this.lookup(key);
    if (entry && entry.expiresAt > now) return false;
    const expiresAt = ttlMs === undefined ? Infinity : now + ttlMs;
    this.evictIfNeeded(key);
    this.write(key, { value, expiresAt }, Number.isFinite(expiresAt));
    return true;
  }

  async delete(...keys: string[]): Promise<void> {
    for (const key of keys) this.remove(key);
  }

  async mget<V>(keys: ReadonlyArray<string>): Promise<Map<string, V>> {
    const out = new Map<string, V>();
    const now = Date.now();
    for (const key of keys) {
      const entry = this.lookup(key);
      if (!entry) continue;
      if (entry.expiresAt <= now) {
        this.remove(key);          // lazy-expire matches `get` semantics
        continue;
      }
      this.bump(key, entry);
      out.set(key, entry.value as V);
    }
    return out;
  }

  async mset<V>(entries: ReadonlyMap<string, V>, ttlMs?: number): Promise<void> {
    this.assertTtl('mset', ttlMs);
    const now = Date.now();
    const expiresAt = ttlMs === undefined ? Infinity : now + ttlMs;
    for (const [key, value] of entries) {
      const carriesGuarantee = this.inheritsGuarantee(key, now, expiresAt);
      this.evictIfNeeded(key);
      this.write(key, { value, expiresAt }, carriesGuarantee);
    }
  }

  async close(): Promise<void> {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.opportunistic.clear();
    this.guaranteed.clear();
  }

  /** Test hook — current entry count, including expired-but-not-cleaned entries. */
  sizeForTest(): number { return this.opportunistic.size + this.guaranteed.size; }

  /* ------------------------------ internals ------------------------------ */

  private assertTtl(op: string, ttlMs?: number): void {
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error(`InMemoryCache.${op}: ttlMs must be a positive finite number, got ${ttlMs}`);
    }
  }

  /** The entry under `key`, from whichever half holds it. */
  private lookup(key: string): Entry | undefined {
    return this.guaranteed.get(key) ?? this.opportunistic.get(key);
  }

  /** Forget `key` entirely.  A key lives in exactly one half, so this is total. */
  private remove(key: string): void {
    this.guaranteed.delete(key);
    this.opportunistic.delete(key);
  }

  /**
   * Whether a `set` / `mset` write should keep the guarantee already on this
   * key.
   *
   * The case this exists for: `idempotent` claims a key with `setIfAbsent`
   * and then *replaces* the marker with the finished response via `set`.  Both
   * halves of that pair have to be protected or the record is exposed for the
   * whole window a client's retry lives in — which is the one the double
   * charge falls through.  Inheritance is deliberately narrow, because `set`
   * must never *manufacture* a guarantee: every cached response body is a
   * finite-TTL `set`, and protecting those would protect nothing.
   *
   * Both conditions are load-bearing.  The incumbent must still be live, or a
   * lapsed claim would keep conferring protection on unrelated later writes to
   * the same key; and the new entry needs a finite TTL of its own, which keeps
   * "every guaranteed entry expires" true and so keeps the protection
   * self-releasing.
   */
  private inheritsGuarantee(key: string, now: number, expiresAt: number): boolean {
    if (!Number.isFinite(expiresAt)) return false;
    const held = this.guaranteed.get(key);
    return held !== undefined && held.expiresAt > now;
  }

  /**
   * Store `entry` in the half `carriesGuarantee` selects, dropping any copy
   * from the other one.
   *
   * Re-inserting into the half it already sits in leaves the iteration order
   * alone — `Map.set` on a present key does not move it — which is what keeps
   * "an overwrite is not a use" true.
   */
  private write(key: string, entry: Entry, carriesGuarantee: boolean): void {
    if (carriesGuarantee) {
      this.opportunistic.delete(key);
      this.guaranteed.set(key, entry);
      return;
    }
    this.guaranteed.delete(key);
    this.opportunistic.set(key, entry);
  }

  /** Move a still-valid entry to the tail so it counts as most-recently-used. */
  private bump(key: string, entry: Entry): void {
    // Re-insertion moves the key to the end of its half's iteration order, so
    // the first key of a half stays its least-recently-used (the victim).
    const half = this.guaranteed.has(key) ? this.guaranteed : this.opportunistic;
    half.delete(key);
    half.set(key, entry);
  }

  /**
   * Evict entries until there is room for a NEW key.
   * No-op when unbounded (`Infinity`) or when overwriting an existing key
   * (that doesn't grow the map).
   *
   * Victims come out of the opportunistic half while it has any, then out of
   * the guaranteed one — least-recently-used first within whichever half is
   * being drained, because {@link bump} moves touched keys to that half's
   * tail.  Both steps are O(1), and the fall-through to the guaranteed half is
   * what keeps `maxEntries` a hard cap rather than an aspiration: protecting
   * an entry can delay its eviction but can never grow the map.
   */
  private evictIfNeeded(incomingKey: string): void {
    if (!Number.isFinite(this.maxEntries)) return;
    if (this.guaranteed.has(incomingKey) || this.opportunistic.has(incomingKey)) return;
    while (this.opportunistic.size + this.guaranteed.size >= this.maxEntries) {
      const half = this.opportunistic.size > 0 ? this.opportunistic : this.guaranteed;
      const leastRecentlyUsed = half.keys().next().value as string | undefined;
      if (leastRecentlyUsed === undefined) break;
      half.delete(leastRecentlyUsed);
    }
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const half of [this.opportunistic, this.guaranteed]) {
      for (const [key, entry] of half) {
        if (entry.expiresAt <= now) half.delete(key);
      }
    }
  }
}
