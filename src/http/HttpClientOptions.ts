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
 *
 *     const clientOptions = HttpClientOptions.create()
 *       .withMaxResponseBytes(32 * 1024 * 1024)
 *       .withDefaultTimeoutMs(5_000);
 *     const client = new HttpClient(clientOptions);
 *
 * Every field here is a **fallback**, not a fixed policy: the matching field
 * on an individual `HttpClientRequest` wins, so one large download does not
 * force the whole client's ceiling up.  There is no HOCON layer — see
 * `HttpExtension.newClient`.
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
};

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
}

/**
 * Validates resolved {@link HttpClientOptionsType} settings.
 *
 * Both fields are ceilings that only mean anything above zero, and both are
 * silently catastrophic when mis-set: a `maxResponseBytes` of `0` or `NaN`
 * would refuse every response, and a `defaultTimeoutMs` of `NaN` would arm a
 * timer that never fires — reinstating exactly the unbounded wait the default
 * exists to close.  Neither shows up as a type error, so the check runs once
 * at construction on the merged settings.
 */
export class HttpClientOptionsValidator extends OptionsValidator<HttpClientOptionsType> {
  constructor() {
    super('HttpClientOptions');
  }
  protected rules(_s: Partial<HttpClientOptionsType>): void {
    this.positiveInt('maxResponseBytes');
    this.positiveNumber('defaultTimeoutMs');
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
