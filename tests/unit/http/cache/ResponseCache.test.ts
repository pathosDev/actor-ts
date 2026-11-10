import { describe, expect, test } from 'bun:test';
import { InMemoryCache } from '../../../../src/cache/InMemoryCache.js';
import { cached } from '../../../../src/http/cache/ResponseCache.js';
import { complete, completeJson } from '../../../../src/http/Route.js';
import { Status, type HttpRequest, type HttpResponse } from '../../../../src/http/Types.js';
import { sleep } from '../../../util/AwaitCondition.js';

function makeRequest(path: string, params: Record<string, string> = {}): HttpRequest {
  return { method: 'GET', path, headers: {}, query: {}, params, body: null };
}

describe('cached — basic round-trip', () => {
  test('first call runs handler; subsequent calls hit cache', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({ cache, ttlMs: 5_000, key: (request) => request.path })(
      () => { calls++; return completeJson(Status.OK, { n: calls }); },
    );
    const r1 = await handler(makeRequest('/users/1'));
    const r2 = await handler(makeRequest('/users/1'));
    expect(r1.body).toEqual({ n: 1 });
    expect(r2.body).toEqual({ n: 1 });
    expect(calls).toBe(1);
  });

  test('different keys → independent cache slots', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({ cache, ttlMs: 5_000, key: (request) => request.path })(
      () => { calls++; return complete(Status.OK, String(calls)); },
    );
    await handler(makeRequest('/users/1'));
    await handler(makeRequest('/users/2'));
    await handler(makeRequest('/users/1'));
    expect(calls).toBe(2);
  });

  test('TTL: cache entry expires and the handler is rerun', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({ cache, ttlMs: 30, key: () => 'k' })(
      () => { calls++; return complete(Status.OK, 'x'); },
    );
    await handler(makeRequest('/'));
    // The elapsed time IS the assertion: 50 ms outlasts the 30 ms entry TTL, which
    // is what makes the handler run a second time.
    await sleep(50);
    await handler(makeRequest('/'));
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
    await handler(makeRequest('/'));
    await handler(makeRequest('/'));
    expect(calls).toBe(2);  // 404 not cached → handler runs every time
  });

  test('cacheStatuses options in 404 (negative cache pattern)', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({
      cache, ttlMs: 5_000, key: () => 'k',
      cacheStatuses: [200, 404],
    })(() => { calls++; return complete(Status.NotFound, { error: 'nope' }); });
    await handler(makeRequest('/'));
    await handler(makeRequest('/'));
    expect(calls).toBe(1);
  });
});

describe('cached — stampede protection', () => {
  test('100 concurrent misses → handler runs exactly once', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({ cache, ttlMs: 5_000, key: () => 'hot' })(
      // A fixture: the handler has to stay in flight while the other 99 requests
      // arrive, or there is no stampede for the protection to collapse.
      async () => { calls++; await sleep(20); return completeJson(Status.OK, { n: calls }); },
    );
    const results = await Promise.all(Array.from({ length: 100 }, () => handler(makeRequest('/'))));
    expect(calls).toBe(1);
    for (const r of results) expect((r.body as { n: number }).n).toBe(1);
  });

  test('after the in-flight resolves, the next request reads from cache', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({ cache, ttlMs: 5_000, key: () => 'k' })(
      // A fixture: the first call has to take measurable time, so that the second
      // request is answered from the cache rather than from a still-empty one.
      async () => { calls++; await sleep(20); return complete(Status.OK, String(calls)); },
    );
    await handler(makeRequest('/'));
    await handler(makeRequest('/'));
    expect(calls).toBe(1);
  });

  test('concurrent misses on a status outside cacheStatuses still run the handler once and store nothing', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({ cache, ttlMs: 5_000, key: () => 'missing' })(
      // A fixture: the handler has to stay in flight while the other requests
      // arrive, or there is no stampede for the protection to collapse.
      async () => { calls++; await sleep(20); return completeJson(Status.NotFound, { error: 'nope' }); },
    );
    const results = await Promise.all(Array.from({ length: 10 }, () => handler(makeRequest('/'))));
    expect(calls).toBe(1);
    for (const r of results) expect(r.status).toBe(Status.NotFound);
    // `cacheStatuses` governs storing: nothing is left behind for the next miss.
    expect((await cache.get('rsp:missing')).isSome()).toBe(false);
  });
});

describe('cached — binary payload round-trip', () => {
  test('Uint8Array bodies survive base64 round-trip', async () => {
    const cache = new InMemoryCache();
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const handler = cached({ cache, ttlMs: 5_000, key: () => 'k' })(
      (): HttpResponse => ({ status: 200, body: bytes, contentType: 'application/octet-stream' }),
    );
    const r1 = await handler(makeRequest('/'));
    const r2 = await handler(makeRequest('/'));
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
      () => { calls++; return complete(Status.OK, String(calls)); },
    );
    await handler(makeRequest('/'));
    await cache.delete(keyFn());  // user-side invalidation
    await handler(makeRequest('/'));
    expect(calls).toBe(2);
  });
});

