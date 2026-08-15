/**
 * All HTTP-client option-relevant types live here:
 *
 *   - {@link HttpClientOptionsType} — the plain options-object shape
 *     (what you may also pass as a bare `{ … }` object).
 *   - {@link HttpClientOptionsBuilder} — the fluent builder
 *     (`HttpClientOptions.create()…`).
 *   - {@link HttpClientOptions} — the accepted-input **union**
 *     (`HttpClientOptionsBuilder | Partial<HttpClientOptionsType>`), plus a
 *     value alias to the builder so `HttpClientOptions.create()` /
 *     `new HttpClientOptions()` resolve to it.
 *   - {@link HttpClientOptionsValidator} — the consume-time domain check,
 *     run once by the `HttpClient` constructor on the merged settings.
 *   - {@link HttpClientRequestLimits} / {@link HttpClientRequestLimitsValidator}
 *     — the same bounds as they appear on a single request, and their own
 *     (deliberately different) rule set.
 *
 *     const clientOptions = HttpClientOptions.create()
 *       .withMaxResponseBytes(32 * 1024 * 1024)
 *       .withDefaultTimeoutMs(5_000);
 *     const client = new HttpClient(clientOptions);
 *
 * Every field here is a **fallback**, not a fixed policy: the matching field
 * on an individual `HttpClientRequest` wins, so one large download does not
 * force the whole client's ceiling up.
 *
 * Three layers, in the project's usual precedence — request > these options >
 * HOCON (`actor-ts.http.client`) > the built-in defaults below.  The HOCON
 * layer is applied by `HttpExtension`, which is the only thing that holds a
 * system to read config from; a `new HttpClient()` constructed directly (the
 * D1 transport, a test) gets the built-in defaults and names its own bounds.
 */
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/**
 * Ceiling on a buffered response body when neither the request nor the client
 * names one — 8 MiB.
 *
 * The client materialises a whole response in memory before handing it back,
 * so without a ceiling the peer decides how much of this process's heap it
 * gets to take: a `Content-Length` is a claim, not a bound, and a chunked
 * response has no length at all.  The number has to be a compromise, because
 * it is simultaneously the largest legitimate download that still works and
 * the largest hostile one that has to be tolerated.
 *
 * 8 MiB, i.e. between the two in-repo neighbours rather than equal to either:
 * the 1 MiB inbound request cap (`DEFAULT_HTTP_MAX_BODY_BYTES`) is far too
 * tight for an outbound API call — a page of query results from a REST API
 * routinely passes it — while the 50 MiB static-file cap describes reading a
 * file this process already owns, which is not a threat model at all.  8 MiB
 * holds tens of thousands of JSON records, so the applications that trip it
 * are the ones deliberately downloading a payload, and those are exactly the
 * ones that can say `maxResponseBytes` on the request.
 */
export const DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Deadline applied to a request that names no `timeoutMs` — 30 s.
 *
 * The load-bearing half of the cap: `fetch`'s abort signal tears down an
 * in-flight *body read*, not just the header exchange, so a request with a
 * deadline is already bounded by bandwidth × deadline.  A request without one
 * is not bounded by anything — a peer that dribbles a byte a minute holds the
 * caller (and any actor awaiting it) forever, which is why the fallback is a
 * real number instead of "off".
 *
 * 30 s matches the deadline the shipped D1 journal already chose for itself
 * (`D1Connection.timeoutMs`), the only in-repo caller that named one — long
 * enough that a slow third-party API is not cut off mid-answer, short enough
 * that a hung connection surfaces inside a supervision cycle rather than at
 * the next deploy.  Pass `timeoutMs: 0` on a request to opt out for a call
 * that legitimately has no deadline.
 */
export const DEFAULT_HTTP_CLIENT_TIMEOUT_MS = 30_000;

/**
 * What the client does with a 3xx that carries a `Location`.
 *
 *   - `'follow'` — chase it, up to `maxRedirects` hops, dropping
 *     `authorization` / `cookie` / `proxy-authorization` on any hop that
 *     crosses origins.
 *   - `'error'` — refuse it: the call throws `HttpRedirectError` and no
 *     request is ever issued against the target.
 *   - `'manual'` — hand the 3xx back untouched, `Location` readable in
 *     `headers`, so the caller decides.
 */
