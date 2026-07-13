/**
 * Options for the {@link strictTransportSecurity} middleware.  Three
 * exports in the Options family (type / builder / union), per the repo
 * convention.  Options-only — like the other HTTP middleware, this reads
 * no HOCON (a middleware factory has no ActorSystem to resolve against).
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';

/** Plain settings shape for HSTS. */
export interface HstsOptionsType {
  /** `max-age` in seconds.  Default 15552000 (180 days). */
  readonly maxAge?: number;
  /** Emit `includeSubDomains`.  Default true. */
  readonly includeSubDomains?: boolean;
  /** Emit `preload`.  Default false; requires `maxAge >= 1 year` + `includeSubDomains`. */
  readonly preload?: boolean;
}

/** Fluent builder for {@link HstsOptionsType}. */
export class HstsOptionsBuilder extends OptionsBuilder<HstsOptionsType> {
  static create(): HstsOptionsBuilder {
    return new HstsOptionsBuilder();
  }
  withMaxAge(seconds: number): this {
    return this.set('maxAge', seconds);
  }
  withIncludeSubDomains(flag = true): this {
    return this.set('includeSubDomains', flag);
  }
  withPreload(flag = true): this {
    return this.set('preload', flag);
  }
}

/** Accepted input: the builder or a plain object. */
export type HstsOptions = HstsOptionsBuilder | Partial<HstsOptionsType>;
export const HstsOptions = HstsOptionsBuilder;
