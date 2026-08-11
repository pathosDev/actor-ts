/**
 * CIDR matching, and the address-pin rules built directly on top of it.
 *
 * The CIDR half is a **verbatim extraction** from
 * `http/middleware/IpAllowlist` (#312), moved here when the seed providers
 * needed the same primitive (#145).  Two copies of a hand-rolled IPv6
 * parser is how the two drift apart, and the one guarding cluster
 * bootstrap must behave exactly like the one already guarding HTTP
 * routes — so the error strings are parameterised by {@link errorSource}
 * rather than rewritten, and `IpAllowlist` still produces byte-identical
 * messages.
 *
 * The pin half lives here rather than under `discovery/` because it is
 * the same question one layer up — *"is this address one we agreed to
 * talk to?"* — and because both seed providers need identical rules.
 * A pin list mixes two entry shapes, discriminated by the `/`:
 *
 *   - `'10.0.0.0/8'`          — a CIDR; matches resolved **IP** addresses.
 *   - `'svc.cluster.local'`   — a host suffix; matches resolved **hostnames**
 *                               on a label boundary, so `evilsvc.cluster.local`
 *                               does not slip past `svc.cluster.local`.
 *
 * Which shape is useful depends on what the resolver hands back — see
 * `DnsSeedProviderOptions`, where SRV mode yields hostnames and A-record
 * mode yields IPs.
 *
 * **Addresses are canonical-only, on both sides of every comparison.**
 * An address that the socket layer would not call an IP must not be
 * called an IP here either — see {@link CANONICAL_IPV4_OCTET} for what
 * went wrong when it was.  Because the two callers share this file, the
 * rule holds for cluster bootstrap and for HTTP routes at once.
 */

import { match } from 'ts-pattern';

/**
 * A canonical dotted-quad octet: decimal, no leading zero, no sign, no
 * exponent, no radix prefix, no surrounding whitespace.
 *
 * `Number()` accepts every one of those — `Number('1e1')`,
 * `Number('010')` and `Number('0x0a')` are all `10` — so parsing an
 * octet with it put `1e1.0.0.1` inside `10.0.0.0/8`, while
 * `net.isIP('1e1.0.0.1')` is `0` and the transport therefore resolves
 * the very same string through **DNS**.  The check said "inside the
 * pinned network"; the socket went wherever the attacker's resolver
 * pointed.  Agreeing with the socket layer about what an IP *is* is the
 * entire point of the comparison, so the parser has to be at least as
 * strict as `net.isIP`.
 */
const CANONICAL_IPV4_OCTET = /^(?:0|[1-9][0-9]{0,2})$/;

/**
 * A prefix length is plain decimal for the same reason.  `Number('')` is
 * `0`, which turned a trailing-slash typo (`'10.0.0.0/'`) into `/0` — a
 * pin meant to admit one network admitting the whole address space.
 */
const DECIMAL_PREFIX_LENGTH = /^(?:0|[1-9][0-9]*)$/;

/** A single parsed CIDR — stored as a normalised bigint + prefix length. */
export type ParsedCidr = {
  readonly ipv6: boolean;          // true if the CIDR is an IPv6 net
  readonly network: bigint;        // address with host-bits zeroed
  readonly prefixBits: number;     // number of significant prefix bits
  readonly totalBits: number;      // 32 for v4, 128 for v6
};

/** A pin that admits IP addresses inside a network. */
type CidrPin = {
  readonly kind: 'cidr';
  readonly cidr: ParsedCidr;
};

/** A pin that admits hostnames at or below a DNS suffix. */
type HostSuffixPin = {
  readonly kind: 'hostSuffix';
  /** Normalised: lower-case, no leading or trailing dots. */
  readonly suffix: string;
};

/** One entry of a pin list, after parsing. */
export type AddressPin = CidrPin | HostSuffixPin;

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
  if (!DECIMAL_PREFIX_LENGTH.test(prefixText)) {
    throw new Error(`${errorSource}: invalid prefix length in CIDR "${cidr}"`);
  }
  const prefixBits = Number(prefixText);
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

/* ------------------------------ address pins ----------------------------- */

/**
 * True when `entry` is meant as a CIDR rather than a host suffix.  The
 * `/` is the discriminator, which is why a bare IP literal is rejected
 * outright by {@link addressPinRejection} instead of being read as a
 * (never-matching) suffix.
 */
export function isCidrEntry(entry: string): boolean {
  return entry.includes('/');
}

/**
 * Why `entry` cannot serve as an address pin, or `null` when it can.
 * Returns the *reason* clause only, so an `OptionsValidator` can pass it
 * straight to `fail(field, reason, value)`.
 */
