/**
 * The non-canonical-IPv4 bypass (#145 follow-up).
 *
 * `ipv4ToBigInt` parsed each octet with `Number()`, and `Number()` speaks
 * far more than dotted-quad: `Number('1e1')`, `Number('010')` and
 * `Number('0x0a')` are all `10`.  So `1e1.0.0.1` landed inside
 * `10.0.0.0/8` — while `net.isIP('1e1.0.0.1')` is `0`, i.e. the transport
 * treats the very same string as a *hostname* and resolves it through DNS.
 * The check said "inside the pinned network"; the connection went wherever
 * the attacker's DNS pointed.
 *
 * The primitive guards two doors, so every spelling is nailed down at both
 * of them — the seed pin (`DnsSeedProvider`) and the HTTP allowlist
 * (`IpAllowlist`) — not just at the one the original report named.
 */

import { describe, expect, test } from 'bun:test';
import net from 'node:net';
import { DnsSeedProvider } from '../../../src/discovery/DnsSeedProvider.js';
import { DnsSeedProviderOptions } from '../../../src/discovery/DnsSeedProviderOptions.js';
import { IpAllowlist } from '../../../src/http/middleware/IpAllowlist.js';
import { HttpError, Status } from '../../../src/http/Types.js';
import type { HttpRequest } from '../../../src/http/Types.js';
import { addressMatchesPins, addressPinRejection, cidrMatches, parseAddressPin, parseCidr } from '../../../src/util/CidrMatch.js';

/**
 * The spellings `Number()` accepts and `net.isIP()` rejects.  Each one is
 * numerically `10.0.0.1` to the old parser and a DNS name to the socket.
 */
const SMUGGLED_SPELLINGS = [
  '1e1.0.0.1',      // exponent notation
  '010.0.0.1',      // leading zero
  '0x0a.0.0.1',     // hex, padded
  '0xa.0.0.1',      // hex, short
  '10.0.0.0x1',     // hex in the last octet
] as const;

/** Further `Number()` leniencies the same fix has to cover. */
const MORE_SMUGGLED_SPELLINGS = [
  ' 10.0.0.1',      // leading whitespace
  '10.0.0.1 ',      // trailing whitespace
  '10.0.0.1\n',     // trailing newline
  '+10.0.0.1',      // explicit sign
  '10.0.0.1e0',     // exponent on the last octet
  '10.0.0.0b1',     // binary literal
  '10.0.0.0o1',     // octal literal
  '10..0.1',        // empty octet reads as 0
] as const;

const ALL_SMUGGLED = [...SMUGGLED_SPELLINGS, ...MORE_SMUGGLED_SPELLINGS];

const httpRequest = (headers: Record<string, string>): HttpRequest => ({
  method: 'GET',
  path: '/',
  headers,
  query: {},
  params: {},
  body: null,
});

const okResponse = { status: Status.OK, body: 'ok' };
const next = async () => okResponse;

