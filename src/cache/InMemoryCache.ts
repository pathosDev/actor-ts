import { none, some, type Option } from '../util/Option.js';
import type { Cache } from './Cache.js';
import {
  DEFAULT_CLEANUP_MS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TIME_TO_IDLE_MS,
  DEFAULT_TIME_TO_LIVE_MS,
  InMemoryCacheOptionsValidator,
  type InMemoryCacheOptions,
  type InMemoryCacheOptionsType,
} from './InMemoryCacheOptions.js';

type Entry = {
  value: unknown;
  /** Absolute timestamp in ms.  `Infinity` means "no TTL". */
  expiresAt: number;
  /**
   * Ceiling a `timeToIdleMs` extension may not push {@link expiresAt} past —
   * and, by being present at all, the marker that this entry may be extended.
   *
   * Only a `set` / `mset` whose caller named no `ttlMs` carries one, which is
   * what keeps an explicit TTL explicit: a caller who asked for 30 s gets
   * 30 s, whatever the configured idle window says.  `Infinity` when
   * `timeToLiveMs` is off and only the idle window is on, so the entry slides
   * forward with no lifetime bound; absent on every entry when
   * `timeToIdleMs` is off, so an unconfigured cache stores exactly the two
   * fields it always did.
   */
  expiryCeiling?: number;
};

/** An entry's expiry, and the ceiling any idle extension of it is clamped to. */
type EntryExpiry = {
  readonly expiresAt: number;
  readonly expiryCeiling?: number;
};

/**
 * One key prefix's share of the map — its two halves and the reservation
 * that bounds them.
 *
 * The unreserved remainder is a bucket too, with a `quota` of `Infinity`:
 * that way the number of buckets is the only thing `prefixQuotas` changes,
 * and an unconfigured cache is one bucket behaving exactly as the single
 * undivided map did.
 */
type Bucket = {
  /**
   * Entries whose loss is a cache miss — every `set` / `mset` write.  Drained
   * first when this bucket has to give up an entry, so it absorbs a key flood
   * on its own for as long as it is non-empty.
   */
  readonly opportunistic: Map<string, Entry>;
  /**
   * Entries whose loss voids a guarantee, and every one of them has a finite
   * TTL — see the class header.  Held in a second `Map` rather than behind a
   * flag on {@link Entry} for two reasons: victim selection stays O(1) (the
   * alternative is scanning past pinned entries on the hot path of every
   * insert), and an overwrite that replaces the `Entry` object cannot silently
   * drop the marking, because the marking is the membership.
   */
  readonly guaranteed: Map<string, Entry>;
  /** Entries this prefix may hold, and holds against everyone else.  `Infinity` for the remainder. */
  readonly quota: number;
};

/** Entries currently in `bucket`, across both halves. */
function bucketSize(bucket: Bucket): number {
  return bucket.opportunistic.size + bucket.guaranteed.size;
}

