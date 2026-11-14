/**
 * Options for the {@link idempotent} middleware.  Follows the repo's
 * `XOptions.ts` convention (type / builder / validator / union), but the
 * builder is purely ADDITIVE: `idempotent(...)` still accepts a plain
 * options object exactly as before.
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { Cache } from '../../cache/Cache.js';
import type { HttpRequest } from '../Types.js';

/**
 * Longest `Idempotency-Key` header value accepted before the request is
 * refused with 400.
 *
 * 255 characters, matching Stripe's published cap — the ceiling every
 * client library was already written against, and comfortably above the
 * UUID or short opaque token real clients send, so the bound costs
 * honest traffic nothing.
 *
 * The cap exists because the header value is copied verbatim into the
 * cache key, and that cache is typically shared with the rate limiter
 * and the response cache.  Without a bound, one request parks a
 * header-sized string (kibibytes, whatever the backend accepts) in a
 * cache the whole application depends on, and an attacker chooses how
 * much of it each minted key consumes.  It does NOT bound how MANY keys
 * a caller can mint — see the eviction note in {@link idempotent}.
 *
 * It also does not bound the *other* half of the key: see
 * {@link DEFAULT_IDEMPOTENCY_MAX_SCOPE_LENGTH}.
 */
export const DEFAULT_IDEMPOTENCY_MAX_KEY_LENGTH = 255;

/**
 * Longest {@link IdempotencyOptionsType.identity} result folded into the
 * cache key before the request is refused with 400.
 *
 * A separate number from {@link DEFAULT_IDEMPOTENCY_MAX_KEY_LENGTH} rather
 * than one cap over the composed key, so the header cap stays exactly
 * Stripe's 255 and a tenant with a long id cannot spend an honest client's
 * header budget.  Same value, because a scope is an authenticated
 * principal — a UUID, a tenant slug, an API-key id — and 255 is generous
 * for every one of those.
 *
 * The bound exists because the scope reaches the key from the same place
 * the header does.  `identity`'s own documented recipe reads a raw client
 * header, so a 64 KiB `x-account-id` and a two-character
 * `Idempotency-Key` composed a 64 KiB cache key under a middleware whose
 * documented cap was 255 — the header was checked, the scope was
 * concatenated four lines later unchecked (#607).
 */
export const DEFAULT_IDEMPOTENCY_MAX_SCOPE_LENGTH = 255;

/**
 * Built-in default for {@link IdempotencyOptionsType.ttlMs}: how long a
 * finished request's response is replayed.  24 hours, Stripe's window.
 */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

/**
 * Built-in default for {@link IdempotencyOptionsType.lockTtlMs}: how long
 * the claim on an in-flight key lives (#984).
 *
 * One minute, because this TTL is the recovery path from a worker that
 * died between claiming a key and recording its response — an evicted pod,
 * an OOM kill, a rolling deploy.  Nothing else ever clears that claim, so
 * every retry is answered 409 until it lapses.  With the response TTL in
 * this role (the old behaviour) that was a day; a minute is long enough
 * for an ordinary request handler and short enough that a client's retry
 * schedule gets through.
 */
export const DEFAULT_IDEMPOTENCY_LOCK_TTL_MS = 60_000;

/**
 * What {@link idempotent} does with the claim when the handler throws.
 * `'retain'` records the failure under the key; `'release'` frees the key
 * for a retry.
 */
export type IdempotencyHandlerErrorPolicy = 'retain' | 'release';

/** Built-in default for {@link IdempotencyOptionsType.onHandlerError}. */
export const DEFAULT_IDEMPOTENCY_HANDLER_ERROR_POLICY: IdempotencyHandlerErrorPolicy = 'retain';