/**
 * #980 — what one caller's response may reach another.  The scenario from
 * the issue: an endpoint keyed on a path parameter only, whose handler
 * authenticates the caller, returns their own body, refreshes their session
 * with `Set-Cookie` and says `Vary: authorization`.  Before the fix the
 * handler ran once for three callers and all three received Alice's body and
 * Alice's session cookie.
 */
function request(
  overrides: Partial<HttpRequest> & { headers?: Record<string, string> } = {},
): HttpRequest {
  return { method: 'GET', path: '/me', query: {}, params: {}, body: null, ...overrides, headers: overrides.headers ?? {} };
}

function sessionHandler(counter: { calls: number }) {
  return (r: HttpRequest): HttpResponse => {
    counter.calls++;
    const token = r.headers['authorization'];
    if (!token) return complete(Status.Unauthorized, { error: 'unauthenticated' });
    const user = token.replace('Bearer ', '');
    return {
      status: 200,
      headers: { 'set-cookie': `session=${user}-SESSION; HttpOnly`, vary: 'authorization' },
      body: { user },
    };
  };
}

describe('cached — #980 the issue scenario', () => {
  test('two callers with different credentials each get their own response', async () => {
    const counter = { calls: 0 };
    const handler = cached({ cache: new InMemoryCache(), ttlMs: 30_000, key: () => 'users:me' })(sessionHandler(counter));
    const alice = await handler(request({ headers: { authorization: 'Bearer alice' } }));
    const bob = await handler(request({ headers: { authorization: 'Bearer bob' } }));
    expect(alice.body).toEqual({ user: 'alice' });
    expect(bob.body).toEqual({ user: 'bob' });
    expect(bob.headers?.['set-cookie']).toBe('session=bob-SESSION; HttpOnly');
    expect(counter.calls).toBe(2);
  });

  test('an unauthenticated caller after an authenticated one reaches the handler and is refused', async () => {
    const counter = { calls: 0 };
    const handler = cached({ cache: new InMemoryCache(), ttlMs: 30_000, key: () => 'users:me' })(sessionHandler(counter));
    await handler(request({ headers: { authorization: 'Bearer alice' } }));
    const anonymous = await handler(request());
    expect(anonymous.status).toBe(Status.Unauthorized);
    expect(anonymous.headers?.['set-cookie']).toBeUndefined();
    expect(counter.calls).toBe(2);
  });

  test('a concurrent caller does not take an in-flight credentialed response', async () => {
    const counter = { calls: 0 };
    const inner = sessionHandler(counter);
    const handler = cached({ cache: new InMemoryCache(), ttlMs: 30_000, key: () => 'users:me' })(
      // A fixture: the first request has to still be in flight when the
      // others arrive, which is the window the single-flight map covers.
      async (r) => { await sleep(10); return inner(r); },
    );
    const [alice, bob, anonymous] = await Promise.all([
      handler(request({ headers: { authorization: 'Bearer alice' } })),
      handler(request({ headers: { authorization: 'Bearer bob' } })),
      handler(request()),
    ]);
    expect(alice.body).toEqual({ user: 'alice' });
    expect(bob.body).toEqual({ user: 'bob' });
    expect(anonymous.status).toBe(Status.Unauthorized);
    expect(counter.calls).toBe(3);
  });
});

