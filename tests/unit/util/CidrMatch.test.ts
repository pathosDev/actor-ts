import { describe, expect, test } from 'bun:test';
import { cidrMatches, parseCidr } from '../../../src/util/CidrMatch.js';

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
