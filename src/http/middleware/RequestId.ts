/**
 * Request-id middleware.  Adds a stable id to the request (so handlers and
 * downstream calls can correlate) and echoes it on the response.  An
 * incoming id is accepted only if it is well-formed — never echo raw
 * client bytes back into a header.
 */
import { randomUUID } from 'node:crypto';
import type { Middleware } from '../Route.js';
import { applyHeaders } from './headers.js';
import type { RequestIdOptions, RequestIdOptionsType } from './RequestIdOptions.js';

/** Conservative id shape — enough for UUIDs, ULIDs, and trace ids; caps length. */
const VALID_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Build a middleware that assigns/propagates a request id. */
export function requestId(options: RequestIdOptions = {}): Middleware {
  const resolvedOptions = options as Partial<RequestIdOptionsType>;
  const headerName = (resolvedOptions.headerName ?? 'x-request-id').toLowerCase();
  const trustIncoming = resolvedOptions.trustIncoming ?? true;
  const generate = resolvedOptions.generate ?? ((): string => randomUUID());

  return async (request, next) => {
    const incoming = trustIncoming ? request.headers[headerName] : undefined;
    const id = incoming && VALID_ID.test(incoming) ? incoming : generate();
    const response = await next({ ...request, headers: { ...request.headers, [headerName]: id } });
    return applyHeaders(response, { [headerName]: id });
  };
}
