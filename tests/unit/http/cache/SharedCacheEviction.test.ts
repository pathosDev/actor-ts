/**
 * security audit HTTP-8 — attacker-controlled cache-key flood evicts
 * rate-limit counters and idempotency records (#607), and what #1080's
 * eviction policy did and did not fix about it.
 *
 * `rateLimit`, `cached` and `idempotent` all take a `Cache`, and the
 * obvious wiring hands all three the same instance.  `InMemoryCache` is
 * LRU-bounded, and eviction used to pick purely on recency, so a caller
 * who could mint distinct keys through ANY of the three pushed the
 * others' state out — silently, well inside its TTL.
 *
 * #1080 changed the policy: a `setIfAbsent` claim and an `incr` counter
 * with a finite TTL carry a guarantee, a `set` does not, and eviction
 * drains the guarantee-free entries first.  Both of this file's original
 * headline victims are on the protected side of that line — the counter
 * because `incr` created it, the completed idempotency record because it
 * overwrites a live claim and inherits it — so the two `shared instance`
 * cases below now assert that the flood no longer reaches them.  They are
 * REGRESSION tests, and reverting the policy turns both red.
 *
 * What has NOT changed is the reason the middleware pages still say to
 * give each consumer its own cache, and the last two blocks are the
 * CHARACTERISATION of that residual:
 *
 *   - The policy does not rank guarantees against each other.  Two
 *     guarantee-carrying consumers sharing one instance still evict each
 *     other, because once the map holds nothing cheaper there is nothing
 *     cheaper to drop.
 *   - `idempotent`'s own key space is attacker-controlled, so a flood
 *     through the SAME middleware still evicts another caller's record.
 *
 * Deliberately NOT covered here: per-prefix quotas, which would rank one
 * consumer's guarantee above another's.  That is #607's remaining half.
 */
import { describe, expect, test } from 'bun:test';
import { InMemoryCache } from '../../../../src/cache/InMemoryCache.js';
import { cached } from '../../../../src/http/cache/ResponseCache.js';
import { idempotent } from '../../../../src/http/cache/IdempotencyKey.js';
import { rateLimit } from '../../../../src/http/cache/RateLimit.js';
import { complete } from '../../../../src/http/Route.js';
import { Status, type HttpRequest, type HttpResponse } from '../../../../src/http/Types.js';

/** Small enough that a handful of minted keys turns the whole map over. */
const MAX_ENTRIES = 4;
/** Comfortably past `MAX_ENTRIES` so the eviction is not order-sensitive. */
const FLOOD_SIZE = 20;

function makeRequest(
  headers: Record<string, string> = {},
  path = '/payments',
  remoteAddress = '198.51.100.7',
): HttpRequest {
  return { method: 'POST', path, headers, query: {}, params: {}, body: null, remoteAddress };
}

function newCache(): InMemoryCache {
  return new InMemoryCache({ maxEntries: MAX_ENTRIES, cleanupMs: 0 });
}

/**
 * The attacker's endpoint: a response cache whose key comes straight
 * from the request path, so every request mints a fresh `rsp:` entry.
 * This is the ordinary documented usage — nothing exotic is required to
 * produce the flood.
 */
function floodHandler(cache: InMemoryCache): (request: HttpRequest) => Promise<HttpResponse> {
  return cached({
    cache,
    ttlMs: 60_000,
    key: (request) => request.path,
  })(() => complete(Status.OK, { ok: true }));
}

async function flood(cache: InMemoryCache): Promise<void> {
  const handler = floodHandler(cache);
  for (let i = 0; i < FLOOD_SIZE; i++) await handler(makeRequest({}, `/public/${i}`));
}

