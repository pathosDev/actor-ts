/**
 * Options for the {@link contentSecurityPolicy} middleware.  Options-only
 * (no HOCON — an app's CSP is code, and nested directive maps are awkward
 * in config).
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';

/**
 * Typed CSP directive map.  camelCase keys serialise to their kebab-case
 * directive names.  A directive present with an empty array is dropped
 * (lets you remove a baseline directive by setting it to `[]`).
 */
export interface CspDirectives {
  readonly defaultSrc?: readonly string[];
  readonly scriptSrc?: readonly string[];
  readonly scriptSrcAttr?: readonly string[];
  readonly styleSrc?: readonly string[];
  readonly imgSrc?: readonly string[];
  readonly connectSrc?: readonly string[];
  readonly fontSrc?: readonly string[];
  readonly objectSrc?: readonly string[];
  readonly mediaSrc?: readonly string[];
  readonly frameSrc?: readonly string[];
  readonly frameAncestors?: readonly string[];
  readonly baseUri?: readonly string[];
  readonly formAction?: readonly string[];
  readonly workerSrc?: readonly string[];
  readonly manifestSrc?: readonly string[];
  /** Valueless directive. */
  readonly upgradeInsecureRequests?: boolean;
  readonly reportUri?: readonly string[];
  readonly reportTo?: string;
}

/** Plain settings shape for CSP. */
export interface CspOptionsType {
  /** Directives to emit; merged over the baseline unless `useDefaults` is false. */
  readonly directives?: CspDirectives;
  /** Merge over a helmet-parity baseline.  Default true. */
  readonly useDefaults?: boolean;
  /** Emit `Content-Security-Policy-Report-Only` instead of enforcing.  Default false. */
  readonly reportOnly?: boolean;
}

/** Fluent builder for {@link CspOptionsType}. */
export class CspOptionsBuilder extends OptionsBuilder<CspOptionsType> {
  static create(): CspOptionsBuilder {
    return new CspOptionsBuilder();
  }
  withDirectives(directives: CspDirectives): this {
    return this.set('directives', directives);
  }
  /** Emit only the given directives — skip the baseline. */
  withoutDefaults(): this {
    return this.set('useDefaults', false);
  }
  withReportOnly(flag = true): this {
    return this.set('reportOnly', flag);
  }
}

/** Accepted input: the builder or a plain object. */
export type CspOptions = CspOptionsBuilder | Partial<CspOptionsType>;
export const CspOptions = CspOptionsBuilder;
