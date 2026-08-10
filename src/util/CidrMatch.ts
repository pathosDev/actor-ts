/**
 * CIDR parsing and matching for IPv4 and IPv6.
 *
 * A **verbatim extraction** from `http/middleware/IpAllowlist` (#312),
 * moved here so more than one subsystem can reach it.  Two copies of a
 * hand-rolled IPv6 parser is how the two drift apart, so nothing about
 * the arithmetic changed in the move: the error strings are
 * parameterised by {@link errorSource} rather than rewritten, and
 * `IpAllowlist` still produces byte-identical messages.
 *
 * Handles standard notation for both families — `'10.0.0.0/8'`,
 * `'127.0.0.1/32'`, `'::1/128'`, `'fd00::/8'` — and normalises
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`) so an IPv4 CIDR matches a
 * dual-stack peer.
 */

/** A single parsed CIDR — stored as a normalised bigint + prefix length. */
export type ParsedCidr = {
  readonly ipv6: boolean;          // true if the CIDR is an IPv6 net
  readonly network: bigint;        // address with host-bits zeroed
  readonly prefixBits: number;     // number of significant prefix bits
  readonly totalBits: number;      // 32 for v4, 128 for v6
};

/**
 * Parse a `<address>/<prefix>` CIDR.  Throws on syntactically-invalid
 * input, prefixing every message with `errorSource` so the thrower is
 * named in the error the operator sees.
 */
export function parseCidr(cidr: string, errorSource: string): ParsedCidr {
  const slash = cidr.lastIndexOf('/');
  if (slash < 0) {
    throw new Error(`${errorSource}: missing prefix length in CIDR "${cidr}"`);
  }
  const address = cidr.slice(0, slash);
  const prefixText = cidr.slice(slash + 1);
  const prefixBits = Number(prefixText);
  if (!Number.isInteger(prefixBits) || prefixBits < 0) {
    throw new Error(`${errorSource}: invalid prefix length in CIDR "${cidr}"`);
  }
  const ipv6 = address.includes(':');
  const totalBits = ipv6 ? 128 : 32;
  if (prefixBits > totalBits) {
    throw new Error(`${errorSource}: prefix /${prefixBits} exceeds ${totalBits} bits in CIDR "${cidr}"`);
  }
  const fullMask = (BigInt(1) << BigInt(totalBits)) - BigInt(1);
  const hostMask = fullMask >> BigInt(prefixBits);
  const addressValue = ipToBigInt(address, ipv6, errorSource);
  const network = addressValue & ~hostMask & fullMask;
  return { ipv6, network, prefixBits, totalBits };
}

/** True if `ip` falls inside `cidr`.  Handles v4-in-v6 normalisation. */
export function cidrMatches(ip: string, cidr: ParsedCidr): boolean {
  // IPv4-mapped IPv6 (`::ffff:a.b.c.d`) — strip the prefix so a plain
  // IPv4 CIDR can match a dual-stack socket peer.
  const stripped = stripV4Mapped(ip);
  const candidateIpv6 = stripped.includes(':');
  if (candidateIpv6 !== cidr.ipv6) return false;
  let candidate: bigint;
  try {
    candidate = ipToBigInt(stripped, candidateIpv6, 'cidrMatches');
  } catch {
    return false;  // unparseable address can't match any CIDR
  }
  const fullMask = (BigInt(1) << BigInt(cidr.totalBits)) - BigInt(1);
  const hostMask = fullMask >> BigInt(cidr.prefixBits);
  return (candidate & ~hostMask & fullMask) === cidr.network;
}

/* ------------------------------- internals ------------------------------- */

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

function ipToBigInt(ip: string, isIpv6: boolean, errorSource: string): bigint {
  if (!isIpv6) return ipv4ToBigInt(ip, errorSource);
  return ipv6ToBigInt(ip, errorSource);
}

function ipv4ToBigInt(ip: string, errorSource: string): bigint {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`${errorSource}: invalid IPv4 "${ip}"`);
  let value = BigInt(0);
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`${errorSource}: invalid IPv4 octet in "${ip}"`);
    }
    value = (value << BigInt(8)) | BigInt(octet);
  }
  return value;
}

function ipv6ToBigInt(ip: string, errorSource: string): bigint {
  // Expand `::` to the full 8-group form.  Standard library doesn't
  // expose a parser; this implementation handles all RFC 5952 forms
  // we care about (with one `::` shorthand at most).
  const halves = ip.split('::');
  if (halves.length > 2) throw new Error(`${errorSource}: invalid IPv6 (multiple "::") in "${ip}"`);
  const left = halves[0] === '' ? [] : halves[0]!.split(':');
  const right = halves[1] === undefined ? [] : (halves[1] === '' ? [] : halves[1]!.split(':'));
  // Fill the middle with zeros so total length is 8 groups.
  const missing = 8 - (left.length + right.length);
  if (missing < 0 && halves.length === 1) {
    // No `::` shorthand — must already be 8 groups.
  } else if (missing < 0) {
    throw new Error(`${errorSource}: IPv6 "${ip}" has too many groups`);
  }
  const groups = halves.length === 1
    ? ip.split(':')
    : [...left, ...new Array(missing).fill('0'), ...right];
  if (groups.length !== 8) {
    throw new Error(`${errorSource}: IPv6 "${ip}" did not expand to 8 groups (got ${groups.length})`);
  }
  let value = BigInt(0);
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
      throw new Error(`${errorSource}: invalid IPv6 group "${group}" in "${ip}"`);
    }
    value = (value << BigInt(16)) | BigInt(parseInt(group, 16));
  }
  return value;
}
