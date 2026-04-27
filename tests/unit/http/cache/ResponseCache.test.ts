import { describe, expect, test } from 'bun:test';
import { InMemoryCache } from '../../../../src/cache/InMemoryCache.js';
import { cached } from '../../../../src/http/cache/ResponseCache.js';
import { complete, completeJson } from '../../../../src/http/Route.js';
import { Status, type HttpRequest, type HttpResponse } from '../../../../src/http/types.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

function makeReq(path: string, params: Record<string, string> = {}): HttpRequest {
  return { method: 'GET', path, headers: {}, query: {}, params, body: null };
}

describe('cached — basic round-trip', () => {
  test('first call runs handler; subsequent calls hit cache', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({ cache, ttlMs: 5_000, key: (req) => req.path })(
      () => { calls++; return completeJson(Status.OK, { n: calls }); },
    );
    const r1 = await handler(makeReq('/users/1'));
    const r2 = await handler(makeReq('/users/1'));
    expect(r1.body).toEqual({ n: 1 });
    expect(r2.body).toEqual({ n: 1 });
    expect(calls).toBe(1);
  });

  test('different keys → independent cache slots', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({ cache, ttlMs: 5_000, key: (req) => req.path })(
      () => { calls++; return complete(Status.OK, calls); },
    );
    await handler(makeReq('/users/1'));
    await handler(makeReq('/users/2'));
    await handler(makeReq('/users/1'));
    expect(calls).toBe(2);
  });

  test('TTL: cache entry expires and the handler is rerun', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({ cache, ttlMs: 30, key: () => 'k' })(
      () => { calls++; return complete(Status.OK, 'x'); },
    );
    await handler(makeReq('/'));
    await sleep(50);
    await handler(makeReq('/'));
    expect(calls).toBe(2);
  });

  test('rejects invalid ttl', () => {
    const cache = new InMemoryCache();
    expect(() => cached({ cache, ttlMs: 0, key: () => '' })).toThrow();
    expect(() => cached({ cache, ttlMs: -1, key: () => '' })).toThrow();
  });
});

describe('cached — status filtering', () => {
  test('default policy caches only 2xx', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({ cache, ttlMs: 5_000, key: () => 'k' })(
      () => { calls++; return complete(Status.NotFound, { error: 'nope' }); },
    );
    await handler(makeReq('/'));
    await handler(makeReq('/'));
    expect(calls).toBe(2);  // 404 not cached → handler runs every time
  });

  test('cacheStatuses opts in 404 (negative cache pattern)', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({
      cache, ttlMs: 5_000, key: () => 'k',
      cacheStatuses: [200, 404],
    })(() => { calls++; return complete(Status.NotFound, { error: 'nope' }); });
    await handler(makeReq('/'));
    await handler(makeReq('/'));
    expect(calls).toBe(1);
  });
});

describe('cached — stampede protection', () => {
  test('100 concurrent misses → handler runs exactly once', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({ cache, ttlMs: 5_000, key: () => 'hot' })(
      async () => { calls++; await sleep(20); return completeJson(Status.OK, { n: calls }); },
    );
    const results = await Promise.all(Array.from({ length: 100 }, () => handler(makeReq('/'))));
    expect(calls).toBe(1);
    for (const r of results) expect((r.body as { n: number }).n).toBe(1);
  });

  test('after the in-flight resolves, the next request reads from cache', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({ cache, ttlMs: 5_000, key: () => 'k' })(
      async () => { calls++; await sleep(20); return complete(Status.OK, calls); },
    );
    await handler(makeReq('/'));
    await handler(makeReq('/'));
    expect(calls).toBe(1);
  });
});

describe('cached — binary payload round-trip', () => {
  test('Uint8Array bodies survive base64 round-trip', async () => {
    const cache = new InMemoryCache();
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const handler = cached({ cache, ttlMs: 5_000, key: () => 'k' })(
      (): HttpResponse => ({ status: 200, body: bytes, contentType: 'application/octet-stream' }),
    );
    const r1 = await handler(makeReq('/'));
    const r2 = await handler(makeReq('/'));
    expect(r2.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(r2.body as Uint8Array)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    void r1;
  });
});

describe('cached — explicit invalidation', () => {
  test('cache.delete forces the next request to re-run the handler', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const keyFn = (): string => 'rsp:k';  // matches default keyPrefix='rsp:' + 'k'
    const handler = cached({ cache, ttlMs: 5_000, key: () => 'k' })(
      () => { calls++; return complete(Status.OK, calls); },
    );
    await handler(makeReq('/'));
    await cache.delete(keyFn());  // user-side invalidation
    await handler(makeReq('/'));
    expect(calls).toBe(2);
  });
});
