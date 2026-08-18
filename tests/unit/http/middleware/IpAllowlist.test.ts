import { describe, expect, test } from 'bun:test';
import { IpAllowlist } from '../../../../src/http/middleware/IpAllowlist.js';
import { IpAllowlistOptions } from '../../../../src/http/middleware/IpAllowlistOptions.js';
import { HttpError, Status, type HttpRequest } from '../../../../src/http/Types.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';

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

  // The escape hatch, exercised through a header the app itself mints —
  // NOT through `x-forwarded-for`, which is what `trustedProxies` is for.
  // A hand-written extractor over the forwarded chain is the defect #715
  // was filed about; a fixture is documentation, so this one must not
  // print it.
  test('honours a custom getClientIp extractor', async () => {
    const mw = IpAllowlist({
      allow: ['10.0.0.0/8'],
      getClientIp: (r) => r.headers['x-internal-client-address'] ?? null,
    });
    expect(await mw(request(undefined, { 'x-internal-client-address': '10.1.2.3' }), next)).toBe(okResponse);
    await expect(mw(request(undefined, { 'x-internal-client-address': '192.168.1.1' }), next)).rejects.toThrow(HttpError);
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

/**
 * #715 — the forwarded chain, and why the entry that decides is chosen from
 * the socket end inwards.
 *
 * Every proxy the old `split(',')[0]` recipe was written for (NGINX's
 * `$proxy_add_x_forwarded_for`, AWS ALB, Cloudflare) **appends** the peer it
 * saw to whatever `x-forwarded-for` arrived.  So the leftmost entry is the
 * client's own text and the rightmost entries are the ones infrastructure
 * added — which makes right-to-left the only direction in which a position
 * means anything.
 *
 * Two address blocks run through the whole suite:
 *   - `10.9.9.0/24` — an in-`allow` proxy.  The realistic shape, because
 *     `allow: 10.0.0.0/8` covers the load balancer as well as the clients,
 *     and it is exactly the shape in which reading the wrong entry is
 *     invisible: the socket peer would have been allowed anyway.
 *   - `203.0.113.0/24` — an out-of-`allow` edge (a cloud LB), where the
 *     allowlist can only ever pass if the client address really was
 *     resolved out of the chain.
 */
describe('IpAllowlist — trustedProxies resolves the client from the forwarded chain', () => {
  const behindInternalProxy = IpAllowlist({
    allow: ['10.0.0.0/8'],
    trustedProxies: ['10.9.9.0/24'],
  });
  const behindEdge = IpAllowlist({
    allow: ['10.0.0.0/8'],
    trustedProxies: ['203.0.113.0/24'],
  });

  test('the client the proxy appended decides, not the entry the client sent', async () => {
    // `x-forwarded-for: <forged in-range>, <real client>` — the proxy at
    // 10.9.9.9 appended the real peer on the right.  Reading the left
    // entry admits 10.1.2.3; reading from the right denies 198.51.100.5.
    await expect(
      behindInternalProxy(request('10.9.9.9', { 'x-forwarded-for': '10.1.2.3, 198.51.100.5' }), next),
    ).rejects.toThrow(/IP not allowed: 198\.51\.100\.5/);
  });

  test('an out-of-range client is denied however much in-range text it prepends', async () => {
    await expect(
      behindInternalProxy(
        request('10.9.9.9', { 'x-forwarded-for': '10.0.0.1, 10.0.0.2, 198.51.100.5' }),
        next,
      ),
    ).rejects.toThrow(/IP not allowed: 198\.51\.100\.5/);
  });

  test('an in-range client behind an out-of-range edge is admitted', async () => {
    expect(await behindEdge(request('203.0.113.7', { 'x-forwarded-for': '10.1.2.3' }), next)).toBe(okResponse);
  });

  test('a chain of trusted hops is walked through to the client', async () => {
    // Two trusted edge nodes on the right; the client is the third from
    // the end of `[...forwarded, peer]`.
    expect(
      await behindEdge(request('203.0.113.7', { 'x-forwarded-for': '10.1.2.3, 203.0.113.20' }), next),
    ).toBe(okResponse);
  });

  test('a direct client cannot forge its way in — an untrusted peer ends the walk', async () => {
    // Nothing about this request passed a proxy, so the header is not read
    // at all: the peer is untrusted and therefore already the answer.
    await expect(
      behindEdge(request('198.51.100.7', { 'x-forwarded-for': '10.1.2.3' }), next),
    ).rejects.toThrow(/IP not allowed: 198\.51\.100\.7/);
  });

  test('an unparseable entry ends the walk instead of being skipped over', async () => {
    // It matches no trusted CIDR, so it counts as untrusted — and then
    // matches no `allow` CIDR either.  Fail-closed at both steps.
    await expect(
      behindInternalProxy(request('10.9.9.9', { 'x-forwarded-for': '10.1.2.3, not.an.ip' }), next),
    ).rejects.toThrow(/IP not allowed: not\.an\.ip/);
  });

  test('an exhausted chain falls back to the socket peer, not to the leftmost entry', async () => {
    // Every entry is infrastructure, so the chain names no client.  The
    // leftmost entry (what `proxy-addr` returns here) is reachable by a
    // caller behind the proxy prepending a proxy address; the socket peer
    // is not, so that is the answer — deliberately divergent.
    const exhausted = IpAllowlist({
      allow: ['203.0.113.7/32'],
      trustedProxies: ['203.0.113.0/24'],
    });
    expect(await exhausted(request('203.0.113.7', { 'x-forwarded-for': '203.0.113.9' }), next)).toBe(okResponse);
  });

  test('trusting the whole address space degrades to the socket peer, not to the header', async () => {
    // The documented "never trust every hop" case.  `0.0.0.0/0` exhausts
    // the walk, so the option buys nothing — which is a wasted option, not
    // a bypass.  The backends' `trust proxy: true` is the dangerous
    // spelling of the same idea; this one cannot be.
    const trustsEverything = IpAllowlist({
      allow: ['10.0.0.0/8'],
      trustedProxies: ['0.0.0.0/0'],
    });
    await expect(
      trustsEverything(request('198.51.100.7', { 'x-forwarded-for': '10.1.2.3' }), next),
    ).rejects.toThrow(/IP not allowed: 198\.51\.100\.7/);
  });

  test('no socket peer fails closed even with a whole chain on offer', async () => {
    await expect(
      behindEdge(request(undefined, { 'x-forwarded-for': '10.1.2.3' }), next),
    ).rejects.toThrow(/no client address/);
  });

  test('an absent forwarding header leaves the trusted peer as the client', async () => {
    // A probe the proxy itself issues, or a proxy that forgot to forward.
    // The peer is real, so it is the honest answer — and it is judged by
    // `allow` like any other address.
    expect(await behindInternalProxy(request('10.9.9.9'), next)).toBe(okResponse);
    await expect(behindEdge(request('203.0.113.7'), next)).rejects.toThrow(/IP not allowed: 203\.0\.113\.7/);
  });

  test('IPv4-mapped IPv6 peers are recognised as trusted proxies', async () => {
    expect(
      await behindEdge(request('::ffff:203.0.113.7', { 'x-forwarded-for': '10.1.2.3' }), next),
    ).toBe(okResponse);
  });

  test('whitespace and empty entries in the chain are tolerated', async () => {
    expect(
      await behindEdge(request('203.0.113.7', { 'x-forwarded-for': ' 10.1.2.3 ,  , ' }), next),
    ).toBe(okResponse);
  });

  test('without trustedProxies the forwarding header is not read at all', async () => {
    const socketOnly = IpAllowlist({ allow: ['10.0.0.0/8'] });
    await expect(
      socketOnly(request('198.51.100.7', { 'x-forwarded-for': '10.1.2.3' }), next),
    ).rejects.toThrow(/IP not allowed: 198\.51\.100\.7/);
  });
});

describe('IpAllowlist — forwardedHeader', () => {
  test('reads the vendor header instead of x-forwarded-for, and ignores the latter', async () => {
    const behindCloudflare = IpAllowlist({
      allow: ['10.0.0.0/8'],
      trustedProxies: ['203.0.113.0/24'],
      forwardedHeader: 'cf-connecting-ip',
    });
    expect(
      await behindCloudflare(
        request('203.0.113.7', { 'cf-connecting-ip': '10.1.2.3', 'x-forwarded-for': '192.168.1.1' }),
        next,
      ),
    ).toBe(okResponse);
    await expect(
      behindCloudflare(
        request('203.0.113.7', { 'cf-connecting-ip': '192.168.1.1', 'x-forwarded-for': '10.1.2.3' }),
        next,
      ),
    ).rejects.toThrow(/IP not allowed: 192\.168\.1\.1/);
  });

  test('the configured name is matched case-insensitively', async () => {
    // Every backend lower-cases incoming header names; an operator writing
    // the vendor's own capitalisation must not silently get a 403.
    const behindCloudflare = IpAllowlist({
      allow: ['10.0.0.0/8'],
      trustedProxies: ['203.0.113.0/24'],
      forwardedHeader: 'CF-Connecting-IP',
    });
    expect(
      await behindCloudflare(request('203.0.113.7', { 'cf-connecting-ip': '10.1.2.3' }), next),
    ).toBe(okResponse);
  });
});

describe('IpAllowlist — options surface', () => {
  test('the builder produces the same middleware as the plain object', async () => {
    const ipAllowlistOptions = IpAllowlistOptions.create()
      .withAllow('10.0.0.0/8')
      .withTrustedProxies('203.0.113.0/24')
      .withForwardedHeader('cf-connecting-ip');
    const mw = IpAllowlist(ipAllowlistOptions);
    expect(await mw(request('203.0.113.7', { 'cf-connecting-ip': '10.1.2.3' }), next)).toBe(okResponse);
    await expect(
      mw(request('203.0.113.7', { 'cf-connecting-ip': '192.168.1.1' }), next),
    ).rejects.toThrow(HttpError);
  });

  test('the builder writes each field under the name the plain shape uses', () => {
    // `withX` ⇔ field `x`, with no divergence: a builder *is* its settings,
    // so a renamed field would silently stop being read by the middleware.
    const ipAllowlistOptions = IpAllowlistOptions.create()
      .withAllow('10.0.0.0/8')
      .withTrustedProxies('10.9.9.0/24')
      .withForwardedHeader('x-real-ip');
    expect({ ...ipAllowlistOptions }).toEqual({
      allow: ['10.0.0.0/8'],
      trustedProxies: ['10.9.9.0/24'],
      forwardedHeader: 'x-real-ip',
    });
    const withExtractor = IpAllowlistOptions.create()
      .withAllow('10.0.0.0/8')
      .withGetClientIp((r) => r.remoteAddress);
    expect(Object.keys({ ...withExtractor }).sort()).toEqual(['allow', 'getClientIp']);
  });

  test('an invalid trustedProxies CIDR is rejected at construction', () => {
    expect(() => IpAllowlist({ allow: ['10.0.0.0/8'], trustedProxies: ['10.9.9.0'] })).toThrow(/prefix/);
  });

  test('a silently-inert configuration is rejected rather than ignored', () => {
    // Each of these reads as "the forwarded header is handled" and would
    // handle nothing.  An allowlist that quietly stops filtering is the
    // failure mode worth being loud about.
    expect(() => IpAllowlist({ allow: ['10.0.0.0/8'], trustedProxies: [] })).toThrow(OptionsError);
    expect(() => IpAllowlist({ allow: ['10.0.0.0/8'], forwardedHeader: 'cf-connecting-ip' }))
      .toThrow(/forwardedHeader/);
    expect(() => IpAllowlist({
      allow: ['10.0.0.0/8'],
      trustedProxies: ['10.9.9.0/24'],
      getClientIp: (r) => r.remoteAddress,
    })).toThrow(/getClientIp/);
  });
});
