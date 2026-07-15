/**
 * Options for {@link csrfProtection} and {@link requireSameOrigin}.  Both
 * option families live here (they are two facets of the same CSRF story).
 * Options-only — the secret belongs in code / a secret manager, never a
 * HOCON file.
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

/** Attributes for the CSRF cookie (a subset of the general cookie attributes). */
export interface CsrfCookieOptions {
  readonly path?: string;
  readonly secure?: boolean;
  readonly sameSite?: 'strict' | 'lax' | 'none';
  readonly domain?: string;
  readonly maxAgeSeconds?: number;
}

/** Plain settings shape for {@link csrfProtection}. */
export interface CsrfOptionsType {
  /** REQUIRED — HMAC key, at least 16 bytes (32 recommended). */
  readonly secret?: string | Uint8Array;
  /** Cookie name.  Default `'csrf-token'`. */
  readonly cookieName?: string;
  /** Request header carrying the token.  Default `'x-csrf-token'`. */
  readonly headerName?: string;
  /** Cookie attributes.  Defaults: Path=/, Secure, SameSite=Lax, HttpOnly=false. */
  readonly cookie?: CsrfCookieOptions;
  /** Also require a same-origin Origin/Referer on unsafe methods.  Default true. */
  readonly verifyOrigin?: boolean;
  /** Extra full origins accepted by the origin check. */
  readonly allowedOrigins?: ReadonlyArray<string>;
  /** Also read the token from this urlencoded body field (classic forms).  Default off. */
  readonly formFieldName?: string;
}

/** Fluent builder for {@link CsrfOptionsType}. */
export class CsrfOptionsBuilder extends OptionsBuilder<CsrfOptionsType> {
  static create(): CsrfOptionsBuilder {
    return new CsrfOptionsBuilder();
  }
  withSecret(secret: string | Uint8Array): this {
    return this.set('secret', secret);
  }
  withCookieName(name: string): this {
    return this.set('cookieName', name);
  }
  withHeaderName(name: string): this {
    return this.set('headerName', name);
  }
  withCookie(cookie: CsrfCookieOptions): this {
    return this.set('cookie', cookie);
  }
  withVerifyOrigin(flag = true): this {
    return this.set('verifyOrigin', flag);
  }
  withAllowedOrigins(...origins: string[]): this {
    return this.set('allowedOrigins', origins);
  }
  withFormField(name: string): this {
    return this.set('formFieldName', name);
  }
}

/** Accepted input for {@link csrfProtection}. */
export type CsrfOptions = CsrfOptionsBuilder | Partial<CsrfOptionsType>;
export const CsrfOptions = CsrfOptionsBuilder;

/**
 * Validates resolved {@link CsrfOptionsType} settings.  All rules are
 * bespoke: `secret` is a `string | Uint8Array` union (byte length must be
 * >= 16), and the cookie attributes are nested.  A `secret` that is simply
 * absent is a REQUIRED-field error enforced by `csrfProtection`, not here —
 * the validator only checks the validity of a PRESENT secret.
 */
export class CsrfOptionsValidator extends OptionsValidator<CsrfOptionsType> {
  constructor() {
    super('CsrfOptions');
  }
  protected rules(s: Partial<CsrfOptionsType>): void {
    const { secret } = s;
    if (secret !== undefined) {
      const len = typeof secret === 'string' ? new TextEncoder().encode(secret).length : secret.length;
      if (len < 16) this.fail('secret', 'must be at least 16 bytes', len);
    }
    const cookie = s.cookie;
    if (cookie) {
      if (cookie.sameSite !== undefined && !['strict', 'lax', 'none'].includes(cookie.sameSite)) {
        this.fail('cookie.sameSite', 'must be one of strict, lax, none', cookie.sameSite);
      }
      if (
        cookie.maxAgeSeconds !== undefined &&
        (typeof cookie.maxAgeSeconds !== 'number' || !Number.isFinite(cookie.maxAgeSeconds) || cookie.maxAgeSeconds < 0)
      ) {
        this.fail('cookie.maxAgeSeconds', 'must be a non-negative finite number', cookie.maxAgeSeconds);
      }
    }
  }
}

/** Plain settings shape for {@link requireSameOrigin}. */
export interface SameOriginOptionsType {
  /** Full origins accepted beyond the request's own host. */
  readonly allowedOrigins?: ReadonlyArray<string>;
  /** Allow unsafe methods that carry neither Origin nor Referer.  Default false. */
  readonly allowMissingOrigin?: boolean;
}

/** Fluent builder for {@link SameOriginOptionsType}. */
export class SameOriginOptionsBuilder extends OptionsBuilder<SameOriginOptionsType> {
  static create(): SameOriginOptionsBuilder {
    return new SameOriginOptionsBuilder();
  }
  withAllowedOrigins(...origins: string[]): this {
    return this.set('allowedOrigins', origins);
  }
  withAllowMissingOrigin(flag = true): this {
    return this.set('allowMissingOrigin', flag);
  }
}

/** Accepted input for {@link requireSameOrigin}. */
export type SameOriginOptions = SameOriginOptionsBuilder | Partial<SameOriginOptionsType>;
export const SameOriginOptions = SameOriginOptionsBuilder;
