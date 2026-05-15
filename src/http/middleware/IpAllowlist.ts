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
 * (`req.remoteAddress`).  Operators behind a trusted reverse proxy
 * (Cloudflare, AWS ALB, NGINX) that strip + set
 * `x-forwarded-for` must pass a custom `getClientIp` that reads the
 * header — the default DOES NOT trust `x-forwarded-for` because that
 * header is client-spoofable when there's no proxy in front.
 */

import { HttpError, Status } from '../types.js';
import type { HttpRequest } from '../types.js';
import type { Middleware } from '../Route.js';

export interface IpAllowlistOptions {
  /**
   * One or more CIDR strings.  At least one must match the resolved
   * client IP or the request gets a 403.
   */
  readonly allow: ReadonlyArray<string>;
  /**
   * Override the IP-extraction step.  Default: `req.remoteAddress`.
   * Common override for deployments behind a trusted proxy:
   *
   *     getClientIp: (req) => req.headers['x-forwarded-for']?.split(',')[0]?.trim()
   *
   * Returning `null` / `undefined` makes the request fail closed
   * (403) — no IP means no decision means deny.
   */
  readonly getClientIp?: (req: HttpRequest) => string | null | undefined;
}

/** A single parsed CIDR — stored as a normalised bigint + prefix length. */
interface ParsedCidr {
  readonly ipv6: boolean;          // true if the CIDR is an IPv6 net
  readonly network: bigint;        // address with host-bits zeroed
  readonly prefixBits: number;     // number of significant prefix bits
  readonly totalBits: number;      // 32 for v4, 128 for v6
}

export function IpAllowlist(opts: IpAllowlistOptions): Middleware {
  if (opts.allow.length === 0) {
    throw new Error('IpAllowlist: `allow` must be a non-empty list of CIDRs');
  }
  const parsed = opts.allow.map(parseCidr);
  const getClientIp = opts.getClientIp ?? ((req) => req.remoteAddress);

  return async (req, next) => {
    const rawIp = getClientIp(req);
    if (!rawIp) {
      throw new HttpError(Status.Forbidden, 'IP not allowed (no client address)');
    }
    const matched = parsed.some((cidr) => ipMatches(rawIp, cidr));
    if (!matched) {
      throw new HttpError(Status.Forbidden, `IP not allowed: ${rawIp}`);
    }
    return next();
  };
}

/* ------------------------------- internals ------------------------------- */

/** Parse a `<address>/<prefix>` CIDR.  Throws on syntactically-invalid input. */
function parseCidr(cidr: string): ParsedCidr {
  const slash = cidr.lastIndexOf('/');
  if (slash < 0) {
    throw new Error(`IpAllowlist: missing prefix length in CIDR "${cidr}"`);
  }
  const addr = cidr.slice(0, slash);
  const prefixStr = cidr.slice(slash + 1);
  const prefixBits = Number(prefixStr);
  if (!Number.isInteger(prefixBits) || prefixBits < 0) {
    throw new Error(`IpAllowlist: invalid prefix length in CIDR "${cidr}"`);
  }
  const ipv6 = addr.includes(':');
  const totalBits = ipv6 ? 128 : 32;
  if (prefixBits > totalBits) {
    throw new Error(`IpAllowlist: prefix /${prefixBits} exceeds ${totalBits} bits in CIDR "${cidr}"`);
  }
  const fullMask = (BigInt(1) << BigInt(totalBits)) - BigInt(1);
  const hostMask = fullMask >> BigInt(prefixBits);
  const ipBn = ipToBigInt(addr, ipv6);
  const network = ipBn & ~hostMask & fullMask;
  return { ipv6, network, prefixBits, totalBits };
}

/** True if `ip` falls inside `cidr`.  Handles v4-in-v6 normalisation. */
function ipMatches(ip: string, cidr: ParsedCidr): boolean {
  // IPv4-mapped IPv6 (`::ffff:a.b.c.d`) — strip the prefix so a plain
  // IPv4 CIDR can match a dual-stack socket peer.
  const stripped = stripV4Mapped(ip);
  const requestIpv6 = stripped.includes(':');
  if (requestIpv6 !== cidr.ipv6) return false;
  let candidate: bigint;
  try {
    candidate = ipToBigInt(stripped, requestIpv6);
  } catch {
    return false;  // unparseable address can't match any CIDR
  }
  const fullMask = (BigInt(1) << BigInt(cidr.totalBits)) - BigInt(1);
  const hostMask = fullMask >> BigInt(cidr.prefixBits);
  return (candidate & ~hostMask & fullMask) === cidr.network;
}

function stripV4Mapped(ip: string): string {
  // `::ffff:1.2.3.4` (RFC 4291 v4-mapped) or `::1.2.3.4` (deprecated v4-compat).
  if (ip.toLowerCase().startsWith('::ffff:') && ip.includes('.')) {
    return ip.slice('::ffff:'.length);
  }
  if (ip.startsWith('::') && ip.length > 2 && ip.includes('.') && !ip.toLowerCase().includes('ffff')) {
    return ip.slice(2);
  }
  return ip;
}

function ipToBigInt(ip: string, isV6: boolean): bigint {
  if (!isV6) return ipv4ToBigInt(ip);
  return ipv6ToBigInt(ip);
}

function ipv4ToBigInt(ip: string): bigint {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`IpAllowlist: invalid IPv4 "${ip}"`);
  let n = BigInt(0);
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) {
      throw new Error(`IpAllowlist: invalid IPv4 octet in "${ip}"`);
    }
    n = (n << BigInt(8)) | BigInt(v);
  }
  return n;
}

function ipv6ToBigInt(ip: string): bigint {
  // Expand `::` to the full 8-group form.  Standard library doesn't
  // expose a parser; this implementation handles all RFC 5952 forms
  // we care about (with one `::` shorthand at most).
  const halves = ip.split('::');
  if (halves.length > 2) throw new Error(`IpAllowlist: invalid IPv6 (multiple "::") in "${ip}"`);
  const left = halves[0] === '' ? [] : halves[0]!.split(':');
  const right = halves[1] === undefined ? [] : (halves[1] === '' ? [] : halves[1]!.split(':'));
  // Fill the middle with zeros so total length is 8 groups.
  const missing = 8 - (left.length + right.length);
  if (missing < 0 && halves.length === 1) {
    // No `::` shorthand — must already be 8 groups.
  } else if (missing < 0) {
    throw new Error(`IpAllowlist: IPv6 "${ip}" has too many groups`);
  }
  const groups = halves.length === 1
    ? ip.split(':')
    : [...left, ...new Array(missing).fill('0'), ...right];
  if (groups.length !== 8) {
    throw new Error(`IpAllowlist: IPv6 "${ip}" did not expand to 8 groups (got ${groups.length})`);
  }
  let n = BigInt(0);
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
      throw new Error(`IpAllowlist: invalid IPv6 group "${g}" in "${ip}"`);
    }
    n = (n << BigInt(16)) | BigInt(parseInt(g, 16));
  }
  return n;
}
