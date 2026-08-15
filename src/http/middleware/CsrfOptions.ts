/**
 * Options for {@link csrfProtection} and {@link requireSameOrigin}.  Both
 * option families live here (they are two facets of the same CSRF story).
 * Options-only — the secret belongs in code / a secret manager, never a
 * HOCON file.
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

/**
 * Scheme the site is served over.  A request's `Host` header carries the
 * authority and nothing else, so the server's own origin is only knowable
 * from configuration — this is the missing half.  Without it an origin
 * check can only compare hosts, and a host comparison accepts
 * `http://app.example` (or any other scheme that parses an authority) as
 * same-origin for an HTTPS site.
 */
export type OriginScheme = 'http' | 'https';

/**
 * Normalised origin — `scheme://host[:port]`, lowercased, with a default
 * port dropped — of a URL-like string, or `null` when it carries no
 * origin.  `URL.origin` is the whole rule: it yields the literal string
 * `'null'` for the opaque `Origin: null` and for every scheme that has no
 * origin (`file:`, `data:`, an unknown scheme), so those are rejected
 * rather than silently reduced to a bare host.
 */
export function normalizeOrigin(urlLike: string): string | null {
  try {
    const { origin } = new URL(urlLike);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * First `allowedOrigins` entry that is not a full origin.  A bare host
 * (`'app.example'`) used to match through the host-only comparison; now
 * that entries are compared as whole origins it would silently never
 * match, so both validators reject it at construction instead.
 */
function firstNonOrigin(origins: ReadonlyArray<string> | undefined): string | undefined {
  return origins?.find((origin) => normalizeOrigin(origin) === null);
}

/**
 * Default CSRF cookie name.  The `__Host-` prefix is what actually stops
 * cookie planting — a browser refuses such a cookie unless it is `Secure`,
 * `Path=/` and carries no `Domain`, which locks it to exactly this host, so
 * neither a sibling subdomain nor a plaintext origin can write it.  (The
 * HMAC cannot do that job: it binds a token to the server secret, not to a
 * client, so a signed token verifies for whoever presents it.)
 *
 * The price is that a `__Host-` cookie cannot be set over plain HTTP at
 * all: a plain-HTTP deployment must pick an unprefixed name explicitly.
 */
export const DEFAULT_CSRF_COOKIE_NAME = '__Host-csrf-token';

/** Attributes for the CSRF cookie (a subset of the general cookie attributes). */
export type CsrfCookieOptions = {
  readonly path?: string;
  readonly secure?: boolean;
  readonly sameSite?: 'strict' | 'lax' | 'none';
  readonly domain?: string;
  readonly maxAgeSeconds?: number;
};

/** Plain settings shape for {@link csrfProtection}. */
export type CsrfOptionsType = {
  /** REQUIRED — HMAC key, at least 16 bytes (32 recommended). */
  readonly secret?: string | Uint8Array;
  /** Cookie name.  Default {@link DEFAULT_CSRF_COOKIE_NAME}. */
  readonly cookieName?: string;
  /** Request header carrying the token.  Default `'x-csrf-token'`. */
  readonly headerName?: string;
  /** Cookie attributes.  Defaults: Path=/, Secure, SameSite=Lax, HttpOnly=false. */
  readonly cookie?: CsrfCookieOptions;
  /** Also require a same-origin Origin/Referer on unsafe methods.  Default true. */
  readonly verifyOrigin?: boolean;
  /**
   * Extra full origins accepted by the origin check.  Compared whole
   * (scheme + host + port), so `'https://partner.example'` does not accept
   * `http://partner.example`.
   */
  readonly allowedOrigins?: ReadonlyArray<string>;
  /**
   * Scheme this site is served over — the half of its own origin the
   * `Host` header cannot carry.  Default `'https'`, or `'http'` when
   * {@link CsrfCookieOptions.secure} is explicitly `false`: an app that
   * turns the `Secure` cookie off has declared a plain-HTTP deployment,
   * and its own origins would otherwise all be rejected.
   */
  readonly expectedScheme?: OriginScheme;
  /** Also read the token from this urlencoded body field (classic forms).  Default off. */
  readonly formFieldName?: string;
};

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
  withExpectedScheme(scheme: OriginScheme): this {
    return this.set('expectedScheme', scheme);
  }
  withFormField(name: string): this {
    return this.set('formFieldName', name);
  }
}

/** Accepted input for {@link csrfProtection}. */
export type CsrfOptions = CsrfOptionsBuilder | Partial<CsrfOptionsType>;
export const CsrfOptions = CsrfOptionsBuilder;

/**
 * Validates resolved {@link CsrfOptionsType} settings.  Most rules are
 * bespoke: `secret` is a `string | Uint8Array` union (byte length must be
 * >= 16), and the cookie attributes are nested.  A `secret` that is simply
 * absent is a REQUIRED-field error enforced by `csrfProtection`, not here —
 * the validator only checks the validity of a PRESENT secret.
 *
 * The cookie-prefix rule is the one that has to run here rather than being
 * left to `serializeCookie`: that check fires while the response is being
 * built, so a violated prefix would be a 500 on every safe-method request
 * instead of an error when the middleware is constructed.
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
    this.nonEmptyString('cookieName');
    this.nonEmptyString('headerName');
    this.checkCookiePrefix(s.cookieName ?? DEFAULT_CSRF_COOKIE_NAME, cookie);
    this.oneOf('expectedScheme', ['http', 'https']);
    const notAnOrigin = firstNonOrigin(s.allowedOrigins);
    if (notAnOrigin !== undefined) {
      this.fail('allowedOrigins', 'entries must be full origins, e.g. "https://app.example"', notAnOrigin);
    }
  }

  /**
   * The `__Host-` / `__Secure-` cookie-prefix rules, restated against the
   * attributes as configured — an unset attribute passes, because the
   * middleware resolves it to a compliant default (`Secure`, `Path=/`, no
   * `Domain`).
   */
  private checkCookiePrefix(cookieName: string, cookie: CsrfCookieOptions | undefined): void {
    const optOut = ` — a plain-HTTP deployment needs an unprefixed cookie name, e.g. withCookieName('csrf-token')`;
    if (cookieName.startsWith('__Host-')) {
      if (cookie?.secure === false) {
        this.fail('cookie.secure', `must not be false for the "${cookieName}" cookie${optOut}`, false);
      }
      if (cookie?.path !== undefined && cookie.path !== '/') {
        this.fail('cookie.path', `must be "/" for the "${cookieName}" cookie`, cookie.path);
      }
      if (cookie?.domain !== undefined) {
        this.fail('cookie.domain', `must be unset for the "${cookieName}" cookie`, cookie.domain);
      }
    } else if (cookieName.startsWith('__Secure-') && cookie?.secure === false) {
      this.fail('cookie.secure', `must not be false for the "${cookieName}" cookie${optOut}`, false);
    }
  }
}

