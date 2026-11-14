/**
 * The client's address behind trusted reverse proxies (#1236).
 *
 * `HttpRequest.remoteAddress` is the **socket peer** on every backend, and
 * behind a proxy the peer is the proxy.  The client's own address is in the
 * forwarding header — but not at a position the request can be trusted to
 * name, because NGINX, AWS ALB and Cloudflare all **append** to an inbound
 * header rather than replacing it (#715).  Whatever the client sent stays at
 * the left of the chain; only entries added from the right were added by
 * infrastructure.
 *
 * This module is the one place that rule lives.  `IpAllowlist` resolves its
 * client through it, and so should anything else that needs a real client
 * address — a `rateLimit` key above all, where keying on the socket peer puts
 * every client behind the proxy into one bucket and keying on the raw header
 * hands each request a fresh bucket of its own choosing:
 *
 * ```ts
 * const clientIp = clientIpResolver(['10.0.0.0/8']);
 * const limited = rateLimit({
 *   cache, windowMs: 60_000, max: 100,
 *   key: (request) => clientIp(request) ?? '<unresolved>',
 * });
 * ```
 *
 * See `IpAllowlistOptions` for why trust is expressed as proxy addresses and
 * not as a hop count.
 */

import { cidrMatches, parseCidr, type ParsedCidr } from '../../util/CidrMatch.js';
import type { HttpRequest } from '../Types.js';
import { DEFAULT_FORWARDED_HEADER } from './IpAllowlistOptions.js';

/** Resolves a request to its client address, or `undefined` when none can be trusted. */
export type ClientIpResolver = (request: HttpRequest) => string | undefined;

/**
 * Build a resolver for the client address behind `trustedProxies`.
 *
 * The CIDRs are parsed once, here, so an invalid entry throws when the
 * resolver is built rather than on the first request that reaches it.
 *
 * - **No proxies** (unset or empty): the resolver answers the socket peer and
 *   never reads `forwardedHeader` — a header nobody vouches for decides
 *   nothing.
 * - **Proxies named**: the walk described on
 *   {@link resolveClientIpBehindProxies}.
 *
 * `undefined` means the request has no socket peer, so nothing anchors the
 * chain.  What to do then is the caller's decision: `IpAllowlist` answers 403;
 * a rate-limit key typically folds every such request into one shared bucket,
 * which limits them together rather than letting them through unlimited.
 *
 * @param trustedProxies CIDRs of the reverse proxies in front of this app.
 *   Never `0.0.0.0/0`: trusting everything exhausts the walk on every
 *   request and degrades it to the socket peer.
 * @param forwardedHeader Header carrying the chain, matched
 *   case-insensitively.  Default `'x-forwarded-for'`; a vendor header such as
 *   `cf-connecting-ip` is the more robust choice where the vendor sets it.
 */
export function clientIpResolver(
  trustedProxies: ReadonlyArray<string> = [],
  forwardedHeader: string = DEFAULT_FORWARDED_HEADER,
): ClientIpResolver {
  const parsed = trustedProxies.map((cidr) => parseCidr(cidr, 'clientIpResolver'));
  if (parsed.length === 0) return (request) => request.remoteAddress;
  const header = forwardedHeader.toLowerCase();
  return (request) => resolveClientIpBehindProxies(request, header, parsed);
}

/**
 * One-shot form of {@link clientIpResolver}: parses `trustedProxies` on every
 * call.  Fine for an occasional lookup (an audit log line); on a per-request
 * path, build the resolver once and keep it.
 */
export function resolveClientIp(
  request: HttpRequest,
  trustedProxies: ReadonlyArray<string>,
  forwardedHeader: string = DEFAULT_FORWARDED_HEADER,
): string | undefined {
  return clientIpResolver(trustedProxies, forwardedHeader)(request);
}

/**
 * The client address according to the forwarded chain, given the CIDRs
 * that are known infrastructure.  `forwardedHeader` must already be
 * lower-case, the way `request.headers` holds names.
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
 *     counts as untrusted and terminates the walk — and then fails an
 *     allowlist itself, since it matches no `allow` CIDR either.
 *
 * When every entry is trusted the chain names no client, and the fallback
 * is the socket peer rather than the leftmost entry.  `proxy-addr` returns
 * the leftmost there; that value is client-controlled (a caller behind the
 * proxy can prepend a proxy's own address to exhaust the walk), and the
 * address we know to be real is the safer answer.
 *
 * Exported for `IpAllowlist`, which parses its CIDRs under its own name;
 * not re-exported from the barrel — {@link clientIpResolver} is the public
 * form.
 */
export function resolveClientIpBehindProxies(
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