/** Plain options-object shape accepted by {@link idempotent}. */
export type IdempotencyOptionsType = {
  readonly cache: Cache;
  /** How long to remember responses.  Default: 24 hours. */
  readonly ttlMs?: number;
  /**
   * How long the claim on an in-flight key lives, separately from
   * {@link ttlMs} (#984).  Default: {@link DEFAULT_IDEMPOTENCY_LOCK_TTL_MS}
   * (60 s).
   *
   * It is also the longest a handler can run and stay exclusive: a handler
   * still running when its claim lapses can be joined by a retry.  The
   * overrun is detected — the late finisher neither stores its response nor
   * clears the retry's claim (#1082) — but not prevented, so size this
   * above the slowest handler you expect, and treat it as that handler's
   * timeout.
   */
  readonly lockTtlMs?: number;
  /**
   * What happens to the key when the handler **throws** (#984).
   *
   * `'retain'` (the default) records the failure under the key for
   * {@link ttlMs}: every retry is answered 500 without running the handler
   * again, and the client has to reconcile and use a new key.  That is the
   * safe side, because the middleware cannot know how much of the handler
   * ran — a payment handler that captured the charge and then failed on
   * the receipt e-mail would otherwise charge twice on the retry, the one
   * outcome idempotency keys exist to prevent.
   *
   * `'release'` frees the key so a retry runs the handler again.  Correct
   * only for a handler that is atomic — one that applies everything or
   * nothing, such as a single database transaction.
   *
   * A handler that *returns* an error response decided what it means; see
   * {@link cacheStatuses}.
   */
  readonly onHandlerError?: IdempotencyHandlerErrorPolicy;
  /**
   * Statuses whose responses are recorded and replayed (#984).  A response
   * with any other status releases the key, so a retry runs the handler
   * again.
   *
   * Unset, every status is recorded **except** 5xx, 408 and 429 — the
   * statuses that say "this failed for now, try again".  Storing those
   * pinned a downstream 503 for the whole {@link ttlMs}, replayed to the
   * client that was retrying exactly as told.  Other 4xx are recorded: a
   * 400 or 404 is the answer to that request, and replaying it is what an
   * idempotency key promises.
   */
  readonly cacheStatuses?: ReadonlyArray<number>;
  /**
   * Header to read the idempotency key from.  Default: `'idempotency-key'`
   * (the standard).  Header names are matched case-insensitively against
   * the `request.headers` map (which holds them lower-cased).
   */
  readonly headerName?: string;
  /**
   * Cache-key namespace.  Default: `'idem:'`.
   */
  readonly keyPrefix?: string;
  /**
   * Longest accepted `Idempotency-Key` header value; a longer one is
   * refused with 400 rather than stored.  Default:
   * {@link DEFAULT_IDEMPOTENCY_MAX_KEY_LENGTH} (255, Stripe's cap).
   * Raise it only for a client fleet you control that genuinely mints
   * longer keys.
   */
  readonly maxKeyLength?: number;
  /**
   * Longest accepted {@link identity} result; a longer one is refused with
   * 400 rather than stored.  Default:
   * {@link DEFAULT_IDEMPOTENCY_MAX_SCOPE_LENGTH} (255).
   */
  readonly maxScopeLength?: number;
  /**
   * What to do when the request lacks the header.  Default: `'reject'`
   * (respond 400).  Setting `'pass-through'` runs the handler unchanged
   * — useful when only some clients use idempotency and you don't want
   * to break the others.
   */
  readonly missingHeader?: 'reject' | 'pass-through';
  /**
   * Derive a per-caller scope folded into the cache key so a cached response
   * is NEVER replayed to a different caller (security audit HTTP-4).
   * Without it, two callers sending the same method + path + body under the
   * same `Idempotency-Key` share one cache entry — fine for a public
   * endpoint, unsafe when the response is identity-specific (the second
   * caller would get the first caller's data / `Set-Cookie`).  Return the
   * authenticated principal (user / tenant / API-key id), e.g.
   * `identity: (request) => request.headers['x-account-id'] ?? 'anon'`.
   *
   * **Return an id, not free text.**  The result is concatenated into the
   * cache key, so it is held to the same two rules as the header value:
   * at most {@link maxScopeLength} characters, and no ASCII control
   * character or space.  Anything else is refused with 400 (#607) — which
   * matters most for the recipe above, where the value is a raw client
   * header and the client picks its size.  Deriving the scope from a
   * validated session or token instead keeps the check inert.
   */
  readonly identity?: (request: HttpRequest) => string | Promise<string>;
};

/**
 * Fluent builder for {@link IdempotencyOptionsType}:
 *
 *     idempotent(IdempotencyOptions.create().withCache(cache).withTtlMs(24 * 60 * 60_000))
 */