export type HttpRedirectMode = 'follow' | 'error' | 'manual';

/**
 * What an unconfigured client does with a redirect — follow it.
 *
 * Following is what every caller already got (the platform default) and what
 * the overwhelming majority of real endpoints need: `http` → `https`, a
 * missing trailing slash, a moved API version.  Defaulting to `'error'`
 * instead would break those silently at the first deploy for a risk that has
 * no attacker-reachable path in this repo — the point of #625 is that the safe
 * behaviour was *unreachable*, not that the unsafe one was common.
 *
 * What "follow" means is now this client's business rather than the
 * platform's, which is where the actual hardening lives: a bounded hop count,
 * an explicit credential-stripping rule, and a refusal to leave HTTP(S).
 */
export const DEFAULT_HTTP_CLIENT_REDIRECT_MODE: HttpRedirectMode = 'follow';

/**
 * Hops a followed redirect chain may take before the call is refused — 5.
 *
 * Down from the platform's 20, because 20 is a browser's budget for
 * hand-written navigation chains and a service client has no comparable
 * need: an endpoint that needs more than a handful of hops is either
 * misconfigured or walking the caller somewhere on purpose, and every hop is
 * one more host that gets to nominate the next one.  5 clears every
 * legitimate chain observed in practice (scheme upgrade, canonical host,
 * trailing slash, a version alias) with room to spare.
 *
 * `0` refuses the first redirect outright, which is `'error'` by another
 * name — it is allowed so a caller can express the policy as a number.
 */
export const DEFAULT_HTTP_CLIENT_MAX_REDIRECTS = 5;

/** Plain settings shape accepted by the {@link HttpClient} constructor. */
export type HttpClientOptionsType = {
  /**
   * Largest response body buffered before the request is aborted.  Default
   * 8 MiB; a request's own `maxResponseBytes` wins.
   */
  readonly maxResponseBytes?: number;
  /**
   * Deadline for a request that names no `timeoutMs`.  Default 30 s; a
   * request's own `timeoutMs` wins, and `0` there means "no deadline".
   */
  readonly defaultTimeoutMs?: number;
  /**
   * What to do with a 3xx carrying a `Location`.  Default `'follow'`; a
   * request's own `redirect` wins.
   */
  readonly redirect?: HttpRedirectMode;
  /**
   * Hops a followed chain may take before the call is refused.  Default 5;
   * `0` refuses the first redirect.  Only consulted when `redirect` is
   * `'follow'`.
   */
  readonly maxRedirects?: number;
};

/**
 * The bounds one `HttpClientRequest` may override, and the exact shape
 * {@link HttpClientRequestLimitsValidator} checks.
 *
 * Declared here rather than inline on the request type so the per-request
 * domain and the client-wide one sit in the same file: they are deliberately
 * *not* the same rule set, and anyone about to unify them should have to read
 * both first.
 */
export type HttpClientRequestLimits = {
  /**
   * Abort the request after this many milliseconds.  Falls back to the
   * client's `defaultTimeoutMs` (30 s); `0` opts this one call out of any
   * deadline.  The deadline spans the whole redirect chain, not each hop.
   */
  readonly timeoutMs?: number;
  /**
   * Abort the request once the response body passes this many bytes.  Falls
   * back to the client's `maxResponseBytes` (8 MiB) — raise it here for the
   * one call that legitimately downloads more, rather than on the shared
   * client.
   */
  readonly maxResponseBytes?: number;
  /**
   * What to do with a 3xx carrying a `Location`.  Falls back to the client's
   * `redirect` (`'follow'`).
   */
  readonly redirect?: HttpRedirectMode;
  /**
   * Hops a followed chain may take before the call is refused.  Falls back to
   * the client's `maxRedirects` (5); `0` refuses the first redirect.
   */
  readonly maxRedirects?: number;
};