/** Plain settings shape for {@link requireSameOrigin}. */
export type SameOriginOptionsType = {
  /**
   * Full origins accepted beyond the request's own.  Compared whole
   * (scheme + host + port), so `'https://partner.example'` does not accept
   * `http://partner.example`.
   */
  readonly allowedOrigins?: ReadonlyArray<string>;
  /** Allow unsafe methods that carry neither Origin nor Referer.  Default false. */
  readonly allowMissingOrigin?: boolean;
  /**
   * Scheme this site is served over — the half of its own origin the
   * `Host` header cannot carry.  Default `'https'`; a plain-HTTP
   * deployment must say so, otherwise its own requests are cross-origin.
   */
  readonly expectedScheme?: OriginScheme;
};

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
  withExpectedScheme(scheme: OriginScheme): this {
    return this.set('expectedScheme', scheme);
  }
}

/** Accepted input for {@link requireSameOrigin}. */
export type SameOriginOptions = SameOriginOptionsBuilder | Partial<SameOriginOptionsType>;
export const SameOriginOptions = SameOriginOptionsBuilder;

/**
 * Validates resolved {@link SameOriginOptionsType} settings.  Both rules
 * exist because the failure they catch is otherwise silent: an
 * `allowedOrigins` entry that is not a full origin never matches anything,
 * and a misspelt `expectedScheme` rejects the site's own requests.
 */
export class SameOriginOptionsValidator extends OptionsValidator<SameOriginOptionsType> {
  constructor() {
    super('SameOriginOptions');
  }
  protected rules(s: Partial<SameOriginOptionsType>): void {
    this.oneOf('expectedScheme', ['http', 'https']);
    const notAnOrigin = firstNonOrigin(s.allowedOrigins);
    if (notAnOrigin !== undefined) {
      this.fail('allowedOrigins', 'entries must be full origins, e.g. "https://app.example"', notAnOrigin);
    }
  }
}
