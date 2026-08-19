import { describe, expect, test } from 'bun:test';
import { InMemoryCache } from '../../../../src/cache/InMemoryCache.js';
import { idempotent } from '../../../../src/http/cache/IdempotencyKey.js';
import { complete } from '../../../../src/http/Route.js';
import { Status, type HttpRequest } from '../../../../src/http/Types.js';

const request = (account: string, key = 'k1'): HttpRequest => ({
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
    const alice = await handler(request('alice'));
    const bob = await handler(request('bob'));   // SAME idempotency-key 'k1'
    expect(alice.body).toEqual({ who: 'alice' });
    expect(bob.body).toEqual({ who: 'bob' });   // NOT alice's cached response
  });

  test('same identity + key still replays (idempotency preserved)', async () => {
    const cache = new InMemoryCache();
    let invocations = 0;
    const handler = withIdentity(cache)(() => { invocations++; return complete(Status.OK, { n: invocations }); });
    const first = await handler(request('alice'));
    const second = await handler(request('alice'));
    expect(second.body).toEqual(first.body);
    expect(invocations).toBe(1);
  });

  test('without identity, the shared entry is reused across callers (documented default)', async () => {
    const cache = new InMemoryCache();
    const handler = idempotent({ cache })((r) => complete(Status.OK, { who: r.headers['x-account'] }));
    await handler(request('alice'));
    const bob = await handler(request('bob'));   // same key + body, no identity scope
    expect(bob.body).toEqual({ who: 'alice' });   // bob replays alice's response
  });
});

/**
 * The scope is the other half of the composed cache key, and it used to be
 * the unbounded half (#607).  `maxKeyLength` ran on the header value alone;
 * four lines later the scope was concatenated in with no check, and
 * `identity`'s own documented recipe reads a raw client header — so a
 * request with a two-character `Idempotency-Key` and a 64 KiB `x-account`
 * was accepted with 200 and stored a 64 KiB key under a middleware whose
 * documented cap is 255 characters.
 *
 * The two rules are the header's, applied to the scope: a length bound and
 * no ASCII control character or space.  Both matter for the same reason —
 * whichever half is weaker is the one an attacker uses.
 */
describe('idempotent — the identity scope is bounded too (#607)', () => {
  /** How large a scope an attacker would send if nothing checked it. */
  const OVERSIZED_SCOPE = 'A'.repeat(64 * 1024);

  test('an oversized scope is refused with 400 and nothing is stored', async () => {
    const cache = new InMemoryCache();
    const handler = idempotent({
      cache,
      identity: (r) => r.headers['x-account'] ?? 'anon',
    })(() => complete(Status.OK, { ok: true }));

    const response = await handler(request(OVERSIZED_SCOPE));
    expect(response.status).toBe(Status.BadRequest);
    expect(cache.sizeForTest()).toBe(0);          // never reached the cache
    await cache.close();
  });

  test('the rejection names the limit without echoing the scope back', async () => {
    const cache = new InMemoryCache();
    const handler = idempotent({
      cache,
      identity: (r) => r.headers['x-account'] ?? 'anon',
    })(() => complete(Status.OK, { ok: true }));

    const response = await handler(request(OVERSIZED_SCOPE));
    const error = (response.body as { error: string }).error;
    expect(error).toContain('255-character limit');
    expect(error).not.toContain('AAAA');          // reflecting it is the payload
    await cache.close();
  });

  test('a scope with a control character or space is refused with 400', async () => {
    const cache = new InMemoryCache();
    const handler = idempotent({
      cache,
      identity: (r) => r.headers['x-account'] ?? 'anon',
    })(() => complete(Status.OK, { ok: true }));

    // A space and a CR: Memcached command delimiters, and the classic
    // header-injection byte.  The header value is refused for both already.
    expect((await handler(request('tenant a'))).status).toBe(Status.BadRequest);
    expect((await handler(request('tenant\ra'))).status).toBe(Status.BadRequest);
    expect(cache.sizeForTest()).toBe(0);
    await cache.close();
  });

  test('maxScopeLength moves the bound, and a scope inside it still works', async () => {
    const cache = new InMemoryCache();
    const handler = idempotent({
      cache,
      maxScopeLength: 8,
      identity: (r) => r.headers['x-account'] ?? 'anon',
    })(() => complete(Status.OK, { ok: true }));

    expect((await handler(request('12345678'))).status).toBe(Status.OK);
    expect((await handler(request('123456789'))).status).toBe(Status.BadRequest);
    await cache.close();
  });

  test('the header keeps its own budget — a long scope does not spend it', async () => {
    const cache = new InMemoryCache();
    const handler = idempotent({
      cache,
      identity: (r) => r.headers['x-account'] ?? 'anon',
    })(() => complete(Status.OK, { ok: true }));

    // 255 + 255, both at their cap: one cap over the composed key would
    // reject this, and the header cap is Stripe's published 255.
    const response = await handler(request('t'.repeat(255), 'k'.repeat(255)));
    expect(response.status).toBe(Status.OK);
    await cache.close();
  });

  test('no identity configured means no scope to check (unchanged behaviour)', async () => {
    const cache = new InMemoryCache();
    const handler = idempotent({ cache })(() => complete(Status.OK, { ok: true }));
    expect((await handler(request('irrelevant'))).status).toBe(Status.OK);
    await cache.close();
  });
});
