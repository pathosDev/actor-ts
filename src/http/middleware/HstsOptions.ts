/**
 * Options for the {@link strictTransportSecurity} middleware.  Three
 * exports in the Options family (type / builder / union), per the repo
 * convention.  Options-only — like the other HTTP middleware, this reads
 * no HOCON (a middleware factory has no ActorSystem to resolve against).
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

/**
 * Minimum `max-age` (1 year, in seconds) the hstspreload.org submission
 * rules require before a `preload` policy is accepted.
 */
export const HSTS_PRELOAD_MIN_MAX_AGE = 31_536_000;

/** Plain settings shape for HSTS. */
export type HstsOptionsType = {
  /** `max-age` in seconds.  Default 15552000 (180 days). */
  readonly maxAge?: number;
  /** Emit `includeSubDomains`.  Default true. */
  readonly includeSubDomains?: boolean;
  /** Emit `preload`.  Default false; requires `maxAge >= 1 year` + `includeSubDomains`. */
  readonly preload?: boolean;
};

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

/**
 * Validates resolved {@link HstsOptionsType} settings.  `maxAge` must be a
 * whole, non-negative number of seconds that prints as plain digits: RFC 6797
 * writes the directive as delta-seconds, and a browser ignores an STS header
 * it cannot parse, so `max-age=1.5` or `max-age=1e+21` switched HSTS off while
 * looking configured (#1462).  The cross-field rule mirrors the
 * hstspreload.org submission requirements — a `preload` policy that could
 * never actually be accepted (too-short `maxAge`, or `includeSubDomains`
 * turned off) is rejected rather than emitting a silently-useless header.
 */
export class HstsOptionsValidator extends OptionsValidator<HstsOptionsType> {
  constructor() {
    super('HstsOptions');
  }
  protected rules(s: Partial<HstsOptionsType>): void {
    this.nonNegativeInt('maxAge');
    if (s.maxAge !== undefined && s.maxAge > Number.MAX_SAFE_INTEGER) {
      this.fail('maxAge', `must be at most ${Number.MAX_SAFE_INTEGER} — a larger number is written in exponent form, which is not delta-seconds`, s.maxAge);
    }
    if (
      s.preload === true &&
      ((s.maxAge ?? 0) < HSTS_PRELOAD_MIN_MAX_AGE || s.includeSubDomains === false)
    ) {
      this.fail('preload', 'requires maxAge >= 31536000 (1 year) and includeSubDomains', s.preload);
    }
  }
}
