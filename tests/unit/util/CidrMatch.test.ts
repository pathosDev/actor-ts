import { describe, expect, test } from 'bun:test';
import {
  addressMatchesPins,
  addressPinRejection,
  cidrMatches,
  isCidrEntry,
  parseAddressPin,
  parseCidr,
} from '../../../src/util/CidrMatch.js';

const pins = (...entries: string[]) => entries.map((entry) => parseAddressPin(entry, 'test'));

describe('CidrMatch — parseCidr / cidrMatches', () => {
  test('matches inside an IPv4 network and rejects outside it', () => {
    const cidr = parseCidr('10.0.0.0/8', 'test');
    expect(cidrMatches('10.5.6.7', cidr)).toBe(true);
    expect(cidrMatches('11.0.0.1', cidr)).toBe(false);
  });

  test('/32 is a single host', () => {
    const cidr = parseCidr('127.0.0.1/32', 'test');
    expect(cidrMatches('127.0.0.1', cidr)).toBe(true);
    expect(cidrMatches('127.0.0.2', cidr)).toBe(false);
  });

  test('matches an IPv6 prefix', () => {
    const cidr = parseCidr('2001:db8::/32', 'test');
    expect(cidrMatches('2001:db8:1::1', cidr)).toBe(true);
    expect(cidrMatches('2001:db9::1', cidr)).toBe(false);
  });

  test('normalises IPv4-mapped IPv6 against an IPv4 CIDR', () => {
    const cidr = parseCidr('10.0.0.0/8', 'test');
    expect(cidrMatches('::ffff:10.5.6.7', cidr)).toBe(true);
    expect(cidrMatches('::ffff:192.168.1.5', cidr)).toBe(false);
  });

  test('an address family mismatch never matches', () => {
    expect(cidrMatches('2001:db8::1', parseCidr('10.0.0.0/8', 'test'))).toBe(false);
    expect(cidrMatches('10.0.0.1', parseCidr('2001:db8::/32', 'test'))).toBe(false);
  });

  test('an unparseable address matches nothing rather than throwing', () => {
    expect(cidrMatches('not.an.ip', parseCidr('10.0.0.0/8', 'test'))).toBe(false);
  });

  test('the error source names the caller in every parse failure', () => {
    expect(() => parseCidr('10.0.0.0', 'DnsSeedProviderOptions'))
      .toThrow(/^DnsSeedProviderOptions: missing prefix length/);
    expect(() => parseCidr('10.0.0.0/33', 'IpAllowlist')).toThrow(/^IpAllowlist: prefix \/33 exceeds 32 bits/);
    expect(() => parseCidr('::1/200', 'IpAllowlist')).toThrow(/128 bits/);
    expect(() => parseCidr('999.0.0.1/8', 'IpAllowlist')).toThrow(/invalid IPv4 octet/);
  });
});

describe('CidrMatch — pin-entry classification', () => {
  test('the "/" is what makes an entry a CIDR', () => {
    expect(isCidrEntry('10.0.0.0/8')).toBe(true);
    expect(isCidrEntry('svc.cluster.local')).toBe(false);
  });

  test('accepts well-formed CIDRs and host suffixes', () => {
    expect(addressPinRejection('10.0.0.0/8')).toBeNull();
    expect(addressPinRejection('2001:db8::/32')).toBeNull();
    expect(addressPinRejection('svc.cluster.local')).toBeNull();
    expect(addressPinRejection('.svc.cluster.local')).toBeNull();
  });

  test('a bare IP is rejected rather than read as a suffix', () => {
    // Silently demoting `10.0.0.1` to a host suffix would produce a pin
    // that no resolved IP can ever match — the pin list would discard
    // everything and look like an empty DNS answer.
    expect(addressPinRejection('10.0.0.1')).toMatch(/bare IP address/);
    expect(addressPinRejection('2001:db8::1')).toMatch(/bare IP address/);
  });

  test('rejects malformed CIDRs, empty entries and dot-only suffixes', () => {
    expect(addressPinRejection('10.0.0.0/33')).toMatch(/valid CIDRs/);
    expect(addressPinRejection('nonsense/8')).toMatch(/valid CIDRs/);
    expect(addressPinRejection('   ')).toMatch(/non-empty/);
    expect(addressPinRejection('.')).toMatch(/at least one label/);
    expect(addressPinRejection('..')).toMatch(/at least one label/);
    expect(addressPinRejection('host:2552')).toMatch(/must not contain ":"/);
  });

  test('a non-string entry from a plain object or HOCON is rejected', () => {
    expect(addressPinRejection(42 as unknown as string)).toMatch(/must be strings/);
    expect(addressPinRejection(null as unknown as string)).toMatch(/must be strings/);
  });

  test('a dot-only entry is rejected either way', () => {
    // `...` reaches the bare-IP branch, not the label branch: the IPv4
    // parser inherited from `IpAllowlist` reads an empty octet as 0, so
    // it sees `0.0.0.0`.  The entry is rejected regardless — only the
    // wording differs — so the leniency is left alone here rather than
    // changed inside a pure extraction.
    expect(addressPinRejection('...')).not.toBeNull();
  });
});

describe('CidrMatch — addressMatchesPins', () => {
  test('a CIDR pin admits an IP in range', () => {
    expect(addressMatchesPins('10.1.2.3', pins('10.0.0.0/8'))).toBe(true);
    expect(addressMatchesPins('203.0.113.5', pins('10.0.0.0/8'))).toBe(false);
  });

  test('a host suffix matches on a label boundary only', () => {
    const pinned = pins('svc.cluster.local');
    expect(addressMatchesPins('pod-1.svc.cluster.local', pinned)).toBe(true);
    expect(addressMatchesPins('svc.cluster.local', pinned)).toBe(true);
    // The classic near-miss: a shared tail is not a shared suffix.
    expect(addressMatchesPins('evilsvc.cluster.local', pinned)).toBe(false);
    expect(addressMatchesPins('svc.cluster.local.attacker.example', pinned)).toBe(false);
  });

  test('suffix matching ignores case and the DNS root dot', () => {
    expect(addressMatchesPins('POD-1.SVC.Cluster.Local.', pins('svc.cluster.local'))).toBe(true);
    expect(addressMatchesPins('pod-1.svc.cluster.local', pins('.svc.cluster.local'))).toBe(true);
  });

  test('a CIDR pin never admits a hostname, a suffix pin never admits an IP', () => {
    expect(addressMatchesPins('pod-1.svc.cluster.local', pins('10.0.0.0/8'))).toBe(false);
    // `10.0.0.1`.endsWith('.0.1') is true as plain string arithmetic —
    // classifying the address first is what keeps that out.
    expect(addressMatchesPins('10.0.0.1', pins('0.1'))).toBe(false);
  });

  test('any one pin suffices, and an empty list admits nothing', () => {
    expect(addressMatchesPins('10.0.0.1', pins('192.168.0.0/16', '10.0.0.0/8'))).toBe(true);
    expect(addressMatchesPins('10.0.0.1', [])).toBe(false);
  });

  test('mixed lists serve both modes from one config', () => {
    const pinned = pins('10.0.0.0/8', 'svc.cluster.local');
    expect(addressMatchesPins('10.0.0.1', pinned)).toBe(true);
    expect(addressMatchesPins('pod-1.svc.cluster.local', pinned)).toBe(true);
    expect(addressMatchesPins('203.0.113.5', pinned)).toBe(false);
  });
});
