/**
 * HTTP Strict-Transport-Security middleware.
 *
 * Sets the `Strict-Transport-Security` header unconditionally (no HTTPS
 * gating): an `HttpRequest` carries no scheme, framework servers usually
 * sit behind a TLS-terminating proxy, and per RFC 6797 §8.1 browsers
 * ignore the header over plain HTTP anyway — so a plain-HTTP dev server is
 * a harmless no-op.
 */
import { ConfigError, type Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { mergeOptions } from '../../util/OptionsMerge.js';
import { configAwareMiddleware, type Middleware } from '../Route.js';
import { headerDecorator } from './Headers.js';
import {
  DEFAULT_HSTS_INCLUDE_SUB_DOMAINS,
  DEFAULT_HSTS_MAX_AGE_SECONDS,
  DEFAULT_HSTS_PRELOAD,
  HstsOptionsValidator,
  type HstsOptions,
  type HstsOptionsType,
} from './HstsOptions.js';

/**
 * The shortest `max-age`, in seconds, that `actor-ts.http.hsts.max-age` may
 * set: one day.  A pin shorter than that has lapsed before a visitor comes
 * back the next day, so a file that set it would switch HSTS off in all but
 * name — and `0` switches it off outright (RFC 6797 §6.1.1).  A day still
 * leaves every stage of hstspreload.org's ramp-up from one week on to the
 * file; its five-minute first stage, the one meant for backing out quickly,
 * is a decision for code (`withMaxAge(300)`), as is any value below this.
 */
export const MINIMUM_CONFIGURED_HSTS_MAX_AGE_SECONDS = 86_400;

export type ResolvedHsts = {
  readonly maxAge: number;
  readonly includeSubDomains: boolean;
  readonly preload: boolean;
};

/**
 * Merge an HSTS options bag over `actor-ts.http.hsts` and the built-in
 * defaults — options > HOCON > built-in, per field — and validate the merged
 * policy once.
 *
 * `config` is absent on two paths: a tree compiled without a system, and the
 * `hsts` field of the `securityHeaders()` bundle, which stays code-only and so
 * never reads the block.  Both get what this function always returned, the
 * options over the built-in defaults.
 *
 * The cross-field `preload` rule is part of that one validation, on the
 * merged policy, rather than a check of the options alone: the year it
 * demands can come from the configuration file, so whether `withPreload()`
 * is valid is not known until the file is.
 */
export function resolveHsts(options: Partial<HstsOptionsType>, config?: Config): ResolvedHsts {
  const resolved = mergeOptions<ResolvedHsts>(
    {
      maxAge: DEFAULT_HSTS_MAX_AGE_SECONDS,
      includeSubDomains: DEFAULT_HSTS_INCLUDE_SUB_DOMAINS,
      preload: DEFAULT_HSTS_PRELOAD,
    },
    config === undefined ? {} : readHstsOptionsFromConfig(config),
    options,
  );
  // hstspreload.org submission rules — refuse a policy that could never
  // actually be preloaded rather than emitting a silently-useless header.
  new HstsOptionsValidator().validate(resolved);
  return resolved;
}

/**
 * The `actor-ts.http.hsts` layer, as a partial — an unset leaf is left out of
 * the result, so the layer below it is reached rather than shadowed by a key
 * present as `undefined`.
 *
 * Values are read raw and left to {@link HstsOptionsValidator} on the merged
 * policy, with one exception: a `max-age` below
 * {@link MINIMUM_CONFIGURED_HSTS_MAX_AGE_SECONDS}, a day, is refused here
 * with a `ConfigError` naming the key and the floor.  `0` has every browser
 * forget the pin (RFC 6797 §6.1.1), and a shorter pin than a day has lapsed
 * before a visitor comes back the next day — either way HSTS is off for every
 * client of every `hsts()` route in the process, which one line in a
 * configuration file must not be able to do.  Code can still ask for any
 * value, `withMaxAge(0)` included.  A negative one is not a pin at all and
 * stays the validator's, which refuses it on the merged policy exactly as it
 * refuses one from code.  The refusal sits in the reader rather than in a
 * caller so that no caller of this seam can skip it.
 */
export function readHstsOptionsFromConfig(config: Config): Partial<HstsOptionsType> {
  const keys = ConfigKeys.http.hsts;
  if (!config.hasPath(keys.root)) return {};
  const out: { -readonly [K in keyof HstsOptionsType]: HstsOptionsType[K] } = {};
  // `getInt`, never `getDuration`: the field is a count of SECONDS written
  // straight into the header, while `getDuration` answers in milliseconds,
  // so `180d` would be sent as a pin a thousand times too long.
  if (config.hasPath(keys.maxAge)) out.maxAge = configuredMaxAge(config, keys.maxAge);
  if (config.hasPath(keys.includeSubDomains)) out.includeSubDomains = config.getBoolean(keys.includeSubDomains);
  if (config.hasPath(keys.preload)) out.preload = config.getBoolean(keys.preload);
  return out;
}

/** The configured `max-age`, held to {@link MINIMUM_CONFIGURED_HSTS_MAX_AGE_SECONDS}. */
function configuredMaxAge(config: Config, key: string): number {
  const maxAge = config.getInt(key);
  if (maxAge >= 0 && maxAge < MINIMUM_CONFIGURED_HSTS_MAX_AGE_SECONDS) {
    throw new ConfigError(
      `Config at "${key}" must be at least ${MINIMUM_CONFIGURED_HSTS_MAX_AGE_SECONDS} (one day, in seconds), got ${maxAge}.  `
      + 'max-age=0 tells every browser to forget its HSTS pin, and a shorter pin than a day lapses before a '
      + 'visitor comes back the next day, so a configuration file may not set either for every hsts() route '
      + 'in the process.  A shorter max-age is set in code, with withMaxAge(...).',
    );
  }
  return maxAge;
}

/** Format the resolved policy as the header value. */
export function hstsHeaderValue(r: ResolvedHsts): string {
  let value = `max-age=${r.maxAge}`;
  if (r.includeSubDomains) value += '; includeSubDomains';
  if (r.preload) value += '; preload';
  return value;
}

/**
 * Build a middleware that adds `Strict-Transport-Security` to every
 * response its subtree produces (without clobbering one a handler already
 * set) — including the response of a thrown `HttpError` short-circuit,
 * which is what a first-contact client gets when its very first request is
 * the one that gets rejected (#606).
 *
 * The policy is `options` over `actor-ts.http.hsts` over the built-in
 * defaults, per field (#1462).  The options are taken now; the configuration
 * and the validation of the merged policy wait for the route tree to be
 * compiled — inside `bind()`, which is where an invalid policy fails.
 */
export function strictTransportSecurity(options: HstsOptions = {}): Middleware {
  // A snapshot: a builder is its settings and stays mutable, and a later
  // `withX` on it must not reach a middleware it was already handed to.
  const routeOptions: Partial<HstsOptionsType> = { ...(options as Partial<HstsOptionsType>) };
  return configAwareMiddleware(ConfigKeys.http.hsts.root, (config) =>
    headerDecorator({ 'strict-transport-security': hstsHeaderValue(resolveHsts(routeOptions, config)) }));
}

/** Short alias for {@link strictTransportSecurity}. */
export const hsts = strictTransportSecurity;