export class IdempotencyOptionsBuilder extends OptionsBuilder<IdempotencyOptionsType> {
  /** Start a fresh builder.  Equivalent to `new IdempotencyOptionsBuilder()`. */
  static create(): IdempotencyOptionsBuilder {
    return new IdempotencyOptionsBuilder();
  }

  /** Backing cache used to record first responses. */
  withCache(cache: Cache): this {
    return this.set('cache', cache);
  }

  /** How long to remember responses (ms).  Default: 24 hours. */
  withTtlMs(ttlMs: number): this {
    return this.set('ttlMs', ttlMs);
  }

  /** How long the claim on an in-flight key lives (ms).  Default: 60 s. */
  withLockTtlMs(lockTtlMs: number): this {
    return this.set('lockTtlMs', lockTtlMs);
  }

  /** Record a thrown handler's failure (`'retain'`, default) or free the key (`'release'`). */
  withOnHandlerError(onHandlerError: IdempotencyHandlerErrorPolicy): this {
    return this.set('onHandlerError', onHandlerError);
  }

  /** Statuses whose responses are recorded.  Default: all but 5xx, 408 and 429. */
  withCacheStatuses(cacheStatuses: ReadonlyArray<number>): this {
    return this.set('cacheStatuses', cacheStatuses);
  }

  /** Header to read the idempotency key from.  Default: `'idempotency-key'`. */
  withHeaderName(headerName: string): this {
    return this.set('headerName', headerName);
  }

  /** Cache-key namespace.  Default: `'idem:'`. */
  withKeyPrefix(keyPrefix: string): this {
    return this.set('keyPrefix', keyPrefix);
  }

  /** Longest accepted `Idempotency-Key` header value.  Default: 255. */
  withMaxKeyLength(maxKeyLength: number): this {
    return this.set('maxKeyLength', maxKeyLength);
  }

  /** Longest accepted `identity` result folded into the key.  Default: 255. */
  withMaxScopeLength(maxScopeLength: number): this {
    return this.set('maxScopeLength', maxScopeLength);
  }

  /** Behaviour when the request lacks the header.  Default: `'reject'`. */
  withMissingHeader(missingHeader: 'reject' | 'pass-through'): this {
    return this.set('missingHeader', missingHeader);
  }

  /** Per-caller scope folded into the cache key (security audit HTTP-4). */
  withIdentity(identity: (request: HttpRequest) => string | Promise<string>): this {
    return this.set('identity', identity);
  }
}

/**
 * Validates resolved {@link IdempotencyOptionsType} settings: `ttlMs` (the
 * response-retention window) and `lockTtlMs` (the claim's lifetime) must be
 * positive finite numbers of milliseconds, `maxKeyLength` and
 * `maxScopeLength` positive integers, `missingHeader` and `onHandlerError`
 * one of their allowed literals, and `cacheStatuses` a non-empty list of
 * HTTP status codes — an empty one would record nothing and silently turn
 * the middleware into a pass-through.  (Presence of `cache` is a
 * required-field concern, not a validity one.)
 */
export class IdempotencyOptionsValidator extends OptionsValidator<IdempotencyOptionsType> {
  constructor() {
    super('IdempotencyOptions');
  }
  protected rules(s: Partial<IdempotencyOptionsType>): void {
    this.positiveNumber('ttlMs');
    this.positiveNumber('lockTtlMs');
    this.oneOf('onHandlerError', ['retain', 'release']);
    this.nonEmptyArray('cacheStatuses');
    const invalidStatus = s.cacheStatuses?.find((status) => !Number.isInteger(status) || status < 100 || status > 599);
    if (invalidStatus !== undefined) {
      this.fail('cacheStatuses', 'must hold HTTP status codes (integers from 100 to 599)', invalidStatus);
    }
    this.positiveInt('maxKeyLength');
    this.positiveInt('maxScopeLength');
    this.oneOf('missingHeader', ['reject', 'pass-through']);
  }
}

/**
 * Accepted input for {@link idempotent}: the fluent
 * {@link IdempotencyOptionsBuilder} OR a plain {@link IdempotencyOptionsType}
 * object.
 */
export type IdempotencyOptions = IdempotencyOptionsBuilder | Partial<IdempotencyOptionsType>;
/** Value alias so `IdempotencyOptions.create()` / `new IdempotencyOptions()` resolve to the builder. */
export const IdempotencyOptions = IdempotencyOptionsBuilder;
