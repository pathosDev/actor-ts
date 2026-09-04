/**
 * Options for the {@link cors} route directive.  CORS is a *directive*,
 * not a plain middleware: preflight `OPTIONS` requests never match a
 * method-specific route, so the compiler has to synthesise them (see
 * `expandCors`).
 *
 * Route options are the highest layer, not the only one.  This file used to
 * say "options-only (per-route policy; predicates can't live in HOCON
 * anyway)", and the second half of that is still true of exactly two arms —
 * the `'*'` wildcard and the predicate — while the rest of the shape reads
 * perfectly well from `actor-ts.http.cors` (#878).  What resolves it is
 * `resolveCorsPolicy` in `./Cors.ts`, at compile time rather than at
 * route-construction time, because that is the first moment the
 * `ActorSystem`'s configuration is in scope.
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { HttpMethod } from '../Types.js';

/** Allowed origins: `'*'`, an exact-match allowlist, or a predicate. */
export type CorsOrigin = '*' | ReadonlyArray<string> | ((origin: string) => boolean);

/**
 * The wildcard arm of {@link CorsOrigin}, named because two files test for it:
 * the header writer, and the HOCON reader that refuses it.
 */
export const CORS_WILDCARD_ORIGIN = '*';

/**
 * `Access-Control-Allow-Credentials` off, matching what `cors()` has always
 * resolved an unset `credentials` to.  Named so `actor-ts.http.cors.
 * credentials` has a constant to be pinned against rather than being filed
 * away as a feature switch with nothing to disagree with.
 */
export const DEFAULT_CORS_CREDENTIALS = false;

/**
 * Every {@link HttpMethod}, as a runtime list.  The type is a compile-time
 * union, which is enough for a code caller and nothing at all for a HOCON one:
 * `methods` is a settable leaf now, so a typo there would otherwise ship
 * verbatim into `Access-Control-Allow-Methods` and be rejected by the browser
 * rather than by us.
 */
const HTTP_METHODS: ReadonlyArray<HttpMethod> = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/** Plain settings shape for CORS. */
export type CorsOptionsType = {
  /** Required — call withOrigins/withAnyOrigin/withOriginPredicate. */
  readonly origins?: CorsOrigin;
  /** `Access-Control-Allow-Methods`.  Default: the methods registered at the pattern. */
  readonly methods?: ReadonlyArray<HttpMethod>;
  /** `Access-Control-Allow-Headers`.  Default: echo the (sanitised) request's. */
  readonly allowedHeaders?: ReadonlyArray<string>;
  /** `Access-Control-Expose-Headers`.  Default: none. */
  readonly exposedHeaders?: ReadonlyArray<string>;
  /** `Access-Control-Allow-Credentials`.  Default false; forbidden with `'*'`. */
  readonly credentials?: boolean;
  /** `Access-Control-Max-Age` in seconds.  Default: unset. */
  readonly maxAge?: number;
};

/** Fluent builder for {@link CorsOptionsType}. */
export class CorsOptionsBuilder extends OptionsBuilder<CorsOptionsType> {
  static create(): CorsOptionsBuilder {
    return new CorsOptionsBuilder();
  }
  /** Exact-match origin allowlist. */
  withOrigins(...origins: string[]): this {
    return this.set('origins', origins);
  }
  /**
   * Allow any origin (`*`).  Must be explicit — no accidental wildcard, and
   * that now means "no wildcard from a config file either": `actor-ts.http.
   * cors.origins` refuses a `"*"` entry rather than honouring it.
   */
  withAnyOrigin(): this {
    return this.set('origins', CORS_WILDCARD_ORIGIN);
  }
  /** Decide per request; a throwing predicate denies. */
  withOriginPredicate(predicate: (origin: string) => boolean): this {
    return this.set('origins', predicate);
  }
  withMethods(...methods: HttpMethod[]): this {
    return this.set('methods', methods);
  }
  withAllowedHeaders(...headers: string[]): this {
    return this.set('allowedHeaders', headers);
  }
  withExposedHeaders(...headers: string[]): this {
    return this.set('exposedHeaders', headers);
  }
  withCredentials(flag = true): this {
    return this.set('credentials', flag);
  }
  withMaxAge(seconds: number): this {
    return this.set('maxAge', seconds);
  }
}

/** Accepted input: the builder or a plain object. */
export type CorsOptions = CorsOptionsBuilder | Partial<CorsOptionsType>;
export const CorsOptions = CorsOptionsBuilder;

/**
 * Validates resolved {@link CorsOptionsType} settings.  `maxAge` (the
 * preflight cache lifetime, in seconds) must be non-negative, every entry of
 * `methods` must be a method this router knows, and the cross-field rule
 * enforces the Fetch spec's ban on combining `credentials` with a wildcard
 * (`'*'`) origin.  (The required-ness of `origins` is a separate guard, in
 * `resolveCorsPolicy` — it cannot be answered until the HOCON layer has been
 * merged in, because config alone may supply it.)
 *
 * It runs twice per route, on purpose and cheaply: once in `cors()` over the
 * code options alone, so a contradiction a caller *wrote* still surfaces where
 * they wrote it, and once in `resolveCorsPolicy` over the merged settings, so
 * a value that only exists once HOCON is layered in is checked too.
 */
export class CorsOptionsValidator extends OptionsValidator<CorsOptionsType> {
  constructor() {
    super('CorsOptions');
  }
  protected rules(s: Partial<CorsOptionsType>): void {
    this.nonNegativeNumber('maxAge');
    this.knownMethods(s.methods);
    if (s.credentials === true && s.origins === CORS_WILDCARD_ORIGIN) {
      this.fail('credentials', 'cannot be combined with "*" origins (the Fetch spec forbids it)', s.credentials);
    }
  }

  /**
   * Every entry of `methods` is a real HTTP method.  A bespoke rule rather
   * than `oneOf`, which checks a scalar against a list; this is a list against
   * a list, and the message has to name the offending entry rather than the
   * whole array.  A no-op on `undefined`, like every other helper.
   */
  private knownMethods(methods: ReadonlyArray<HttpMethod> | undefined): void {
    if (methods === undefined) return;
    for (const method of methods) {
      if (!HTTP_METHODS.includes(method)) {
        this.fail('methods', `must contain only ${HTTP_METHODS.join(', ')}`, method);
      }
    }
  }
}
