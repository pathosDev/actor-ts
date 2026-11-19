import { describe, expect, test } from 'bun:test';
import { InMemoryCache } from '../../../../src/cache/InMemoryCache.js';
import { rateLimit } from '../../../../src/http/cache/RateLimit.js';
import { clientIpResolver, resolveClientIp } from '../../../../src/http/middleware/ClientIp.js';
import { complete } from '../../../../src/http/Route.js';
import { Status, type HttpRequest } from '../../../../src/http/Types.js';

/**
 * The trusted-proxy walk is shared (#1236): `IpAllowlist` and anything else —
 * a `rateLimit` key above all — resolve the client through the same helper,
 * so the rule that keeps a forged `x-forwarded-for` from deciding anything
 * holds wherever a client address is needed.
 */

const request = (remoteAddress?: string, headers: Record<string, string> = {}): HttpRequest => ({
  method: 'GET',
  path: '/',
  headers,
  query: {},
  params: {},
  body: null,
  ...(remoteAddress !== undefined ? { remoteAddress } : {}),
});

const EDGE = '10.0.0.0/8';

describe('clientIpResolver — the right-to-left walk', () => {
  test('a chain of two trusted proxies plus a client resolves to the client', () => {
    const resolve = clientIpResolver([EDGE]);
    expect(resolve(request('10.0.0.2', { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
  });

  test('an untrusted entry ends the walk — what the client prepended is never reached', () => {
    const resolve = clientIpResolver([EDGE]);
    const forged = request('10.0.0.2', { 'x-forwarded-for': '1.1.1.1, 198.51.100.4, 10.0.0.1' });
    expect(resolve(forged)).toBe('198.51.100.4');
  });

  test('a direct client is the socket peer, whatever header it sends', () => {
    const resolve = clientIpResolver([EDGE]);
    expect(resolve(request('198.51.100.4', { 'x-forwarded-for': '10.0.0.9' }))).toBe('198.51.100.4');
  });

  test('no configured proxies falls back to the socket peer and never reads the header', () => {
    for (const resolve of [clientIpResolver(), clientIpResolver([])]) {
      expect(resolve(request('10.0.0.2', { 'x-forwarded-for': '203.0.113.7' }))).toBe('10.0.0.2');
    }
  });

  test('an exhausted chain falls back to the socket peer, not to the leftmost entry', () => {
    const resolve = clientIpResolver([EDGE]);
    expect(resolve(request('10.0.0.2', { 'x-forwarded-for': '10.9.9.9, 10.0.0.1' }))).toBe('10.0.0.2');
  });

  test('no socket peer fails closed', () => {
    const resolve = clientIpResolver([EDGE]);
    expect(resolve(request(undefined, { 'x-forwarded-for': '203.0.113.7' }))).toBeUndefined();
  });

  test('a vendor header is read instead of x-forwarded-for, matched case-insensitively', () => {
    const resolve = clientIpResolver([EDGE], 'CF-Connecting-IP');
    const viaEdge = request('10.0.0.2', { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '192.0.2.1' });
    expect(resolve(viaEdge)).toBe('203.0.113.7');
  });

  test('an invalid CIDR is refused when the resolver is built, not per request', () => {
    expect(() => clientIpResolver(['not-a-cidr'])).toThrow();
  });

  test('resolveClientIp is the one-shot form of the same walk', () => {
    const viaEdge = request('10.0.0.2', { 'x-forwarded-for': '203.0.113.7' });
    expect(resolveClientIp(viaEdge, [EDGE])).toBe('203.0.113.7');
    expect(resolveClientIp(viaEdge, [])).toBe('10.0.0.2');
  });
});

describe('rateLimit keyed on the resolved client', () => {
  test('behind a proxy, two clients get two buckets — not one bucket for the proxy', async () => {
    const clientIp = clientIpResolver([EDGE]);
    const limited = rateLimit({
      cache: new InMemoryCache(),
      windowMs: 60_000,
      max: 1,
      key: (incoming) => clientIp(incoming) ?? '<unresolved>',
    })(() => complete(Status.OK, { ok: true }));

    const first = await limited(request('10.0.0.2', { 'x-forwarded-for': '203.0.113.7' }));
    const second = await limited(request('10.0.0.2', { 'x-forwarded-for': '198.51.100.4' }));
    expect([first.status, second.status]).toEqual([200, 200]);
    const again = await limited(request('10.0.0.2', { 'x-forwarded-for': '203.0.113.7' }));
    expect(again.status).toBe(429);
  });

  test('rotating a prepended header does not mint a fresh bucket', async () => {
    const clientIp = clientIpResolver([EDGE]);
    const limited = rateLimit({
      cache: new InMemoryCache(),
      windowMs: 60_000,
      max: 1,
      key: (incoming) => clientIp(incoming) ?? '<unresolved>',
    })(() => complete(Status.OK, { ok: true }));

    const statuses: number[] = [];
    for (const forged of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
      const proxied = request('10.0.0.2', { 'x-forwarded-for': `${forged}, 203.0.113.7` });
      statuses.push((await limited(proxied)).status);
    }
    expect(statuses).toEqual([200, 429, 429]);
  });
});
