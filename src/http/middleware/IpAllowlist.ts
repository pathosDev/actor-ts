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
 * (`request.remoteAddress`).  Behind a reverse proxy that peer is the
 * proxy, and the client's own address is somewhere in
 * `x-forwarded-for` — but not at a position the request can be trusted
 * to name, because Cloudflare, AWS ALB and NGINX all **append** to an
 * inbound header rather than replacing it.  Whatever the client sent
 * stays at the left of the chain; only the entries added from the right
 * were added by infrastructure.  Hence `trustedProxies`: name the
 * proxies, and {@link resolveClientIpBehindProxies} walks the chain
 * from the socket end inwards and takes the first address that is not
 * one of them.  See `IpAllowlistOptions` for why trust is expressed as
 * addresses and not as a hop count.
 *
 * The CIDR parsing and matching themselves moved to `util/CidrMatch`
 * when the cluster seed providers needed the same primitive (#145);
 * this module keeps the policy (which header, which hop, fail-closed,
 * 403) and borrows the arithmetic.
 */

import { parseCidr, cidrMatches, type ParsedCidr } from '../../util/CidrMatch.js';
import { HttpError, Status } from '../Types.js';
import type { HttpRequest } from '../Types.js';
import type { Middleware } from '../Route.js';
import { DEFAULT_FORWARDED_HEADER, IpAllowlistOptionsValidator } from './IpAllowlistOptions.js';
import type { IpAllowlistOptions, IpAllowlistOptionsType } from './IpAllowlistOptions.js';

/**
 * The client address according to the forwarded chain, given the CIDRs
 * that are known infrastructure.
 *
 * The chain is read in wire order — `[...forwardedEntries, socketPeer]`,
 * client first, this server's peer last — and walked from the **right**,
 * returning the first address outside `trustedProxies`.  Three properties
 * fall out of that direction, and all three are the point:
 *
 *   - A client that reaches the app **directly** is the peer, and the peer
 *     is untrusted, so the walk stops immediately and the header is never
 *     read.  A forged `x-forwarded-for` cannot decide anything.
 *   - Junk a client prepends sits to the *left* of its real address and is
 *     never reached, because the walk stops at the first untrusted entry.
 *   - An entry that does not parse as an address matches no CIDR, so it
 *     counts as untrusted and terminates the walk — and then fails the
 *     allowlist itself, since it matches no `allow` CIDR either.
 *
 * When every entry is trusted the chain names no client, and the fallback
 * is the socket peer rather than the leftmost entry.  `proxy-addr` returns
 * the leftmost there; that value is client-controlled (a caller behind the
 * proxy can prepend a proxy's own address to exhaust the walk), and for an
 * allowlist the address we know to be real is the safer answer.
 */
function resolveClientIpBehindProxies(
  request: HttpRequest,
  forwardedHeader: string,
  trustedProxies: ReadonlyArray<ParsedCidr>,
): string | undefined {
  const peer = request.remoteAddress;
  // No peer means nothing anchors the chain: every entry in the header
  // would have to be taken on the client's word.  Fail closed instead.
  if (!peer) return undefined;
  const forwarded = request.headers[forwardedHeader];
  const chain = forwarded
    ? [...forwarded.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0), peer]
    : [peer];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = chain[index];
    if (!trustedProxies.some((cidr) => cidrMatches(candidate, cidr))) return candidate;
  }
  return peer;
}

export function IpAllowlist(options: IpAllowlistOptions): Middleware {
  const settings = options as Partial<IpAllowlistOptionsType>;
  if (settings.allow === undefined || settings.allow.length === 0) {
    throw new Error('IpAllowlist: `allow` must be a non-empty list of CIDRs');
  }
  new IpAllowlistOptionsValidator().validate(settings);
  const parsed = settings.allow.map((cidr) => parseCidr(cidr, 'IpAllowlist'));
  const trustedProxies = settings.trustedProxies?.map((cidr) => parseCidr(cidr, 'IpAllowlist')) ?? [];
  const forwardedHeader = (settings.forwardedHeader ?? DEFAULT_FORWARDED_HEADER).toLowerCase();
  const getClientIp = settings.getClientIp
    ?? (trustedProxies.length > 0
      ? (request: HttpRequest) => resolveClientIpBehindProxies(request, forwardedHeader, trustedProxies)
      : (request: HttpRequest) => request.remoteAddress);

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
