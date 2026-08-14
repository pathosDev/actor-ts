/**
 * Request-id middleware.  Adds a stable id to the request (so handlers and
 * downstream calls can correlate) and echoes it on the response.  An
 * incoming id is accepted only if it is well-formed — never echo raw
 * client bytes back into a header.
 */
import type { Middleware } from '../Route.js';
import type { HttpRequest } from '../Types.js';
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

/**
 * Build a middleware that assigns/propagates a request id.
 *
 * The id is echoed on the response the inner stack returns *and* on the one
 * a thrown `HttpError` short-circuit produces — a rejection is exactly the
 * response whose id the operator later needs to find the log line (#606).
 * A non-`HttpError` throw maps to the generic 500, which carries nothing
 * from the thrown value, so that one still arrives without an id.
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
      throw applyHeadersToError(error, echoed);
    }
  };
}