describe('cached — #980 credentialed requests', () => {
  for (const header of ['authorization', 'proxy-authorization', 'cookie']) {
    test(`a request carrying ${header} neither reads nor feeds the cache without identity`, async () => {
      const cache = new InMemoryCache();
      let calls = 0;
      const handler = cached({ cache, ttlMs: 30_000, key: () => 'k' })(
        () => { calls++; return completeJson(Status.OK, { n: calls }); },
      );
      await handler(request({ headers: { [header]: 'x' } }));
      expect((await cache.get('rsp:k')).isSome()).toBe(false);
      // An anonymous entry is not served to a credentialed caller either.
      await handler(request());
      const credentialed = await handler(request({ headers: { [header]: 'x' } }));
      expect(credentialed.body).toEqual({ n: 3 });
    });
  }

  test('identity is the opt-in: credentialed requests are cached per scope', async () => {
    let calls = 0;
    const handler = cached({
      cache: new InMemoryCache(),
      ttlMs: 30_000,
      key: () => 'users:me',
      identity: (r) => r.headers['authorization'] ?? 'anonymous',
    })((r) => { calls++; return completeJson(Status.OK, { user: r.headers['authorization'] }); });
    await handler(request({ headers: { authorization: 'alice' } }));
    const aliceAgain = await handler(request({ headers: { authorization: 'alice' } }));
    const bob = await handler(request({ headers: { authorization: 'bob' } }));
    expect(aliceAgain.body).toEqual({ user: 'alice' });
    expect(bob.body).toEqual({ user: 'bob' });
    expect(calls).toBe(2);
  });

  test('the scope is encoded, so a scope containing ":" cannot collide with another split', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({
      cache,
      ttlMs: 30_000,
      key: (r) => r.path,
      identity: (r) => r.headers['x-scope'] ?? '',
    })((r) => { calls++; return completeJson(Status.OK, { scope: r.headers['x-scope'], path: r.path }); });
    // Unencoded, both would be 'rsp:a:b:c'.
    await handler(request({ path: 'c', headers: { 'x-scope': 'a:b' } }));
    const other = await handler(request({ path: 'b:c', headers: { 'x-scope': 'a' } }));
    expect(other.body).toEqual({ scope: 'a', path: 'b:c' });
    expect(calls).toBe(2);
    expect((await cache.get('rsp:a%3Ab:c')).isSome()).toBe(true);
  });
});

describe('cached — #980 responses that must not be shared', () => {
  const unshareable: ReadonlyArray<[string, Record<string, string>]> = [
    ['Set-Cookie', { 'Set-Cookie': 'session=abc' }],
    ['set-cookie', { 'set-cookie': 'session=abc' }],
    ['Cache-Control: no-store', { 'cache-control': 'no-store' }],
    ['Cache-Control: private', { 'Cache-Control': 'max-age=60, private' }],
    ['Cache-Control: private="x"', { 'cache-control': 'private="set-cookie"' }],
    ['Cache-Control: no-cache', { 'cache-control': 'NO-CACHE' }],
    ['Vary: *', { vary: 'accept, *' }],
  ];
  for (const [label, headers] of unshareable) {
    test(`a response carrying ${label} is not stored and not handed to a waiting request`, async () => {
      const cache = new InMemoryCache();
      let calls = 0;
      const handler = cached({ cache, ttlMs: 30_000, key: () => 'k' })(
        // A fixture: long enough that the second request joins the flight.
        async (): Promise<HttpResponse> => { calls++; await sleep(10); return { status: 200, headers, body: { n: calls } }; },
      );
      const [first, second] = await Promise.all([handler(request()), handler(request())]);
      expect(first.body).toEqual({ n: 1 });
      expect(second.body).toEqual({ n: 2 });
      expect((await cache.get('rsp:k')).isSome()).toBe(false);
    });
  }

  test('a streaming body is not stored and not handed to a waiting request', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({ cache, ttlMs: 30_000, key: () => 'k' })(
      async (): Promise<HttpResponse> => {
        calls++;
        // A fixture: long enough that the second request joins the flight.
        await sleep(10);
        return { status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([calls])); c.close(); } }) };
      },
    );
    const [first, second] = await Promise.all([handler(request()), handler(request())]);
    expect(first.body).toBeInstanceOf(ReadableStream);
    expect(second.body).not.toBe(first.body);
    expect(calls).toBe(2);
    expect((await cache.get('rsp:k')).isSome()).toBe(false);
  });

  test('an entry stored before these rules carrying Set-Cookie is not served', async () => {
    const cache = new InMemoryCache();
    await cache.set('rsp:k', { status: 200, headers: { 'set-cookie': 'session=alice' }, body: { user: 'alice' } });
    let calls = 0;
    const handler = cached({ cache, ttlMs: 30_000, key: () => 'k' })(
      () => { calls++; return completeJson(Status.OK, { user: 'fresh' }); },
    );
    const response = await handler(request());
    expect(response.body).toEqual({ user: 'fresh' });
    expect(calls).toBe(1);
  });

  test('an entry stored before these rules carrying Vary but no recorded values is not served', async () => {
    const cache = new InMemoryCache();
    await cache.set('rsp:k', { status: 200, headers: { Vary: 'Authorization' }, body: { user: 'alice' } });
    let calls = 0;
    const handler = cached({ cache, ttlMs: 30_000, key: () => 'k' })(
      () => { calls++; return completeJson(Status.OK, { user: 'fresh' }); },
    );
    const anonymous = await handler(request());
    expect(anonymous.body).toEqual({ user: 'fresh' });
    expect(calls).toBe(1);
  });
});