export function addressPinRejection(entry: string): string | null {
  // Typed `string`, but a pin list can arrive from a plain object or
  // HOCON — the same reason `OptionsValidator`'s own helpers re-check
  // the runtime type instead of trusting the declaration.
  if (typeof entry !== 'string') return 'entries must be strings';
  const trimmed = entry.trim();
  if (trimmed.length === 0) return 'entries must be non-empty';
  if (isCidrEntry(trimmed)) {
    try {
      parseCidr(trimmed, 'pin');
    } catch {
      return 'entries with a "/" must be valid CIDRs';
    }
    return null;
  }
  // A bare address would silently become a host suffix that no IP can
  // ever match — the operator meant a /32 or /128 and would have got a
  // pin list that quietly discards everything.
  if (isIpLiteral(trimmed)) {
    return 'is a bare IP address — write it as a CIDR (e.g. "10.0.0.1/32")';
  }
  // Same rule as above, for a *fragment* of a quad.  `matchesSuffix` is
  // string arithmetic, so a pin like `0.1` matches the tail of any
  // address ending `.0.1` — and a candidate that is IP-shaped but not
  // canonical (`1e1.0.0.1`) is classified as a hostname, so it would
  // reach that comparison.  No real DNS zone is all digits, so rejecting
  // the shape costs nothing and removes the overlap entirely.
  if (trimmed.split('.').every((label) => /^[0-9]+$/.test(label))) {
    return 'looks like part of an IP address — write it as a CIDR (e.g. "10.0.0.0/8")';
  }
  if (trimmed.includes(':')) return 'host-suffix entries must not contain ":"';
  if (trimmed.replace(/\./g, '').length === 0) return 'host-suffix entries must name at least one label';
  return null;
}

/**
 * Parse one pin-list entry.  Throws (via {@link parseCidr}) on a
 * malformed CIDR; callers that validate options first — every caller in
 * this repo — cannot reach that path.
 */
export function parseAddressPin(entry: string, errorSource: string): AddressPin {
  const trimmed = entry.trim();
  if (isCidrEntry(trimmed)) {
    return { kind: 'cidr', cidr: parseCidr(trimmed, errorSource) };
  }
  return { kind: 'hostSuffix', suffix: normalizeHost(trimmed).replace(/^\.+/, '') };
}

/**
 * True when `host` is admitted by at least one pin.  An empty pin list
 * admits nothing — callers treat "no pins configured" as a separate case
 * and skip the check entirely rather than passing `[]`.
 *
 * A CIDR pin is only consulted for IP addresses and a host-suffix pin
 * only for hostnames, so a suffix can never accidentally match the tail
 * of a dotted quad.
 */
export function addressMatchesPins(host: string, pins: readonly AddressPin[]): boolean {
  const hostIsIp = isIpLiteral(host);
  const normalized = normalizeHost(host);
  return pins.some((pin) => match(pin)
    .with({ kind: 'cidr' }, (p) => hostIsIp && cidrMatches(host, p.cidr))
    .with({ kind: 'hostSuffix' }, (p) => !hostIsIp && matchesSuffix(normalized, p.suffix))
    .exhaustive());
}

/* ------------------------------- internals ------------------------------- */

/** Lower-case and drop the DNS root dot some resolvers include. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * Suffix match on a **label boundary**: `svc.cluster.local` admits
 * `pod-1.svc.cluster.local` and the apex itself, but not
 * `evilsvc.cluster.local`.
 */
function matchesSuffix(host: string, suffix: string): boolean {
  if (suffix.length === 0) return false;
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** True when `candidate` parses as a bare IPv4/IPv6 literal (no prefix). */
function isIpLiteral(candidate: string): boolean {
  if (isCidrEntry(candidate)) return false;
  const stripped = stripV4Mapped(candidate.trim());
  try {
    ipToBigInt(stripped, stripped.includes(':'), 'isIpLiteral');
    return true;
  } catch {
    return false;
  }
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

function ipToBigInt(ip: string, isIpv6: boolean, errorSource: string): bigint {
  if (!isIpv6) return ipv4ToBigInt(ip, errorSource);
  return ipv6ToBigInt(ip, errorSource);
}

function ipv4ToBigInt(ip: string, errorSource: string): bigint {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`${errorSource}: invalid IPv4 "${ip}"`);
  let value = BigInt(0);
  for (const part of parts) {
    if (!CANONICAL_IPV4_OCTET.test(part)) {
      throw new Error(`${errorSource}: invalid IPv4 octet in "${ip}"`);
    }
    const octet = Number(part);
    if (octet > 255) {
      throw new Error(`${errorSource}: invalid IPv4 octet in "${ip}"`);
    }
    value = (value << BigInt(8)) | BigInt(octet);
  }
  return value;
}

// The IPv6 parser below was audited for the same weakness and does not
// share it: every group goes through a `/^[0-9a-fA-F]{1,4}$/` test, so
// there is no `Number()` coercion to smuggle an alternative spelling
// through.  Left as it is rather than rewritten alongside the v4 half.
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