function newBucket(quota: number): Bucket {
  return { opportunistic: new Map<string, Entry>(), guaranteed: new Map<string, Entry>(), quota };
}

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
 * **Eviction chooses its victim in three steps: by key prefix, then by what
 * an entry carries, then by recency** (security audit HTTP-8, #1080, #607).
 *
 * *Step one — the prefix (`prefixQuotas`, off by default).*  A quota splits
 * the map into per-prefix buckets plus an unreserved remainder, and is a cap
 * and a reservation at once: a prefix that has reached its quota takes its
 * next victim from inside itself, and the entries it holds below its quota
 * are not available to anyone else.  That is what makes "an `rsp:` insert can
 * only evict `rsp:` entries" true — a caller who mints keys under one prefix
 * evicts only that prefix's own entries, whichever half of the map they sit
 * in.  Unset, there is one bucket and this step does nothing, which is the
 * behaviour of every release before #607.
 *
 * *Step two — the guarantee.*  Inside a bucket the map is kept in two halves,
 * and which one an entry lands in follows from the **call** that touched it
 * last, not from the kind of value it holds:
 *
 *   - **Guarantee-carrying** — a `setIfAbsent` claim (a lock, an idempotency
 *     marker) or a counter any `incr` has passed over (a rate-limit window),
 *     *with a finite TTL*.  For these the cache IS the source of truth:
 *     dropping one does not cost a round-trip, it voids the guarantee — the
 *     lock gets handed out a second time, the limit resets, the retry
 *     re-executes the handler.  `incr` **adopts** a live counter whoever
 *     seeded it, so a window opened with `set(key, 0, windowMs)` and then
 *     driven by `incr` is protected exactly like one `incr` created (#1295).
 *   - **Opportunistic** — everything written by `set` / `mset`.  Per
 *     {@link Cache}'s failure model these have a source of truth behind them,
 *     so losing one is a cache miss and the caller already handles it.
 *
 * A victim is taken from the opportunistic half first.  So a flood of distinct
 * response-cache keys can no longer push a live lock or another client's
 * rate-limit counter out — which it could before, at the *default*
 * configuration.
 *
 * *Step three — recency.*  Least-recently-used end onwards, within whichever
 * half of whichever bucket is being drained.
 *
 * **The bound is unchanged, and that is the hard upper limit.**  Prefix and
 * guarantee re-order the victims; neither blocks an eviction.  When a bucket
 * holds nothing but guarantee-carrying entries the least-recently-used of
 * *those* goes, and when the quotas reserve the whole map an unreserved write
 * still takes a slot from somewhere — so the map never exceeds `maxEntries`
 * and HTTP-2's bound holds exactly as before.
 *
 * Which is also where the guarantee stops.  A quota bounds a *prefix*, not a
 * *caller*: two clients minting `Idempotency-Key`s share the `idem:` bucket
 * and still evict each other, and no split of this map fixes that, because
 * the key space they compete over is one an attacker writes into.  What is
 * left is the same advice as before, now with a fourth option in front of it:
 * divide a shared instance with `prefixQuotas`; size `maxEntries` above the
 * number of claims, counters and locks live inside one TTL; give each
 * consumer its own named cache (`ext.cache('rate-limit')`,
 * `ext.cache('idempotency')`) and size *that* instance under
 * `actor-ts.cache.<name>.in-memory`; and where the guarantee must hold
 * against an adversary use `RedisCache` — a cache the framework does not
 * evict at all.
 *
 * Three things this deliberately does not do.  A guarantee you store yourself
 * with `set` is indistinguishable from a cached body and is *not* protected —
 * except where a *later* call recognises it, of which there are exactly two:
 * a `set` replacing a live claim under the same key, which is how an
 * idempotency record inherits its marker's protection, and an `incr` over a
 * live finite-TTL entry, which adopts it as the counter it evidently is.  A
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
 * `0` / `Infinity` to disable the background sweep.  The sweep covers every
 * bucket and both halves, so a claim whose holder crashed stops occupying a
 * slot at its TTL rather than at the end of its consumer's retry window.
 *
 * **Two configured expiry policies, and both stop at the same line.**
 * `timeToLiveMs` stamps a lifetime on an entry whose writer named no `ttlMs`,
 * and `timeToIdleMs` pushes that lifetime out again on every read, never past
 * the `timeToLiveMs` deadline.  Both are off (`0`) by default, and both cover
 * **`set` and `mset` only** — the two calls {@link Cache}'s failure model
 * calls opportunistic, where losing an entry is a cache miss the caller
 * already handles.
 *
 * `incr` and `setIfAbsent` keep "no `ttlMs` means no expiry" whatever the
 * configuration says, and the idle extension stops at any entry a guarantee
 * has moved into the protected half.  Both halves of that rule are the same
 * argument: for a counter or a claim this cache is the source of truth, so a
 * lifetime it did not ask for releases a lock nobody released, and an idle
 * window it did not ask for keeps a rate-limit window from ever closing and an
 * idempotency claim from ever releasing.  A configuration file may bound the
 * copies; it may not bound the originals.
 *
 * A configured lifetime does widen the protected half in two places, both
 * following existing rules rather than new ones: a `set` replacing a *live*
 * claim now inherits its protection (`inheritsGuarantee` needs a finite
 * expiry, and previously such a write had none), and an `incr` over a
 * `set`-seeded counter now adopts it (#1295 keys that on the entry's expiry
 * being finite).  Both are bounded and self-releasing, because every entry
 * they touch expires.
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
   * The bucket every key that matches no configured prefix falls into.  Also
   * the *only* bucket when `prefixQuotas` is unset, which is why an
   * unconfigured cache pays nothing for the split.
   */
  private readonly unreserved: Bucket = newBucket(Infinity);
  /** Every bucket including {@link unreserved} (under `''`), for whole-map passes. */
  private readonly buckets = new Map<string, Bucket>();
  /**
   * Configured prefixes, **longest first**, so the most specific one claims a
   * key: with `rl:` and `rl:tenant-a:` both reserved, `rl:tenant-a:7` belongs
   * to the latter.  Empty unless `prefixQuotas` was set, and then
   * {@link bucketFor} is a loop over nothing.
   */
  private readonly reservedPrefixes: ReadonlyArray<string>;
  private readonly maxEntries: number;
  /** Configured lifetime for a `ttlMs`-less `set`/`mset`; `0` = no expiry. */
  private readonly timeToLiveMs: number;
  /** Configured idle window a read extends such an entry to; `0` = no extension. */
  private readonly timeToIdleMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: InMemoryCacheOptions = {}) {
    const settings: Partial<InMemoryCacheOptionsType> = { ...(options as Partial<InMemoryCacheOptionsType>) };
    new InMemoryCacheOptionsValidator().validate(settings);
    this.maxEntries = settings.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.timeToLiveMs = settings.timeToLiveMs ?? DEFAULT_TIME_TO_LIVE_MS;
    this.timeToIdleMs = settings.timeToIdleMs ?? DEFAULT_TIME_TO_IDLE_MS;

    this.buckets.set('', this.unreserved);
    const prefixQuotas = settings.prefixQuotas ?? {};
    for (const [prefix, quota] of Object.entries(prefixQuotas)) {
      this.buckets.set(prefix, newBucket(quota));
    }
    this.reservedPrefixes = Object.keys(prefixQuotas).sort((a, b) => b.length - a.length);

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
    const expiry = this.expiryFor(now, ttlMs);
    // Read the incumbent before evicting: `evictIfNeeded` leaves an existing
    // key alone, but the order is what makes that independent of it.
    const carriesGuarantee = this.inheritsGuarantee(key, now, expiry.expiresAt);
    this.evictIfNeeded(key);
    this.write(key, { value, ...expiry }, carriesGuarantee);
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
    // Adopt before bumping, and not instead of it.  `bump` re-inserts into
    // whichever half already holds the key, so on its own it would leave a
    // `set`-seeded counter opportunistic forever (#1295); `write` would move
    // the key but not the recency, because re-inserting into the half a key
    // is already in does not reorder a `Map`.  `incr` owes the entry both.
    if (Number.isFinite(entry.expiresAt)) this.adoptAsGuaranteed(key, entry);
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
    const expiry = this.expiryFor(now, ttlMs);
    for (const [key, value] of entries) {
      const carriesGuarantee = this.inheritsGuarantee(key, now, expiry.expiresAt);
      this.evictIfNeeded(key);
      this.write(key, { value, ...expiry }, carriesGuarantee);
    }
  }

  async close(): Promise<void> {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const bucket of this.buckets.values()) {
      bucket.opportunistic.clear();
      bucket.guaranteed.clear();
    }
  }

  /** Test hook — current entry count, including expired-but-not-cleaned entries. */
  sizeForTest(): number { return this.totalSize(); }

  /**
   * Test hook — entries currently held under the reservation for `prefix`,
   * or in the unreserved remainder for `''`.  Unknown prefixes read `0`
   * rather than throwing: the question "how much of the map does this prefix
   * hold" has a true answer for a prefix nothing reserved, and it is zero
   * because such keys are not in a bucket of their own.
   */
  sizeOfPrefixForTest(prefix: string): number {
    const bucket = this.buckets.get(prefix);
    return bucket === undefined ? 0 : bucketSize(bucket);
  }

  /* ------------------------------ internals ------------------------------ */

  private assertTtl(op: string, ttlMs?: number): void {
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error(`InMemoryCache.${op}: ttlMs must be a positive finite number, got ${ttlMs}`);
    }
  }

  /**
   * The expiry a `set` / `mset` write gets — the caller's `ttlMs` when it
   * named one, and the configured policy otherwise.
   *
   * A caller-named TTL carries no ceiling, so no read ever extends it: the
   * argument is a statement about *this* entry and outranks a number in a
   * config file.  Only the policy branch produces one, which is what makes
   * "extendable" and "written under the policy" the same set.
   *
   * `assertTtl` deliberately does not run over the configured values — it
   * guards a caller argument, where a non-positive or non-finite number is a
   * mistake, while here `0` is the documented off switch and is checked once
   * by {@link InMemoryCacheOptionsValidator} instead.
   */
  private expiryFor(now: number, ttlMs: number | undefined): EntryExpiry {
    if (ttlMs !== undefined) return { expiresAt: now + ttlMs };
    const lifetime = this.timeToLiveMs > 0 ? now + this.timeToLiveMs : Infinity;
    if (this.timeToIdleMs === 0) return { expiresAt: lifetime };
    // Both on: the entry starts at whichever comes first and slides forward
    // on each read, up to the lifetime and no further.
    return { expiresAt: Math.min(lifetime, now + this.timeToIdleMs), expiryCeiling: lifetime };
  }

  /**
   * Push a policy-written entry's expiry out to `now + timeToIdleMs`, clamped
   * to the lifetime it was written with.
   *
   * Never shortens one: `Math.max` against the current expiry keeps an idle
   * window smaller than the remaining lifetime from *cutting* a read entry's
   * life, which would turn a read into a partial delete.  The ceiling is what
   * keeps `timeToLiveMs` an actual lifetime — without it a hot key would live
   * forever and the leaf would be named for something it no longer does.
   */
  private extendIdleWindow(entry: Entry): void {
    if (this.timeToIdleMs === 0 || entry.expiryCeiling === undefined) return;
    entry.expiresAt = Math.min(entry.expiryCeiling, Math.max(entry.expiresAt, Date.now() + this.timeToIdleMs));
  }

  /**
   * The bucket `key` belongs to.  Derived from the key alone and from nothing
   * that changes at runtime, which is what lets every other operation find an
   * entry without recording where it was put.
   */
  private bucketFor(key: string): Bucket {
    for (const prefix of this.reservedPrefixes) {
      if (key.startsWith(prefix)) return this.buckets.get(prefix)!;
    }
    return this.unreserved;
  }

  /** Entries across every bucket and both halves. */
  private totalSize(): number {
    let total = 0;
    for (const bucket of this.buckets.values()) total += bucketSize(bucket);
    return total;
  }

  /** The entry under `key`, from whichever half of its bucket holds it. */
  private lookup(key: string): Entry | undefined {
    const bucket = this.bucketFor(key);
    return bucket.guaranteed.get(key) ?? bucket.opportunistic.get(key);
  }

  /** Forget `key` entirely.  A key lives in exactly one half, so this is total. */
  private remove(key: string): void {
    const bucket = this.bucketFor(key);
    bucket.guaranteed.delete(key);
    bucket.opportunistic.delete(key);
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
    const held = this.bucketFor(key).guaranteed.get(key);
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
    const bucket = this.bucketFor(key);
    if (carriesGuarantee) {
      bucket.opportunistic.delete(key);
      bucket.guaranteed.set(key, entry);
      return;
    }
    bucket.guaranteed.delete(key);
    bucket.opportunistic.set(key, entry);
  }

  /**
   * Move a live counter into its bucket's guaranteed half.
   *
   * The half an entry sits in is chosen when it is written and, by every other
   * operation, never revisited — {@link bump} re-inserts into whichever half
   * already holds the key.  That is right for `set`, which must never
   * manufacture a guarantee, and wrong for `incr`: a rate-limit window seeded
   * by `set(key, 0, windowMs)` and then driven by `incr` is the same window as
   * one `incr` created, yet stayed opportunistic for its whole life — evicted
   * first under exactly the key flood the two halves exist to survive (#1295).
   *
   * Deliberately keyed on the *entry's* expiry rather than on `incr`'s `ttlMs`
   * argument: Redis semantics set the TTL only on creation, so the call that
   * drives an existing window normally passes none, and reading the argument
   * would adopt only the counters that least need it.
   *
   * A no-op when the key is already guaranteed, so a caller can bump
   * afterwards and get the recency move `incr` owes an entry either way.
   */
  private adoptAsGuaranteed(key: string, entry: Entry): void {
    const bucket = this.bucketFor(key);
    if (!bucket.opportunistic.delete(key)) return;
    bucket.guaranteed.set(key, entry);
  }

  /**
   * Move a still-valid entry to the tail so it counts as most-recently-used,
   * and — for an opportunistic entry the configured policy wrote — extend its
   * idle window.
   *
   * The extension lives here rather than at the three call sites because
   * "a use" is exactly what this method already means: `get`, `mget` and
   * `incr` are the calls that move a key, and they are the calls a sliding
   * window should slide on.  It is skipped for the guaranteed half on the
   * rule the class header states, and reading the half here rather than
   * asking again is what makes that skip free — `incr` adopts a counter
   * *before* bumping it, so a counter has already left the extendable half by
   * the time this runs.
   */
  private bump(key: string, entry: Entry): void {
    // Re-insertion moves the key to the end of its half's iteration order, so
    // the first key of a half stays its least-recently-used (the victim).
    const bucket = this.bucketFor(key);
    const carriesGuarantee = bucket.guaranteed.has(key);
    const half = carriesGuarantee ? bucket.guaranteed : bucket.opportunistic;
    if (!carriesGuarantee) this.extendIdleWindow(entry);
    half.delete(key);
    half.set(key, entry);
  }

  /**
   * Evict entries until there is room for a NEW key.
   * No-op when overwriting an existing key (that doesn't grow the map).
   *
   * Two questions in order, and the first is why a prefix quota is a security
   * boundary rather than a hint:
   *
   *   1. **Is the incoming key's own bucket at its quota?**  Then it makes
   *      room inside itself, and the total drops by one — so a consumer that
   *      floods its own prefix never reaches step 2 at all, whatever else the
   *      map is holding.  The unreserved remainder has a quota of `Infinity`,
   *      so for an unconfigured cache this step is dead weight the branch
   *      predictor eats.
   *   2. **Is the map at `maxEntries`?**  Then the victim comes out of the
   *      unreserved remainder, the only space no prefix has a claim on.
   *      {@link InMemoryCacheOptionsValidator} keeps the quotas summing to at
   *      most `maxEntries`, so a bucket below its quota always finds room
   *      here — except when the quotas reserve the *whole* map, which leaves
   *      an unreserved write nowhere to go and is the one case
   *      {@link evictFromAnyBucket} exists for.
   *
   * Every step is O(1) in the number of entries, and `maxEntries` stays a
   * hard cap rather than an aspiration: reserving or protecting an entry can
   * delay its eviction, never grow the map.
   */
  private evictIfNeeded(incomingKey: string): void {
    const bucket = this.bucketFor(incomingKey);
    if (bucket.guaranteed.has(incomingKey) || bucket.opportunistic.has(incomingKey)) return;
    while (bucketSize(bucket) >= bucket.quota && this.evictFrom(bucket)) { /* until under quota */ }
    if (!Number.isFinite(this.maxEntries)) return;
    while (this.totalSize() >= this.maxEntries) {
      if (this.evictFrom(this.unreserved)) continue;
      if (!this.evictFromAnyBucket()) break;
    }
  }

  /**
   * Drop `bucket`'s least-recently-used entry, opportunistic half first.
   * `false` when the bucket is empty and there was nothing to drop.
   */
  private evictFrom(bucket: Bucket): boolean {
    const half = bucket.opportunistic.size > 0 ? bucket.opportunistic : bucket.guaranteed;
    const leastRecentlyUsed = half.keys().next().value as string | undefined;
    if (leastRecentlyUsed === undefined) return false;
    half.delete(leastRecentlyUsed);
    return true;
  }

  /**
   * Last resort: take an entry from whichever bucket still has one,
   * opportunistic entries everywhere before any guarantee.
   *
   * Reached only when the quotas reserve the entire map and a key matching no
   * prefix is written anyway — there is then no unreserved slot to take, and
   * the choice is between breaking a reservation and breaking `maxEntries`.
   * The bound wins: it is the one that keeps a key flood from growing the
   * process, and a configuration that reserves everything has already said
   * unreserved keys are not expected.
   */
  private evictFromAnyBucket(): boolean {
    for (const bucket of this.buckets.values()) {
      if (bucket.opportunistic.size > 0) return this.evictFrom(bucket);
    }
    for (const bucket of this.buckets.values()) {
      if (bucket.guaranteed.size > 0) return this.evictFrom(bucket);
    }
    return false;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const bucket of this.buckets.values()) {
      for (const half of [bucket.opportunistic, bucket.guaranteed]) {
        for (const [key, entry] of half) {
          if (entry.expiresAt <= now) half.delete(key);
        }
      }
    }
  }
}
