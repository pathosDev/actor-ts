import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/** Built-in default LRU cap on stored entries (see {@link InMemoryCacheOptionsType}). */
export const DEFAULT_MAX_ENTRIES = 10_000;
/** Built-in default background-sweep interval in ms (see {@link InMemoryCacheOptionsType}). */
export const DEFAULT_CLEANUP_MS = 60_000;
/** Built-in default lifetime for a `set`/`mset` that names no `ttlMs` — `0` = no expiry. */
export const DEFAULT_TIME_TO_LIVE_MS = 0;
/** Built-in default idle window — `0` = a read extends nothing. */
export const DEFAULT_TIME_TO_IDLE_MS = 0;

/** Plain options-object shape accepted by an {@link InMemoryCache}. */
export type InMemoryCacheOptionsType = {
  /** LRU cap on stored entries.  Default 10 000.  `Infinity` = unbounded. */
  readonly maxEntries?: number;
  /**
   * How often (ms) to sweep expired entries in the background.  Default
   * 60 000.  `0` / `Infinity` disables the sweep (lazy expiry still applies
   * on access).
   */
  readonly cleanupMs?: number;
  /**
   * Lifetime (ms) stamped on an entry whose writer named no `ttlMs` of its
   * own.  `0` (the default) means such an entry never expires, which is what
   * {@link Cache.set} has always promised.
   *
   * **`set` and `mset` only.**  `incr` and `setIfAbsent` keep "no `ttlMs`
   * means no expiry" whatever this says, because for those two the cache is
   * the source of truth rather than a copy of one: a rate-limit window that
   * reset itself, or a lock that released itself, on a number an operator
   * put in a config file is a correctness bug delivered by configuration.
   * The class header calls an unbounded claim "the wedge `setIfAbsent` warns
   * about" and refuses to protect it; bounding it from here would be the same
   * decision taken silently.
   */
  readonly timeToLiveMs?: number;
  /**
   * Idle window (ms): a read pushes the entry's expiry out to
   * `now + timeToIdleMs`, never past the `timeToLiveMs` deadline it was
   * written with.  `0` (the default) means a read extends nothing.
   *
   * Applies to the same population as {@link timeToLiveMs} — entries a
   * `set`/`mset` wrote without a `ttlMs` — and only while they sit in the
   * eviction-first half of the map.  An entry a guarantee has moved into the
   * protected half stops being extended, which is deliberate: extending on
   * every read means a rate-limit window driven by `incr` never closes and an
   * idempotency claim polled by a retrying client never releases.
   *
   * An idle window at or above `timeToLiveMs` never binds — the lifetime is
   * the ceiling, so the extension is clamped to it on the first read.
   */
  readonly timeToIdleMs?: number;
  /**
   * Per-key-prefix reservations — `{ 'rsp:': 8000, 'idem:': 2000 }` — that
   * split one map between the consumers writing into it (#607).  Unset (the
   * default) leaves the map undivided: every key competes with every other
   * for the same `maxEntries`, which is the behaviour every release before
   * this option had.
   *
   * A quota is a **cap and a reservation at once**, and both halves are what
   * make it a security boundary rather than a hint:
   *
   *   - as a *cap*, a prefix that has reached its quota takes its next
   *     victim from inside itself, so a caller who can mint keys under one
   *     prefix — an attacker-chosen `Idempotency-Key`, a response-cache key
   *     derived from the path — evicts only that prefix's own entries;
   *   - as a *reservation*, the entries a prefix holds below its quota are
   *     not available to anybody else, so the flood cannot reach a
   *     rate-limit counter or an idempotency record on the other side of the
   *     map either.
   *
   * A key belongs to the **longest** configured prefix it starts with, and
   * to a shared unreserved remainder when it starts with none.  That
   * remainder is what an over-committed configuration would have to eat
   * into, so the sum of the quotas may not exceed `maxEntries` — a
   * reservation the map cannot honour is rejected at construction rather
   * than discovered under load.
   *
   * What it does **not** do: bound one *caller* inside a prefix.  Two
   * clients sending `Idempotency-Key`s land under the same `idem:` quota and
   * still evict each other; only a per-caller key space (an `identity` scope
   * with a known, small set of tenants, each reserved separately) or a
   * backend the framework does not evict at all (`RedisCache`) changes that.
   */
  readonly prefixQuotas?: Readonly<Record<string, number>>;
};

/**
 * Fluent builder for {@link InMemoryCacheOptionsType}:
 *
 *     const cacheOptions = InMemoryCacheOptions.create().withMaxEntries(50_000);
 *     new InMemoryCache(cacheOptions);
 */
export class InMemoryCacheOptionsBuilder extends OptionsBuilder<InMemoryCacheOptionsType> {
  /** Start a fresh builder.  Equivalent to `new InMemoryCacheOptionsBuilder()`. */
  static create(): InMemoryCacheOptionsBuilder {
    return new InMemoryCacheOptionsBuilder();
  }

  /** LRU cap on stored entries.  `Infinity` opts out of eviction (unbounded). */
  withMaxEntries(maxEntries: number): this {
    return this.set('maxEntries', maxEntries);
  }

  /** Background expired-entry sweep interval (ms).  `0` / `Infinity` disables the sweep. */
  withCleanupMs(cleanupMs: number): this {
    return this.set('cleanupMs', cleanupMs);
  }

