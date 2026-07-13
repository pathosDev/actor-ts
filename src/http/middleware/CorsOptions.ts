/**
 * Options for the {@link cors} route directive.  CORS is a *directive*,
 * not a plain middleware: preflight `OPTIONS` requests never match a
 * method-specific route, so the compiler has to synthesise them (see
 * `expandCors`).  Options-only (per-route policy; predicates can't live in
 * HOCON anyway).
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { HttpMethod } from '../types.js';

/** Allowed origins: `'*'`, an exact-match allowlist, or a predicate. */
export type CorsOrigin = '*' | ReadonlyArray<string> | ((origin: string) => boolean);

/** Plain settings shape for CORS. */
export interface CorsOptionsType {
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
}

/** Fluent builder for {@link CorsOptionsType}. */
export class CorsOptionsBuilder extends OptionsBuilder<CorsOptionsType> {
  static create(): CorsOptionsBuilder {
    return new CorsOptionsBuilder();
  }
  /** Exact-match origin allowlist. */
  withOrigins(...origins: string[]): this {
    return this.set('origins', origins);
  }
  /** Allow any origin (`*`).  Must be explicit — no accidental wildcard. */
  withAnyOrigin(): this {
    return this.set('origins', '*');
  }
  /** Decide per request; a throwing predicate denies. */
  withOriginPredicate(fn: (origin: string) => boolean): this {
    return this.set('origins', fn);
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
