/**
 * Options for the {@link idempotent} middleware.  Follows the repo's
 * `XOptions.ts` convention (type / builder / validator / union), but the
 * builder is purely ADDITIVE: `idempotent(...)` still accepts a plain
 * options object exactly as before.
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { Cache } from '../../cache/Cache.js';
import type { HttpRequest } from '../types.js';

/** Plain options-object shape accepted by {@link idempotent}. */
export interface IdempotencyOptionsType {
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
   */
  readonly identity?: (request: HttpRequest) => string | Promise<string>;
}

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
 * milliseconds, and `missingHeader` must be one of its allowed literals.
 * (Presence of `cache` is a required-field concern, not a validity one.)
 */
export class IdempotencyOptionsValidator extends OptionsValidator<IdempotencyOptionsType> {
  constructor() {
    super('IdempotencyOptions');
  }
  protected rules(_s: Partial<IdempotencyOptionsType>): void {
    this.positiveNumber('ttlMs');
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