describe('shared cache — an idempotency record survives a response-cache key flood', () => {
  test('shared instance: the flood no longer reaches the record and the honest retry replays', async () => {
    const shared = newCache();
    let charges = 0;
    const pay = idempotent({ cache: shared })(() => {
      charges++;
      return complete(Status.OK, { charge: charges });
    });

    const first = await pay(makeRequest({ 'idempotency-key': 'pay-1' }));
    expect(first.status).toBe(Status.OK);
    expect(charges).toBe(1);

    await flood(shared);

    // The client's honest retry — same key, same request in every part.
    // Before #1080 this was a double charge: the record had been evicted
    // by `cached()`'s minted keys, well inside its 24 h TTL.
    const retry = await pay(makeRequest({ 'idempotency-key': 'pay-1' }));
    expect(retry.status).toBe(Status.OK);
    expect(charges).toBe(1);              // handler NOT re-run
    expect(retry.body).toEqual({ charge: 1 });   // the FIRST response, replayed

    await shared.close();
  });

  test('separate instances: the same flood leaves the record intact and the retry replays', async () => {
    const idempotencyCache = newCache();
    const responseCache = newCache();
    let charges = 0;
    const pay = idempotent({ cache: idempotencyCache })(() => {
      charges++;
      return complete(Status.OK, { charge: charges });
    });

    const first = await pay(makeRequest({ 'idempotency-key': 'pay-1' }));
    expect(first.status).toBe(Status.OK);

    await flood(responseCache);

    const retry = await pay(makeRequest({ 'idempotency-key': 'pay-1' }));
    expect(retry.status).toBe(Status.OK);
    expect(charges).toBe(1);              // handler NOT re-run
    expect(retry.body).toEqual({ charge: 1 });   // the FIRST response, replayed

    await idempotencyCache.close();
    await responseCache.close();
  });
});

describe('shared cache — another client\'s rate-limit counter survives a key flood', () => {
  /** `max: 2` → the third request in a window is the first 429. */
  function limiterOver(cache: InMemoryCache): (request: HttpRequest) => Promise<HttpResponse> {
    return rateLimit({
      cache,
      windowMs: 60_000,
      max: 2,
      key: (request) => request.remoteAddress ?? 'unknown',
    })(() => complete(Status.OK, { ok: true }));
  }

  test('shared instance: the victim\'s counter survives, so their limit still bites', async () => {
    const shared = newCache();
    const limited = limiterOver(shared);
    const victim = makeRequest({}, '/api', '203.0.113.9');

    expect((await limited(victim)).status).toBe(Status.OK);   // count 1

    await flood(shared);

    // Before #1080 the counter was gone here and the window silently
    // restarted at 1, so this pair read OK/OK and the limit never bit.
    expect((await limited(victim)).status).toBe(Status.OK);            // count 2
    expect((await limited(victim)).status).toBe(Status.TooManyRequests);  // count 3 → limited
    await shared.close();
  });

  test('separate instances: the counter survives the flood and the third request is 429', async () => {
    const limiterCache = newCache();
    const responseCache = newCache();
    const limited = limiterOver(limiterCache);
    const victim = makeRequest({}, '/api', '203.0.113.9');

    expect((await limited(victim)).status).toBe(Status.OK);   // count 1

    await flood(responseCache);

    expect((await limited(victim)).status).toBe(Status.OK);            // count 2
    expect((await limited(victim)).status).toBe(Status.TooManyRequests);  // count 3 → limited

    await limiterCache.close();
    await responseCache.close();
  });

  /**
   * The issue body claimed a flood also resets the FLOODER's own limit
   * (429 back to 200).  It does not, and the distinction matters for
   * anyone reasoning about the exposure: `incr` bumps the counter to
   * most-recently-used on every request, so a flood that travels
   * through the limiter can never evict its own counter.  Only OTHER
   * clients' counters are reachable.  Pinned so the JSDoc's claim that
   * "the flooder's own counter is safe from this" stays true.
   */
  test('the flooder cannot reset its own counter by flooding through the limiter', async () => {
    const shared = newCache();
    const limited = rateLimit({
      cache: shared,
      windowMs: 60_000,
      max: 2,
      key: (request) => request.remoteAddress ?? 'unknown',
    })(floodHandler(shared));

    const statuses: number[] = [];
    for (let i = 0; i < FLOOD_SIZE; i++) {
      statuses.push((await limited(makeRequest({}, `/public/${i}`, '192.0.2.5'))).status);
    }

    expect(statuses.slice(0, 2)).toEqual([Status.OK, Status.OK]);
    expect(statuses.slice(2).every((s) => s === Status.TooManyRequests)).toBe(true);

    await shared.close();
  });
});

