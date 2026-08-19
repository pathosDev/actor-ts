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
 *   - And that residual reaches the FLOODER's own rate-limit counter as
 *     soon as the flood does not travel through the limiter, which the
 *     middleware JSDoc used to deny without qualification.  The last two
 *     tests of the rate-limit block are the two halves of the corrected
 *     claim (#607).
 *
 * Deliberately NOT covered here: per-prefix quotas, which would rank one
 * consumer's guarantee above another's.  Nothing in #607 or #1080 decided
 * that, and it needs a public `Cache` API decision (a per-write priority,
 * or a cap the cache enforces per key prefix) rather than a tweak to
 * `evictIfNeeded`; the three characterisation tests below are what it
 * would flip.
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
   * The flooder's own counter, in the two wirings that decide its fate.
   * The middleware JSDoc used to claim immunity without qualification —
   * "`incr` bumps it to most-recently-used on every request, so it is
   * never the victim" — and one of these two reproduces the opposite, so
   * the pair is what the corrected claim rests on (#607).
   *
   * `max` is deliberately set *above* the flood in the immune case.  With
   * `max` below it the limiter short-circuits from the third request on,
   * the flood mints two response-cache entries instead of twenty, the map
   * never reaches its cap, and the test passes without a single eviction
   * having run — asserting the 429s rather than the invariant behind them.
   */
  test('a flood THROUGH the limiter cannot evict its own counter', async () => {
    const shared = newCache();
    // `max` == the flood, so every flooding request passes (each one mints
    // an `rsp:` key AND bumps the counter) and the next one is the first 429.
    const limited = rateLimit({
      cache: shared,
      windowMs: 60_000,
      max: FLOOD_SIZE,
      key: (request) => request.remoteAddress ?? 'unknown',
    })(floodHandler(shared));

    const statuses: number[] = [];
    for (let i = 0; i < FLOOD_SIZE; i++) {
      statuses.push((await limited(makeRequest({}, `/public/${i}`, '192.0.2.5'))).status);
    }
    expect(statuses.every((s) => s === Status.OK)).toBe(true);
    // The flood really did turn the map over — otherwise no eviction ran and
    // the assertion below would hold for the wrong reason.
    expect(shared.sizeForTest()).toBe(MAX_ENTRIES);

    // Counter never lost: the (FLOOD_SIZE + 1)-th request is over `max`.
    // Had it been evicted mid-flood, the window would have restarted and
    // this would be another 200.
    expect((await limited(makeRequest({}, '/public/x', '192.0.2.5'))).status)
      .toBe(Status.TooManyRequests);

    await shared.close();
  });

  /**
   * The correction.  Immunity comes from the `incr` bump, and the bump
   * only happens on a request the limiter *wraps* — `rateLimit` calls
   * `incr` in exactly one place, inside `limited`.  A key-minting route on
   * the same `Cache` that the limiter does not wrap therefore ages the
   * flooder's counter like anybody else's, and it is then reachable.
   *
   * The flood has to carry a guarantee of its own for that to bite, which
   * is why this uses `idempotent` and not `cached`: since #1080 a `cached`
   * flood is opportunistic and drained first, so the same wiring with
   * `cached` leaves the counter alone (verified — it answers 429 after the
   * flood).  A flood of `idempotent` claims empties the opportunistic half
   * and then takes the least-recently-used guarantee, which is the counter
   * nobody has bumped.
   */
  test('a flood BYPASSING the limiter resets the flooder\'s own counter', async () => {
    const shared = newCache();
    const limited = rateLimit({
      cache: shared,
      windowMs: 60_000,
      max: 2,
      key: (request) => request.remoteAddress ?? 'unknown',
    })(() => complete(Status.OK, { ok: true }));
    // The off-limiter endpoint: same client, same shared cache, no limiter
    // in front of it — the shape the "one shared ext.cache()" wiring produces.
    const pay = idempotent({ cache: shared })(() => complete(Status.OK, { ok: true }));

    const attacker = makeRequest({}, '/api', '192.0.2.5');
    expect((await limited(attacker)).status).toBe(Status.OK);                  // count 1
    expect((await limited(attacker)).status).toBe(Status.OK);                  // count 2
    expect((await limited(attacker)).status).toBe(Status.TooManyRequests);     // count 3 → limited

    for (let i = 0; i < FLOOD_SIZE; i++) {
      await pay(makeRequest({ 'idempotency-key': `flood-${i}` }));
    }

    // SELF-RESET: the counter is gone, so the window restarts at 1.
    expect((await limited(attacker)).status).toBe(Status.OK);

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
   * Ranking one consumer's guarantee above another's is per-prefix quotas,
   * which nothing has decided, and this test is what it would flip.
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
