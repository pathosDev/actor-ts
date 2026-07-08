/**
 * Options for the {@link securityHeaders} bundle.  Every header is
 * individually overridable, and `false` disables it.  Options-only.
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { HstsOptionsType } from './HstsOptions.js';

/** Plain settings shape for the security-headers bundle. */
export interface SecurityHeadersOptionsType {
  /** `X-Content-Type-Options: nosniff`.  Default true. */
  readonly contentTypeOptions?: boolean;
  /** `X-Frame-Options`.  Default `'DENY'`; `false` omits it. */
  readonly frameOptions?: 'DENY' | 'SAMEORIGIN' | false;
  /** `Referrer-Policy`.  Default `'no-referrer'`; `false` omits it. */
  readonly referrerPolicy?: string | false;
  /** `Permissions-Policy` as feature→allowlist.  Default `false` (omitted). */
  readonly permissionsPolicy?: Readonly<Record<string, readonly string[]>> | false;
  /** `Cross-Origin-Opener-Policy`.  Default `'same-origin'`; `false` omits it. */
  readonly crossOriginOpenerPolicy?: 'same-origin' | 'same-origin-allow-popups' | 'unsafe-none' | false;
  /** `Cross-Origin-Resource-Policy`.  Default `'same-origin'`; `false` omits it. */
  readonly crossOriginResourcePolicy?: 'same-origin' | 'same-site' | 'cross-origin' | false;
  /** `Cross-Origin-Embedder-Policy`.  Default `false` (breaks embeds; opt-in). */
  readonly crossOriginEmbedderPolicy?: 'require-corp' | 'credentialless' | false;
  /** `X-XSS-Protection: 0` (disable the buggy legacy filter).  Default true. */
  readonly xssProtection?: boolean;
  /** Also emit HSTS with these options.  Default `false` (opt-in — see {@link strictTransportSecurity}). */
  readonly hsts?: Partial<HstsOptionsType> | false;
}

/** Fluent builder for {@link SecurityHeadersOptionsType}. */
export class SecurityHeadersOptionsBuilder extends OptionsBuilder<SecurityHeadersOptionsType> {
  static create(): SecurityHeadersOptionsBuilder {
    return new SecurityHeadersOptionsBuilder();
  }
  withContentTypeOptions(flag = true): this {
    return this.set('contentTypeOptions', flag);
  }
  withFrameOptions(value: 'DENY' | 'SAMEORIGIN' | false): this {
    return this.set('frameOptions', value);
  }
  withReferrerPolicy(value: string | false): this {
    return this.set('referrerPolicy', value);
  }
  withPermissionsPolicy(value: Readonly<Record<string, readonly string[]>> | false): this {
    return this.set('permissionsPolicy', value);
  }
  withCrossOriginOpenerPolicy(value: 'same-origin' | 'same-origin-allow-popups' | 'unsafe-none' | false): this {
    return this.set('crossOriginOpenerPolicy', value);
  }
  withCrossOriginResourcePolicy(value: 'same-origin' | 'same-site' | 'cross-origin' | false): this {
    return this.set('crossOriginResourcePolicy', value);
  }
  withCrossOriginEmbedderPolicy(value: 'require-corp' | 'credentialless' | false): this {
    return this.set('crossOriginEmbedderPolicy', value);
  }
  withXssProtection(flag = true): this {
    return this.set('xssProtection', flag);
  }
  withHsts(value: Partial<HstsOptionsType> | false = {}): this {
    return this.set('hsts', value);
  }
}

/** Accepted input: the builder or a plain object. */
export type SecurityHeadersOptions = SecurityHeadersOptionsBuilder | Partial<SecurityHeadersOptionsType>;
export const SecurityHeadersOptions = SecurityHeadersOptionsBuilder;
