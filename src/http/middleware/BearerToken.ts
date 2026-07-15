/**
 * Shared-secret bearer-token authentication middleware (#312).
 *
 * Use this to gate routes that need to be accessible only to operators
 * holding a pre-shared secret — typically the destructive management
 * endpoints (`/cluster/down`, `/cluster/leave`).  Comparison is
 * constant-time so an attacker probing tokens can't distinguish
 * "first character wrong" from "last character wrong" by timing.
 */

import { timingSafeEqual } from 'node:crypto';
import { HttpError, Status } from '../types.js';
import type { Middleware } from '../Route.js';

export interface BearerTokenAuthOptions {
  /**
   * Acceptable tokens — at least one must match the
   * `Authorization: Bearer <token>` header.  Multiple entries support
   * rotation: emit a new token, deploy clients with the new token,
   * then drop the old entry.
   */
  readonly tokens: ReadonlyArray<string>;
  /**
   * Header name to read the token from.  Default: `'authorization'`.
   * HTTP header names are lower-cased by the framework — pass them
   * lower-case here too.
   */
  readonly headerName?: string;
  /**
   * Realm advertised in `WWW-Authenticate` on 401.  Default: `'actor-ts'`.
   */
  readonly realm?: string;
}

/**
 * Build a `Middleware` that 401s every request unless the
 * `Authorization: Bearer <token>` header carries one of the configured
 * tokens.  Pass it to `withMiddleware(BearerTokenAuth({tokens: [...]}), route)`.
 *
 *     const protected = withMiddleware(
 *       BearerTokenAuth({ tokens: [process.env.MGMT_TOKEN!] }),
 *       path('cluster', concat(
 *         path('down', post(handleDown)),
 *         path('leave', post(handleLeave)),
 *       )),
 *     );
 */
export function BearerTokenAuth(opts: BearerTokenAuthOptions): Middleware {
  if (opts.tokens.length === 0) {
    throw new Error('BearerTokenAuth: tokens must be a non-empty list');
  }
  const headerName = (opts.headerName ?? 'authorization').toLowerCase();
  const realm = opts.realm ?? 'actor-ts';

  // Pre-encode tokens once for constant-time comparison.
  const expected: Uint8Array[] = opts.tokens.map((t) => new TextEncoder().encode(t));

  return async (req, next) => {
    const header = req.headers[headerName];
    if (!header) {
      throw new HttpError(Status.Unauthorized, 'missing Authorization header', undefined, {
        'www-authenticate': `Bearer realm="${realm}"`,
      });
    }
    // Header value must look like `Bearer <token>`.  Reject anything else
    // to avoid accidental matches against scheme-prefixed values.
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (!match) {
      throw new HttpError(Status.Unauthorized, 'authorization scheme must be Bearer', undefined, {
        'www-authenticate': `Bearer realm="${realm}"`,
      });
    }
    const presented = new TextEncoder().encode(match[1]!.trim());
    let matched = false;
    // We MUST iterate every expected token regardless of an early match
    // so the total comparison time is constant across the (legit-token,
    // wrong-token, no-token) outcomes.  `timingSafeEqual` itself is
    // constant-time only when buffers are the same length, so we
    // length-mismatch any mismatched-length comparison after a probe.
    for (const candidate of expected) {
      const equal = candidate.length === presented.length
        && timingSafeEqual(candidate, presented);
      // OR the result without short-circuiting.  `||=` on a boolean
      // doesn't short-circuit at the bytecode level here because both
      // operands are already evaluated above.
      if (equal) matched = true;
    }
    if (!matched) {
      throw new HttpError(Status.Unauthorized, 'invalid bearer token', undefined, {
        'www-authenticate': `Bearer realm="${realm}"`,
      });
    }
    return next();
  };
}
