import { describe, expect, test } from 'bun:test';
import { InMemoryCache } from '../../../../src/cache/InMemoryCache.js';
import { rateLimit } from '../../../../src/http/cache/RateLimit.js';
import { complete } from '../../../../src/http/Route.js';
import { Status, type HttpRequest } from '../../../../src/http/types.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

function makeReq(path: string, headers: Record<string, string> = {}): HttpRequest {
  return {
    method: 'GET',
    path,
    headers,
    query: {},
    params: {},
    body: null,
  };
}

const okHandler = () => complete(Status.OK, { ok: true });

describe('rateLimit — fixed-window counter', () => {
  test('first N requests pass; (N+1)th gets 429', async () => {
    const cache = new InMemoryCache();
    const limited = rateLimit({ cache, windowMs: 60_000, max: 3, key: () => 'tester' });
    const handler = limited(okHandler);
    expect((await handler(makeReq('/a'))).status).toBe(200);
    expect((await handler(makeReq('/a'))).status).toBe(200);
    expect((await handler(makeReq('/a'))).status).toBe(200);
    const limited4 = await handler(makeReq('/a'));
    expect(limited4.status).toBe(Status.TooManyRequests);
    expect(limited4.headers?.['retry-after']).toBeDefined();
  });

  test('different keys do not share the window', async () => {
    const cache = new InMemoryCache();
    const limited = rateLimit({ cache, windowMs: 60_000, max: 1,
      key: (req) => req.headers['x-user'] ?? '<anon>' });
    const handler = limited(okHandler);
    expect((await handler(makeReq('/', { 'x-user': 'alice' }))).status).toBe(200);
    expect((await handler(makeReq('/', { 'x-user': 'alice' }))).status).toBe(429);
    expect((await handler(makeReq('/', { 'x-user': 'bob' }))).status).toBe(200);  // different bucket
  });

  test('window reset: after windowMs the counter resets', async () => {
    const cache = new InMemoryCache();
    const limited = rateLimit({ cache, windowMs: 30, max: 1, key: () => 'k' });
    const handler = limited(okHandler);
    expect((await handler(makeReq('/'))).status).toBe(200);
    expect((await handler(makeReq('/'))).status).toBe(429);
    await sleep(50);  // window expired
    expect((await handler(makeReq('/'))).status).toBe(200);
  });

  test('successful response carries x-ratelimit-* headers', async () => {
    const cache = new InMemoryCache();
    const limited = rateLimit({ cache, windowMs: 60_000, max: 10, key: () => 'k' });
    const handler = limited(okHandler);
    const r = await handler(makeReq('/'));
    expect(r.headers?.['x-ratelimit-limit']).toBe('10');
    expect(r.headers?.['x-ratelimit-remaining']).toBe('9');
  });

  test('custom onLimit response is used when limit hit', async () => {
    const cache = new InMemoryCache();
    const limited = rateLimit({
      cache, windowMs: 60_000, max: 1, key: () => 'k',
      onLimit: (ctx) => complete(503, { custom: true, count: ctx.count }),
    });
    const handler = limited(okHandler);
    await handler(makeReq('/'));
    const blocked = await handler(makeReq('/'));
    expect(blocked.status).toBe(503);
  });

  test('cache failure → fail-open (request passes through)', async () => {
    const broken = new InMemoryCache();
    // Override incr to throw — simulates a Redis outage.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (broken as any).incr = async () => { throw new Error('redis down'); };
    const limited = rateLimit({ cache: broken, windowMs: 60_000, max: 1, key: () => 'k' });
    const handler = limited(okHandler);
    // Even though max=1, 5 requests should all succeed because the
    // counter cannot be incremented — fail open is the intended path.
    for (let i = 0; i < 5; i++) {
      expect((await handler(makeReq('/'))).status).toBe(200);
    }
  });

  test('rejects invalid configuration up-front', () => {
    const cache = new InMemoryCache();
    expect(() => rateLimit({ cache, windowMs: 0, max: 5, key: () => '' })).toThrow();
    expect(() => rateLimit({ cache, windowMs: 1_000, max: 0, key: () => '' })).toThrow();
    expect(() => rateLimit({ cache, windowMs: 1_000, max: -1, key: () => '' })).toThrow();
  });
});
