/**
 * Request-id middleware.  Adds a stable id to the request (so handlers and
 * downstream calls can correlate) and echoes it on the response.  An
 * incoming id is accepted only if it is well-formed — never echo raw
 * client bytes back into a header.
 */
import type { Middleware } from '../Route.js';
import { HttpError, type HttpRequest } from '../Types.js';
import { randomUuid } from '../../util/RandomString.js';
import { applyHeaders, applyHeadersToError } from './Headers.js';
import { DEFAULT_REQUEST_ID_HEADER } from './RequestIdOptions.js';
import type { RequestIdOptions, RequestIdOptionsType } from './RequestIdOptions.js';

/** Conservative id shape — enough for UUIDs, ULIDs, and trace ids; caps length. */
const VALID_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The request id `request` carries, or `undefined` when it carries none —
 * or when what it carries is not a well-formed id.
 *
 * The check is the reason this is a function rather than a header read at
 * the call site: the value is client-controlled, and raw client bytes on a
 * log line can forge whole log records through an embedded newline.  It is
 * the same check the middleware applies before echoing an incoming id into
 * a response header, deliberately shared rather than re-derived.
 *
 * What comes back is what the *request* claimed, which is what correlation
 * needs — with `trustIncoming: false` the middleware will have generated a
 * different id for everything downstream of it, so a caller that logs this
 * should name the header it came from rather than present it as the id.
 */
export function requestIdOf(
  request: HttpRequest,
  headerName: string = DEFAULT_REQUEST_ID_HEADER,
): string | undefined {
  const value = request.headers[headerName.toLowerCase()];
  return value !== undefined && VALID_ID.test(value) ? value : undefined;
}

/** A request id together with the header it travels in. */
export type RequestIdCorrelation = {
  readonly headerName: string;
  readonly id: string;
};

/**
 * The id each non-`HttpError` throw passed through with, keyed by the thrown
 * value itself (#1064).  A side table rather than a wrapper: an error handler
 * — `handleErrors`, `withErrorHandler` — must still receive the very value
 * the handler threw, so the id cannot travel *on* it.  Weak, so an error
 * nobody holds any more takes its entry with it.
 */
const REQUEST_IDS_OF_ERRORS = new WeakMap<object, RequestIdCorrelation>();

/**
 * Record the id `error` passed through with — unless one is recorded
 * already: the first to record it is the innermost, which named the id the
 * failing handler actually saw.  A primitive throw has no identity to key
 * on and is skipped.
 */
export function rememberRequestIdOfError(error: unknown, correlation: RequestIdCorrelation): void {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    if (!REQUEST_IDS_OF_ERRORS.has(error)) REQUEST_IDS_OF_ERRORS.set(error, correlation);
  }
}

/**
 * The request id a thrown value passed through on its way out — the one the
 * innermost {@link requestId} middleware assigned, or the one the server
 * generated for the generic 500 — or `undefined` when nothing recorded one.
 * For a `withErrorHandler` that builds its own 500 and wants the same id on
 * it that the error log line names.
 */
export function requestIdOfError(error: unknown): RequestIdCorrelation | undefined {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    return REQUEST_IDS_OF_ERRORS.get(error);
  }
  return undefined;
}

/**
 * The header a generic 500 for `error` carries — the id recorded against it
 * — or an empty map when nothing recorded one.  Each backend's default
 * mapping writes it, so the 500 names the id the error log line names.
 */
export function requestIdHeadersOfError(error: unknown): Record<string, string> {
  const correlation = requestIdOfError(error);
  return correlation === undefined ? {} : { [correlation.headerName]: correlation.id };
}

/**
 * Build a middleware that assigns/propagates a request id.
 *
 * The id is echoed on the response the inner stack returns *and* on the one
 * a thrown `HttpError` short-circuit produces — a rejection is exactly the
 * response whose id the operator later needs to find the log line (#606).
 * A non-`HttpError` throw is rethrown untouched, so an error handler still
 * sees the value the handler threw; the id is recorded against it instead
 * ({@link requestIdOfError}), and the server writes it onto the generic 500
 * and onto the error log line (#1064).
 */
export function requestId(options: RequestIdOptions = {}): Middleware {
  const resolvedOptions = options as Partial<RequestIdOptionsType>;
  const headerName = (resolvedOptions.headerName ?? DEFAULT_REQUEST_ID_HEADER).toLowerCase();
  const trustIncoming = resolvedOptions.trustIncoming ?? true;
  const generate = resolvedOptions.generate ?? randomUuid;

  return async (request, next) => {
    const incoming = trustIncoming ? requestIdOf(request, headerName) : undefined;
    const id = incoming ?? generate();
    const echoed = { [headerName]: id };
    try {
      const response = await next({ ...request, headers: { ...request.headers, [headerName]: id } });
      return applyHeaders(response, echoed);
    } catch (error) {
      if (!(error instanceof HttpError)) rememberRequestIdOfError(error, { headerName, id });
      throw applyHeadersToError(error, echoed);
    }
  };
}