describe('CidrMatch — only canonical dotted quads are IPv4', () => {
  test('every smuggled spelling is a hostname to the transport, not an IP', () => {
    // The premise of the whole bypass: `net.connect({ host })` resolves
    // anything `net.isIP` scores 0 through DNS.  If that ever changed,
    // these spellings would stop being interesting.
    for (const spelling of ALL_SMUGGLED) {
      expect(net.isIP(spelling)).toBe(0);
    }
    expect(net.isIP('10.0.0.1')).toBe(4);
  });

  test('no smuggled spelling falls inside 10.0.0.0/8', () => {
    const cidr = parseCidr('10.0.0.0/8', 'test');
    for (const spelling of ALL_SMUGGLED) {
      expect([spelling, cidrMatches(spelling, cidr)]).toEqual([spelling, false]);
    }
  });

  test('the same smuggling wrapped in an IPv4-mapped IPv6 prefix is rejected too', () => {
    // `stripV4Mapped` hands the tail straight to the IPv4 parser, so
    // `::ffff:` is a second spelling of every bypass above.
    const cidr = parseCidr('10.0.0.0/8', 'test');
    for (const spelling of SMUGGLED_SPELLINGS) {
      expect([spelling, cidrMatches(`::ffff:${spelling}`, cidr)]).toEqual([spelling, false]);
    }
    expect(cidrMatches('::ffff:10.0.0.1', cidr)).toBe(true);
  });

  test('canonical addresses still match, including 0 and 255 octets', () => {
    const cidr = parseCidr('10.0.0.0/8', 'test');
    expect(cidrMatches('10.0.0.1', cidr)).toBe(true);
    expect(cidrMatches('10.0.0.0', cidr)).toBe(true);
    expect(cidrMatches('10.255.255.255', cidr)).toBe(true);
    expect(cidrMatches('9.255.255.255', cidr)).toBe(false);
  });

  test('a smuggled spelling in the CIDR itself is rejected at parse time', () => {
    // The pin list is operator-supplied, but it can come from HOCON or a
    // plain object, and a `/8` written `1e1.0.0.0/8` would silently pin a
    // different network than it reads as.
    expect(() => parseCidr('1e1.0.0.0/8', 'test')).toThrow(/invalid IPv4 octet/);
    expect(() => parseCidr('010.0.0.0/8', 'test')).toThrow(/invalid IPv4 octet/);
    expect(() => parseCidr('0x0a.0.0.0/8', 'test')).toThrow(/invalid IPv4 octet/);
    expect(addressPinRejection('1e1.0.0.0/8')).toMatch(/valid CIDRs/);
  });

  test('the prefix length is decimal-only — an empty one no longer means /0', () => {
    // `Number('')` is 0, so `10.0.0.0/` parsed as `/0`: a pin meant to
    // admit one network admitted the entire address space instead.
    expect(() => parseCidr('10.0.0.0/', 'test')).toThrow(/invalid prefix length/);
    expect(() => parseCidr('10.0.0.0/0x8', 'test')).toThrow(/invalid prefix length/);
    expect(() => parseCidr('10.0.0.0/8e0', 'test')).toThrow(/invalid prefix length/);
    expect(() => parseCidr('10.0.0.0/ 8', 'test')).toThrow(/invalid prefix length/);
    expect(() => parseCidr('10.0.0.0/+8', 'test')).toThrow(/invalid prefix length/);
    // `010` read as decimal 10, not octal 8 — either way not what was written.
    expect(() => parseCidr('10.0.0.0/010', 'test')).toThrow(/invalid prefix length/);
    expect(parseCidr('10.0.0.0/8', 'test').prefixBits).toBe(8);
    expect(parseCidr('0.0.0.0/0', 'test').prefixBits).toBe(0);
  });

  test('an IPv6 group stays hex-only', () => {
    // `ipv6ToBigInt` already used a strict regex — asserted here so the
    // v4 tightening cannot be read as making v6 the lenient half.
    const cidr = parseCidr('2001:db8::/32', 'test');
    expect(cidrMatches('2001:0db8::1', cidr)).toBe(true);
    expect(cidrMatches('2001:db8::1', cidr)).toBe(true);
    expect(cidrMatches('2001:db8g::1', cidr)).toBe(false);
    expect(cidrMatches(' 2001:db8::1', cidr)).toBe(false);
    expect(cidrMatches('2001:0x0db8::1', cidr)).toBe(false);
  });
});

