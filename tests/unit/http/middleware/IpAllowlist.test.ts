import { describe, expect, test } from 'bun:test';
import { IpAllowlist } from '../../../../src/http/middleware/IpAllowlist.js';
import { HttpError, Status, type HttpRequest } from '../../../../src/http/types.js';

const request = (remoteAddress?: string, headers: Record<string, string> = {}): HttpRequest => ({
  method: 'GET',
  path: '/',
  headers,
  query: {},
  params: {},
  body: null,
  ...(remoteAddress !== undefined ? { remoteAddress } : {}),
});

const okResponse = { status: Status.OK, body: 'ok' };
const next = async () => okResponse;

describe('IpAllowlist — IPv4', () => {
  test('allows an IP inside the CIDR', async () => {
    const mw = IpAllowlist({ allow: ['10.0.0.0/8'] });
    expect(await mw(request('10.5.6.7'), next)).toBe(okResponse);
  });

  test('rejects an IP outside the CIDR', async () => {
    const mw = IpAllowlist({ allow: ['10.0.0.0/8'] });
    await expect(mw(request('192.168.1.5'), next)).rejects.toThrow(HttpError);
  });

  test('matches the exact host with /32', async () => {
    const mw = IpAllowlist({ allow: ['127.0.0.1/32'] });
    expect(await mw(request('127.0.0.1'), next)).toBe(okResponse);
    await expect(mw(request('127.0.0.2'), next)).rejects.toThrow(HttpError);
  });

  test('handles a /16 prefix correctly', async () => {
    const mw = IpAllowlist({ allow: ['172.16.0.0/16'] });
    expect(await mw(request('172.16.0.1'), next)).toBe(okResponse);
    expect(await mw(request('172.16.255.254'), next)).toBe(okResponse);
    await expect(mw(request('172.17.0.1'), next)).rejects.toThrow(HttpError);
  });

  test('considers multiple CIDRs (OR)', async () => {
    const mw = IpAllowlist({ allow: ['10.0.0.0/8', '127.0.0.1/32'] });
    expect(await mw(request('10.5.6.7'), next)).toBe(okResponse);
    expect(await mw(request('127.0.0.1'), next)).toBe(okResponse);
    await expect(mw(request('192.168.1.5'), next)).rejects.toThrow(HttpError);
  });
});

describe('IpAllowlist — IPv6', () => {
  test('matches IPv6 loopback /128', async () => {
    const mw = IpAllowlist({ allow: ['::1/128'] });
    expect(await mw(request('::1'), next)).toBe(okResponse);
    await expect(mw(request('::2'), next)).rejects.toThrow(HttpError);
  });

  test('matches a /64 prefix', async () => {
    const mw = IpAllowlist({ allow: ['2001:db8::/32'] });
    expect(await mw(request('2001:db8:1::1'), next)).toBe(okResponse);
    expect(await mw(request('2001:db8:ffff:ffff::'), next)).toBe(okResponse);
    await expect(mw(request('2001:db9::1'), next)).rejects.toThrow(HttpError);
  });

  test('handles IPv4-mapped IPv6 (::ffff:a.b.c.d) against an IPv4 CIDR', async () => {
    const mw = IpAllowlist({ allow: ['10.0.0.0/8'] });
    // Dual-stack socket peer often arrives as `::ffff:10.5.6.7`.
    expect(await mw(request('::ffff:10.5.6.7'), next)).toBe(okResponse);
    await expect(mw(request('::ffff:192.168.1.5'), next)).rejects.toThrow(HttpError);
  });
});

describe('IpAllowlist — fail-closed', () => {
  test('rejects request with no remoteAddress (fail-secure)', async () => {
    const mw = IpAllowlist({ allow: ['10.0.0.0/8'] });
    await expect(mw(request(undefined), next)).rejects.toThrow(/no client address/);
  });

  test('honours custom getClientIp extractor for x-forwarded-for', async () => {
    const mw = IpAllowlist({
      allow: ['10.0.0.0/8'],
      getClientIp: (r) => r.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? null,
    });
    expect(await mw(request(undefined, { 'x-forwarded-for': '10.1.2.3' }), next)).toBe(okResponse);
    await expect(mw(request(undefined, { 'x-forwarded-for': '192.168.1.1' }), next)).rejects.toThrow(HttpError);
  });

  test('constructor throws on empty allow list', () => {
    expect(() => IpAllowlist({ allow: [] })).toThrow(/non-empty/);
  });

  test('constructor throws on invalid CIDR', () => {
    expect(() => IpAllowlist({ allow: ['10.0.0.0'] })).toThrow(/prefix/);
    expect(() => IpAllowlist({ allow: ['10.0.0.0/33'] })).toThrow(/32 bits/);
    expect(() => IpAllowlist({ allow: ['::1/200'] })).toThrow(/128 bits/);
  });

  test('unparseable peer address fails closed (does not match any CIDR)', async () => {
    const mw = IpAllowlist({ allow: ['10.0.0.0/8'] });
    await expect(mw(request('not.an.ip'), next)).rejects.toThrow(HttpError);
  });
});
