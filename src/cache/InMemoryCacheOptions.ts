import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/** Built-in default LRU cap on stored entries (see {@link InMemoryCacheOptionsType}). */
export const DEFAULT_MAX_ENTRIES = 10_000;
/** Built-in default background-sweep interval in ms (see {@link InMemoryCacheOptionsType}). */
export const DEFAULT_CLEANUP_MS = 60_000;

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
    if (prefixQuotas !== undefined) this.checkPrefixQuotas(prefixQuotas, maxEntries);
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