describe('caller 1: seed pinning — a smuggled address is not a pinned seed', () => {
  // The list the docs bless verbatim: "mixing both shapes in one list is
  // fine".  Without the CIDR entry `attacker.example.com` was already
  // dropped; the CIDR entry must not hand that back.
  const pins = ['10.0.0.0/8', 'svc.cluster.local'].map((entry) => parseAddressPin(entry, 'test'));

  test('addressMatchesPins admits no smuggled spelling', () => {
    for (const spelling of ALL_SMUGGLED) {
      expect([spelling, addressMatchesPins(spelling, pins)]).toEqual([spelling, false]);
    }
  });

  test('the mixed list still admits what it is meant to admit', () => {
    expect(addressMatchesPins('10.0.0.1', pins)).toBe(true);
    expect(addressMatchesPins('pod-1.svc.cluster.local', pins)).toBe(true);
    expect(addressMatchesPins('attacker.example.com', pins)).toBe(false);
  });

  test('a smuggled spelling cannot come back in through the suffix path', () => {
    // Making the octets canonical reclassifies `1e1.0.0.1` from IP to
    // hostname, which puts it in front of the *suffix* pins — and
    // `matchesSuffix` is plain string arithmetic, so a numeric tail like
    // `0.1` would have admitted it.  Such an entry is now rejected as a
    // pin, which is what keeps the reclassification from trading one
    // hole for a smaller one.
    expect(addressPinRejection('0.1')).toMatch(/part of an IP address/);
    // A whitespace-padded quad stays classified as an IP, so it is
    // checked against CIDRs (and fails) rather than against suffixes.
    const numericTail = [parseAddressPin('0.1', 'test')];
    expect(addressMatchesPins(' 10.0.0.1', numericTail)).toBe(false);
    expect(addressMatchesPins('10.0.0.1 ', numericTail)).toBe(false);
  });

  test('DnsSeedProvider drops a poisoned A-record answer end to end', async () => {
    const dropped: string[] = [];
    const dnsOptions = DnsSeedProviderOptions.create()
      .withHostname('actor-ts.example.com')
      .withSystemName('sys')
      .withPort(2552)
      .withCacheTtlMs(0)
      .withPinnedAddresses(['10.0.0.0/8', 'svc.cluster.local'])
      .withLog((message) => { dropped.push(message); })
      .withResolve(async () => ['10.0.0.1', ...ALL_SMUGGLED]);
    const provider = new DnsSeedProvider(dnsOptions);

    const seeds = await provider.lookup();
    expect(seeds.map((seed) => seed.host)).toEqual(['10.0.0.1']);
    expect(dropped).toHaveLength(ALL_SMUGGLED.length);
  });
});

describe('caller 2: HTTP IP allowlist — a smuggled X-Forwarded-For is not allowed', () => {
  // The configuration `IpAllowlist`'s own JSDoc and the docs page print for
  // deployments behind a trusted proxy: the proxy is named by address, and
  // the client is resolved from the chain's socket end inwards (#715).  The
  // spellings below have to die at the *matching* step, which is this
  // file's subject — they are in the chain the trusted proxy appended to,
  // so nothing upstream has already thrown them away.
  const allowlist = IpAllowlist({
    allow: ['10.0.0.0/8'],
    trustedProxies: ['203.0.113.0/24'],
  });
  const behindProxy = (headers: Record<string, string>): HttpRequest =>
    ({ ...httpRequest(headers), remoteAddress: '203.0.113.7' });

  test('every smuggled spelling gets a 403', async () => {
    for (const spelling of SMUGGLED_SPELLINGS) {
      await expect(allowlist(behindProxy({ 'x-forwarded-for': spelling }), next)).rejects.toThrow(HttpError);
    }
  });

  test('a canonical in-range address still passes', async () => {
    expect(await allowlist(behindProxy({ 'x-forwarded-for': '10.1.2.3' }), next)).toBe(okResponse);
    await expect(allowlist(behindProxy({ 'x-forwarded-for': '192.168.1.1' }), next)).rejects.toThrow(HttpError);
  });

  test('a header alone decides nothing — no socket peer, no client address', async () => {
    // The inversion of the case above, and the reason it is worth its own
    // test: before #715 this file asserted that a bare `x-forwarded-for:
    // 10.1.2.3` with no peer at all *passed*.  A canonical spelling was
    // never the hole; believing an unanchored chain was.
    await expect(allowlist(httpRequest({ 'x-forwarded-for': '10.1.2.3' }), next))
      .rejects.toThrow(/no client address/);
  });

  test('a socket peer is checked the same way', async () => {
    const socketAllowlist = IpAllowlist({ allow: ['10.0.0.0/8'] });
    const peer = (remoteAddress: string): HttpRequest => ({ ...httpRequest({}), remoteAddress });
    expect(await socketAllowlist(peer('10.1.2.3'), next)).toBe(okResponse);
    for (const spelling of SMUGGLED_SPELLINGS) {
      await expect(socketAllowlist(peer(spelling), next)).rejects.toThrow(HttpError);
    }
  });

  test('an allow entry with an empty prefix is rejected instead of allowing everything', () => {
    expect(() => IpAllowlist({ allow: ['10.0.0.0/'] })).toThrow(/invalid prefix length/);
  });
});