describe('shared cache — the policy does not rank one guarantee above another', () => {
  /**
   * The reason "give each middleware its own cache" survives #1080 as
   * advice.  Preferring guarantee-free victims only helps while the map
   * still holds some: two guarantee-carrying consumers on one instance run
   * out of cheap victims and then evict each other on recency, exactly as
   * before.  A caller with an IPv6 `/64` mints rate-limit counters all
   * day, and every one of them is a counter the policy protects.
   *
   * Ranking one consumer's guarantee above another's is per-prefix quotas
   * — #607's remaining half — and this test is what it would flip.
   */
  test('a flood of rate-limit counters still evicts an idempotency record from the same instance', async () => {
    const shared = newCache();
    let charges = 0;
    const pay = idempotent({ cache: shared })(() => {
      charges++;
      return complete(Status.OK, { charge: charges });
    });
    // `max` far above the flood, so no request is ever short-circuited and
    // every one of them mints a counter.
    const limited = rateLimit({
      cache: shared,
      windowMs: 60_000,
      max: 1_000,
      key: (request) => request.remoteAddress ?? 'unknown',
    })(() => complete(Status.OK, { ok: true }));

    await pay(makeRequest({ 'idempotency-key': 'pay-1' }));
    expect(charges).toBe(1);

    for (let i = 0; i < FLOOD_SIZE; i++) {
      expect((await limited(makeRequest({}, '/api', `2001:db8::${i}`))).status).toBe(Status.OK);
    }

    const retry = await pay(makeRequest({ 'idempotency-key': 'pay-1' }));
    expect(retry.status).toBe(Status.OK);
    expect(charges).toBe(2);              // DOUBLE CHARGE — the record went anyway
    expect(retry.body).toEqual({ charge: 2 });

    await shared.close();
  });
});

describe('shared cache — the idempotency key space is itself a flood vector', () => {
  /**
   * Naming a separate cache narrows the blast radius; it does not
   * remove it.  `Idempotency-Key` is client-chosen, so a caller floods
   * the idempotency cache directly and evicts OTHER callers' records
   * out of it.  `maxKeyLength` bounds how big each minted key is, not
   * how many there are — which is exactly why the docs tell you to size
   * `maxEntries` for the key space and to use Redis where the guarantee
   * has to hold against an adversary.
   */
  test('a flood of distinct Idempotency-Keys evicts another caller\'s record from the same cache', async () => {
    const idempotencyCache = newCache();
    let charges = 0;
    const pay = idempotent({ cache: idempotencyCache })(() => {
      charges++;
      return complete(Status.OK, { charge: charges });
    });

    await pay(makeRequest({ 'idempotency-key': 'victim-key' }));
    expect(charges).toBe(1);

    for (let i = 0; i < FLOOD_SIZE; i++) {
      await pay(makeRequest({ 'idempotency-key': `attacker-${i}` }));
    }

    const retry = await pay(makeRequest({ 'idempotency-key': 'victim-key' }));
    expect(retry.status).toBe(Status.OK);
    expect(charges).toBe(FLOOD_SIZE + 2);   // the victim's handler ran a second time

    await idempotencyCache.close();
  });

  test('the key cap bounds what one minted key costs the shared map', async () => {
    const idempotencyCache = newCache();
    const pay = idempotent({ cache: idempotencyCache })(() => complete(Status.OK, { ok: true }));

    const oversized = await pay(makeRequest({ 'idempotency-key': 'k'.repeat(8 * 1024) }));
    expect(oversized.status).toBe(Status.BadRequest);
    expect(idempotencyCache.sizeForTest()).toBe(0);   // never reached the cache

    await idempotencyCache.close();
  });
});