describe('cached — #980 Vary', () => {
  test('a response carrying Vary is served only to a request with the same header values', async () => {
    let calls = 0;
    const handler = cached({ cache: new InMemoryCache(), ttlMs: 30_000, key: () => 'k' })(
      (r): HttpResponse => {
        calls++;
        return { status: 200, headers: { Vary: 'Accept-Language' }, body: { language: r.headers['accept-language'] ?? null } };
      },
    );
    await handler(request({ headers: { 'accept-language': 'de' } }));
    const germanAgain = await handler(request({ headers: { 'accept-language': 'de' } }));
    expect(germanAgain.body).toEqual({ language: 'de' });
    expect(calls).toBe(1);

    const english = await handler(request({ headers: { 'accept-language': 'en' } }));
    expect(english.body).toEqual({ language: 'en' });
    // An absent header is a value of its own, not a wildcard.
    const none = await handler(request());
    expect(none.body).toEqual({ language: null });
    expect(calls).toBe(3);
  });

  test('a waiting request with different varied values runs the handler itself', async () => {
    let calls = 0;
    const handler = cached({ cache: new InMemoryCache(), ttlMs: 30_000, key: () => 'k' })(
      async (r): Promise<HttpResponse> => {
        calls++;
        // A fixture: long enough that the other two requests join the flight.
        await sleep(10);
        return { status: 200, headers: { vary: 'accept-language' }, body: { language: r.headers['accept-language'] } };
      },
    );
    const [german, english, germanToo] = await Promise.all([
      handler(request({ headers: { 'accept-language': 'de' } })),
      handler(request({ headers: { 'accept-language': 'en' } })),
      handler(request({ headers: { 'accept-language': 'de' } })),
    ]);
    expect(german.body).toEqual({ language: 'de' });
    expect(english.body).toEqual({ language: 'en' });
    expect(germanToo.body).toEqual({ language: 'de' });
    expect(calls).toBe(2);
  });

  test('varied credential values are stored as digests, never as the token or cookie itself', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({ cache, ttlMs: 30_000, key: (r) => r.path, identity: () => 'public' })(
      (): HttpResponse => { calls++; return { status: 200, headers: { vary: 'Authorization, Cookie' }, body: { n: calls } }; },
    );
    const token = 'Bearer eyJ-secret-token-1234';
    const sessionCookie = 'session=s3cr3t-session-id';
    await handler(request({ path: '/a', headers: { authorization: token, cookie: sessionCookie } }));

    const stored = await cache.get<{ vary?: ReadonlyArray<{ name: string }> }>('rsp:public:/a');
    expect(stored.isSome()).toBe(true);
    const entry = stored.isSome() ? stored.value : undefined;
    // The varied headers are still recorded — the digest replaces the value, not the rule.
    expect(entry?.vary?.map(({ name }) => name)).toEqual(['authorization', 'cookie']);
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('eyJ-secret-token-1234');
    expect(serialized).not.toContain('s3cr3t-session-id');

    // Matching still works on the digest: the same credentials hit, different ones miss.
    const same = await handler(request({ path: '/a', headers: { authorization: token, cookie: sessionCookie } }));
    expect(same.body).toEqual({ n: 1 });
    const otherToken = await handler(request({ path: '/a', headers: { authorization: 'Bearer other', cookie: sessionCookie } }));
    expect(otherToken.body).toEqual({ n: 2 });
    expect(calls).toBe(2);

    // An absent header and an empty one are still different requests.
    await handler(request({ path: '/b', headers: { authorization: token } }));
    const emptyCookie = await handler(request({ path: '/b', headers: { authorization: token, cookie: '' } }));
    expect(emptyCookie.body).toEqual({ n: 4 });
    expect(calls).toBe(4);
  });
});

describe('cached — #980 methods', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
    test(`${method} is neither served from nor stored in the cache`, async () => {
      const cache = new InMemoryCache();
      let calls = 0;
      const handler = cached({ cache, ttlMs: 30_000, key: () => 'k' })(
        () => { calls++; return completeJson(Status.OK, { n: calls }); },
      );
      await handler(request());                       // a GET entry exists
      const response = await handler(request({ method }));
      expect(response.body).toEqual({ n: 2 });
      await handler(request({ method }));
      expect(calls).toBe(3);
    });
  }

  test('HEAD is answered from a GET entry but never stores one', async () => {
    const cache = new InMemoryCache();
    let calls = 0;
    const handler = cached({ cache, ttlMs: 30_000, key: () => 'k' })(
      // Answers HEAD without a body, as the static-file handler does.
      (r) => { calls++; return completeJson(Status.OK, r.method === 'HEAD' ? null : { n: calls }); },
    );
    await handler(request({ method: 'HEAD' }));
    expect((await cache.get('rsp:k')).isSome()).toBe(false);
    const get = await handler(request());
    expect(get.body).toEqual({ n: 2 });
    const head = await handler(request({ method: 'HEAD' }));
    expect(head.body).toEqual({ n: 2 });
    expect(calls).toBe(2);
  });
});