/**
 * Validates the overrides carried by a single request, once per call.
 *
 * Without this the bound is trivially disarmed from the caller's side, which
 * is the very defect #602 is about rather than a nitpick: `timeoutMs` is
 * consumed as `if (timeoutMs > 0)`, so `NaN` or a negative arms no timer at
 * all and the call is unbounded in time; `maxResponseBytes` is consumed as
 * `if (total > maxBytes)`, so `NaN` or `Infinity` never trips and the body
 * buffers without limit; and `maxRedirects` is consumed as
 * `if (hops >= maxRedirects)`, so `NaN` there follows a hostile chain
 * forever.  None of the three needs a typo to happen — a computed budget
 * (`deadline - Date.now()` gone negative) or an untyped config value gets
 * there on its own.
 *
 * **The rules are deliberately not {@link HttpClientOptionsValidator}'s, and
 * the two must not be merged.**  `timeoutMs: 0` is the documented way to opt
 * one call out of the deadline, so zero is *valid* here — while a client-wide
 * `defaultTimeoutMs` of 0 would silently disarm every call that names no
 * deadline of its own and stays rejected there.  Unifying the rule sets
 * breaks whichever half is not being looked at.
 */
export class HttpClientRequestLimitsValidator extends OptionsValidator<HttpClientRequestLimits> {
  constructor() {
    super('HttpClientRequest');
  }
  protected rules(_s: Partial<HttpClientRequestLimits>): void {
    // Non-negative rather than positive: 0 is the opt-out, NaN and negatives
    // are the silent no-timer.
    this.nonNegativeNumber('timeoutMs');
    this.positiveInt('maxResponseBytes');
    this.oneOf('redirect', ['follow', 'error', 'manual']);
    this.nonNegativeInt('maxRedirects');
  }
}

/** Fluent builder for {@link HttpClientOptionsType}. */
export class HttpClientOptionsBuilder extends OptionsBuilder<HttpClientOptionsType> {
  /** Start a fresh builder.  Equivalent to `new HttpClientOptionsBuilder()`. */
  static create(): HttpClientOptionsBuilder {
    return new HttpClientOptionsBuilder();
  }

  /** Largest response body buffered before the request is aborted.  Default 8 MiB. */
  withMaxResponseBytes(bytes: number): this {
    return this.set('maxResponseBytes', bytes);
  }

  /** Deadline for a request that names no `timeoutMs`.  Default 30 s. */
  withDefaultTimeoutMs(ms: number): this {
    return this.set('defaultTimeoutMs', ms);
  }

  /** What to do with a 3xx carrying a `Location`.  Default `'follow'`. */
  withRedirect(mode: HttpRedirectMode): this {
    return this.set('redirect', mode);
  }

  /** Hops a followed chain may take before the call is refused.  Default 5. */
  withMaxRedirects(hops: number): this {
    return this.set('maxRedirects', hops);
  }
}

/**
 * Validates resolved {@link HttpClientOptionsType} settings.
 *
 * Every field here is silently catastrophic when mis-set, and none of the
 * failures show up as a type error: a `maxResponseBytes` of `0` or `NaN`
 * refuses every response, a `defaultTimeoutMs` of `NaN` arms a timer that
 * never fires — reinstating exactly the unbounded wait the default exists to
 * close — and a misspelled `redirect` read from an untyped config would be
 * neither of the three modes, which is a redirect policy nobody chose.  So
 * the check runs once at construction on the merged settings.
 *
 * `maxRedirects` is the one bound allowed to be zero: refusing the first
 * redirect is a policy, not a mistake.
 */
export class HttpClientOptionsValidator extends OptionsValidator<HttpClientOptionsType> {
  constructor() {
    super('HttpClientOptions');
  }
  protected rules(_s: Partial<HttpClientOptionsType>): void {
    this.positiveInt('maxResponseBytes');
    this.positiveNumber('defaultTimeoutMs');
    this.oneOf('redirect', ['follow', 'error', 'manual']);
    this.nonNegativeInt('maxRedirects');
  }
}

/**
 * Accepted input for any HTTP-client-configurable constructor: the fluent
 * {@link HttpClientOptionsBuilder} OR a plain {@link HttpClientOptionsType}
 * object.
 */
export type HttpClientOptions = HttpClientOptionsBuilder | Partial<HttpClientOptionsType>;
/** Value alias so `HttpClientOptions.create()` / `new HttpClientOptions()` resolve to the builder. */
export const HttpClientOptions = HttpClientOptionsBuilder;
