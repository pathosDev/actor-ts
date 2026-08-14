/**
 * CIDR-based IP allowlist middleware (#312).
 *
 * Restricts a route subtree to clients whose IP falls inside one of
 * the configured CIDRs.  Defence-in-depth on top of bearer-token auth
 * (`BearerTokenAuth`): even if a token leaks, the attacker also needs
 * to be on an allowlisted network to use it.
 *
 * Supports both IPv4 and IPv6 CIDRs in standard notation:
 *   - `'10.0.0.0/8'` — RFC 1918 private space
 *   - `'127.0.0.1/32'` — single host
 *   - `'::1/128'` — IPv6 loopback
 *   - `'fd00::/8'` — IPv6 ULA range
 *
 * IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are normalised so an
 * IPv4 CIDR matches a request coming over a dual-stack socket.
 *
 * **Source of truth for the client IP** is the underlying socket
 * (`request.remoteAddress`).  Operators behind a trusted reverse proxy
 * (Cloudflare, AWS ALB, NGINX) that strip + set
 * `x-forwarded-for` must pass a custom `getClientIp` that reads the
 * header — the default DOES NOT trust `x-forwarded-for` because that
 * header is client-spoofable when there's no proxy in front.
 *
 * The CIDR parsing and matching themselves moved to `util/CidrMatch`
 * when the cluster seed providers needed the same primitive (#145);
 * this module keeps the policy (which header, fail-closed, 403) and
 * borrows the arithmetic.
 */

import { parseCidr, cidrMatches } from '../../util/CidrMatch.js';
import { HttpError, Status } from '../Types.js';
import type { HttpRequest } from '../Types.js';
import type { Middleware } from '../Route.js';

export type IpAllowlistOptions = {
  /**
   * One or more CIDR strings.  At least one must match the resolved
   * client IP or the request gets a 403.
   */
  readonly allow: ReadonlyArray<string>;
  /**
   * Override the IP-extraction step.  Default: `request.remoteAddress`.
   * Common override for deployments behind a trusted proxy:
   *
   *     getClientIp: (request) => request.headers['x-forwarded-for']?.split(',')[0]?.trim()
   *
   * Returning `null` / `undefined` makes the request fail closed
   * (403) — no IP means no decision means deny.
   */
  readonly getClientIp?: (request: HttpRequest) => string | null | undefined;
};

export function IpAllowlist(options: IpAllowlistOptions): Middleware {
  if (options.allow.length === 0) {
    throw new Error('IpAllowlist: `allow` must be a non-empty list of CIDRs');
  }
  const parsed = options.allow.map((cidr) => parseCidr(cidr, 'IpAllowlist'));
  const getClientIp = options.getClientIp ?? ((request) => request.remoteAddress);

  return async (request, next) => {
    const rawIp = getClientIp(request);
    if (!rawIp) {
      throw new HttpError(Status.Forbidden, 'IP not allowed (no client address)');
    }
    const matched = parsed.some((cidr) => cidrMatches(rawIp, cidr));
    if (!matched) {
      throw new HttpError(Status.Forbidden, `IP not allowed: ${rawIp}`);
    }
    return next();
  };
}
