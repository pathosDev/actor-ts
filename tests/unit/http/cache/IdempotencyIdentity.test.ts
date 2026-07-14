import { describe, expect, test } from 'bun:test';
import { InMemoryCache } from '../../../../src/cache/InMemoryCache.js';
import { idempotent } from '../../../../src/http/cache/IdempotencyKey.js';
import { complete } from '../../../../src/http/Route.js';
import { Status, type HttpRequest } from '../../../../src/http/types.js';

const req = (account: string, key = 'k1'): HttpRequest => ({
  method: 'POST', path: '/me/export',
  headers: { 'idempotency-key': key, 'x-account': account },
  query: {}, params: {}, body: null,
});

// security audit HTTP-4 — an `identity` scope folds the caller into the
// cache key so a cached, identity-specific response is never replayed to a
// different caller who reuses the same key + body.
describe('idempotent — identity scoping (HTTP-4)', () => {
  const withIdentity = (cache: InMemoryCache) => idempotent({
    cache,
    identity: (r) => r.headers['x-account'] ?? 'anon',
  });

  test('same key + body, different identity → each caller gets its OWN response', async () => {
    const cache = new InMemoryCache();
    const handler = withIdentity(cache)((r) => complete(Status.OK, { who: r.headers['x-account'] }));
    const alice = await handler(req('alice'));
    const bob = await handler(req('bob'));   // SAME idempotency-key 'k1'
    expect(alice.body).toEqual({ who: 'alice' });
    expect(bob.body).toEqual({ who: 'bob' });   // NOT alice's cached response
  });

  test('same identity + key still replays (idempotency preserved)', async () => {
    const cache = new InMemoryCache();
    let invocations = 0;
    const handler = withIdentity(cache)(() => { invocations++; return complete(Status.OK, { n: invocations }); });
    const first = await handler(req('alice'));
    const second = await handler(req('alice'));
    expect(second.body).toEqual(first.body);
    expect(invocations).toBe(1);
  });

  test('without identity, the shared entry is reused across callers (documented default)', async () => {
    const cache = new InMemoryCache();
    const handler = idempotent({ cache })((r) => complete(Status.OK, { who: r.headers['x-account'] }));
    await handler(req('alice'));
    const bob = await handler(req('bob'));   // same key + body, no identity scope
    expect(bob.body).toEqual({ who: 'alice' });   // bob replays alice's response
  });
});
