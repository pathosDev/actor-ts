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

/** Plain options-object shape accepted by {@link idempotent}. */
export type IdempotencyOptionsType = {
  readonly cache: Cache;
  /** How long to remember responses.  Default: 24 hours. */
  readonly ttlMs?: number;
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
 * response-retention window) must be a positive finite number of
 * milliseconds, `maxKeyLength` and `maxScopeLength` positive integers, and
 * `missingHeader` one of its allowed literals.  (Presence of `cache` is a
 * required-field concern, not a validity one.)
 */
export class IdempotencyOptionsValidator extends OptionsValidator<IdempotencyOptionsType> {
  constructor() {
    super('IdempotencyOptions');
  }
  protected rules(_s: Partial<IdempotencyOptionsType>): void {
    this.positiveNumber('ttlMs');
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