  /** Lifetime (ms) for a `set`/`mset` that names no `ttlMs`.  `0` = no expiry. */
  withTimeToLiveMs(timeToLiveMs: number): this {
    return this.set('timeToLiveMs', timeToLiveMs);
  }

  /** Idle window (ms) a read extends such an entry to.  `0` = a read extends nothing. */
  withTimeToIdleMs(timeToIdleMs: number): this {
    return this.set('timeToIdleMs', timeToIdleMs);
  }

  /**
   * Split the map between key prefixes — `{ 'rsp:': 8000, 'idem:': 2000 }`.
   * Each quota is a cap *and* a reservation; the sum may not exceed
   * `maxEntries`.
   */
  withPrefixQuotas(prefixQuotas: Readonly<Record<string, number>>): this {
    return this.set('prefixQuotas', prefixQuotas);
  }
}

/**
 * Validates resolved {@link InMemoryCacheOptionsType} settings.  `maxEntries`
 * and `cleanupMs` legitimately admit `Infinity` (unbounded map / sweep
 * disabled), which the generic `positiveInt` / `positiveNumber` helpers
 * reject, and `prefixQuotas` is a table with a cross-field sum rule, so the
 * rules are bespoke.
 */
export class InMemoryCacheOptionsValidator extends OptionsValidator<InMemoryCacheOptionsType> {
  constructor() {
    super('InMemoryCacheOptions');
  }
  protected rules(s: Partial<InMemoryCacheOptionsType>): void {
    const { maxEntries, cleanupMs, prefixQuotas } = s;
    if (
      maxEntries !== undefined && maxEntries !== Infinity &&
      (typeof maxEntries !== 'number' || !Number.isInteger(maxEntries) || maxEntries < 1)
    ) {
      this.fail('maxEntries', 'must be a positive integer or Infinity', maxEntries);
    }
    if (
      cleanupMs !== undefined &&
      (typeof cleanupMs !== 'number' || Number.isNaN(cleanupMs) || cleanupMs < 0)
    ) {
      this.fail('cleanupMs', 'must be a non-negative number (0 or Infinity disables the sweep)', cleanupMs);
    }
    this.checkExpiryPolicy('timeToLiveMs', s.timeToLiveMs);
    this.checkExpiryPolicy('timeToIdleMs', s.timeToIdleMs);
    if (prefixQuotas !== undefined) this.checkPrefixQuotas(prefixQuotas, maxEntries);
  }

  /**
   * An expiry policy is a finite, non-negative number of milliseconds, with
   * `0` as the off sentinel.
   *
   * `Infinity` is refused rather than accepted as a second spelling of "off":
   * it would flow into `now + timeToLiveMs` and produce an `expiresAt` of
   * `Infinity`, which is the *same* state a `0` reaches by never stamping one
   * — two configurations for one behaviour, and the one that goes through the
   * arithmetic is the one that breaks the moment the arithmetic changes.
   * `assertTtl` refuses a non-finite caller argument on the same grounds.
   */
  private checkExpiryPolicy(field: 'timeToLiveMs' | 'timeToIdleMs', value: number | undefined): void {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      this.fail(field, 'must be a finite non-negative number of milliseconds (0 disables it)', value);
    }
  }

  /**
   * Every quota is a whole number of entries the map has to be able to hold,
   * and their sum is the part of `maxEntries` that is spoken for.
   *
   * The sum rule is what keeps a quota meaningful.  Reservations totalling
   * more than the map can hold cannot all be honoured, so under load the
   * cache would have to break one of them — and it would break it silently,
   * in the eviction path, long after the configuration that caused it was
   * written.  `Infinity` as a quota is rejected for the same reason: a
   * reservation of everything is not a share of anything.  An unbounded map
   * (`maxEntries: Infinity`) has no sum to check and still gets per-prefix
   * caps, which is a use of its own.
   */
  private checkPrefixQuotas(prefixQuotas: unknown, maxEntries: number | undefined): void {
    if (typeof prefixQuotas !== 'object' || prefixQuotas === null || Array.isArray(prefixQuotas)) {
      this.fail('prefixQuotas', 'must be an object mapping a key prefix to its entry cap', prefixQuotas);
    }
    let reserved = 0;
    for (const [prefix, quota] of Object.entries(prefixQuotas as Record<string, unknown>)) {
      if (prefix === '') {
        this.fail('prefixQuotas', 'must not carry an empty prefix, which would match every key', prefixQuotas);
      }
      if (typeof quota !== 'number' || !Number.isInteger(quota) || quota < 1) {
        this.fail('prefixQuotas', `must map '${prefix}' to a positive integer`, quota);
      }
      reserved += quota;
    }
    const cap = maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (Number.isFinite(cap) && reserved > cap) {
      this.fail('prefixQuotas', `reserves ${reserved} entries, more than maxEntries (${cap}) can hold`, prefixQuotas);
    }
  }
}

/**
 * Accepted input for the {@link InMemoryCache} constructor: the fluent
 * {@link InMemoryCacheOptionsBuilder} OR a plain
 * {@link InMemoryCacheOptionsType} object.
 */
export type InMemoryCacheOptions = InMemoryCacheOptionsBuilder | Partial<InMemoryCacheOptionsType>;
/** Value alias so `InMemoryCacheOptions.create()` / `new InMemoryCacheOptions()` resolve to the builder. */
export const InMemoryCacheOptions = InMemoryCacheOptionsBuilder;
