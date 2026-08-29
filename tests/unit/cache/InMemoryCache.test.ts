import { describe, expect, test } from 'bun:test';
import { acquireLock } from '../../../src/cache/CacheLock.js';
import { InMemoryCache } from '../../../src/cache/InMemoryCache.js';
import { DEFAULT_MAX_ENTRIES, InMemoryCacheOptions } from '../../../src/cache/InMemoryCacheOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';
import { runCacheContractTests } from './_Contract.js';

// Backend-agnostic contract — every Cache impl must pass these.
// The InMemoryCache-specific tests below cover additional behaviour
// not in the contract (sizeForTest, multi-tenant prefixing, etc.).
describe('InMemoryCache — contract', () => {
  runCacheContractTests({
    name: 'InMemoryCache',
    factory: async () => new InMemoryCache(),
  });
});

describe('InMemoryCache — get/set round-trip', () => {
  test('set then get returns the value', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', { hello: 'world' });
    const result = await cache.get<{ hello: string }>('k');
    expect(result.toNullable()).toEqual({ hello: 'world' });
  });

  test('get on missing key returns None', async () => {
    const cache = new InMemoryCache();
    expect((await cache.get('absent')).isNone()).toBe(true);
  });

  test('set with TTL expires after the TTL elapses', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', 'temp', 30);
    expect((await cache.get('k')).toNullable()).toBe('temp');
    // The elapsed time IS the assertion: 50 ms has to outlast the 30 ms TTL,
    // and expiry is lazy, so there is no event to poll for.
    await sleep(50);
    expect((await cache.get('k')).isNone()).toBe(true);
  });

  test('set without TTL never expires', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', 1);
    // An absence: an entry written without a TTL must still be there afterwards,
    // which is already true at t = 0 and has to survive a real window.
    await sleep(20);
    expect((await cache.get('k')).toNullable()).toBe(1);
  });

  test('set rejects non-positive TTL', async () => {
    const cache = new InMemoryCache();
    await expect(cache.set('k', 1, 0)).rejects.toThrow();
    await expect(cache.set('k', 1, -5)).rejects.toThrow();
  });
});

describe('InMemoryCache — incr', () => {
  test('first incr seeds counter at 1, subsequent calls increase', async () => {
    const cache = new InMemoryCache();
    expect(await cache.incr('counter')).toBe(1);
    expect(await cache.incr('counter')).toBe(2);
    expect(await cache.incr('counter')).toBe(3);
  });

  test('TTL applies only on creation, not on subsequent increments', async () => {
    const cache = new InMemoryCache();
    expect(await cache.incr('rate', 50)).toBe(1);
    // Half the 50 ms TTL: the increment below has to land while the entry is
    // still alive, so the elapsed time is what positions it.
    await sleep(20);
    expect(await cache.incr('rate', 50)).toBe(2);  // ttlMs ignored on existing key
    await sleep(40);  // total ~60ms, original TTL=50 should have expired by now
    expect(await cache.incr('rate', 50)).toBe(1);  // counter reset
  });

  test('incr on a non-numeric key throws', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', 'a string');
    await expect(cache.incr('k')).rejects.toThrow();
  });
});

describe('InMemoryCache — setIfAbsent', () => {
  test('returns true on first call, false on subsequent', async () => {
    const cache = new InMemoryCache();
    expect(await cache.setIfAbsent('k', 'v1')).toBe(true);
    expect(await cache.setIfAbsent('k', 'v2')).toBe(false);
    expect((await cache.get('k')).toNullable()).toBe('v1');
  });

  test('after expiry, setIfAbsent succeeds again', async () => {
    const cache = new InMemoryCache();
    expect(await cache.setIfAbsent('k', 'v1', 30)).toBe(true);
    // The elapsed time IS the assertion: 50 ms outlasts the 30 ms TTL, which is
    // what makes the key absent again for the second `setIfAbsent`.
    await sleep(50);
    expect(await cache.setIfAbsent('k', 'v2', 30)).toBe(true);
    expect((await cache.get('k')).toNullable()).toBe('v2');
  });
});

describe('InMemoryCache — delete', () => {
  test('delete removes a single key', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', 1);
    await cache.delete('k');
    expect((await cache.get('k')).isNone()).toBe(true);
  });

  test('delete is variadic and idempotent', async () => {
    const cache = new InMemoryCache();
    await cache.set('a', 1); await cache.set('b', 2);
    await cache.delete('a', 'b', 'c');
    expect((await cache.get('a')).isNone()).toBe(true);
    expect((await cache.get('b')).isNone()).toBe(true);
  });
});

describe('InMemoryCache — close', () => {
  test('close clears the cache', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', 1);
    await cache.close();
    expect(cache.sizeForTest()).toBe(0);
  });
});

describe('InMemoryCache — mget / mset (#14)', () => {
  test('mget returns a Map of hits; misses are absent', async () => {
    const cache = new InMemoryCache();
    await cache.set('a', 1);
    await cache.set('b', 'two');
    const got = await cache.mget<unknown>(['a', 'b', 'missing']);
    expect(got.size).toBe(2);
    expect(got.get('a')).toBe(1);
    expect(got.get('b')).toBe('two');
    expect(got.has('missing')).toBe(false);
  });

  test('mget on an empty input array returns an empty Map', async () => {
    const cache = new InMemoryCache();
    const got = await cache.mget([]);
    expect(got.size).toBe(0);
  });

  test('mget lazily expires entries — same semantics as single-key `get`', async () => {
    const cache = new InMemoryCache();
    await cache.set('a', 1, 10);  // 10 ms TTL
    await cache.set('b', 2);      // no TTL
    // The elapsed time IS the assertion: 20 ms outlasts `a`'s 10 ms TTL while
    // `b`, written without one, must survive.
    await new Promise((r) => setTimeout(r, 20));
    const got = await cache.mget(['a', 'b']);
    expect(got.has('a')).toBe(false);
    expect(got.get('b')).toBe(2);
  });

  test('mset writes every entry with the shared TTL', async () => {
    const cache = new InMemoryCache();
    await cache.mset(new Map([['a', 1], ['b', 2], ['c', 3]] as const), 50);
    expect((await cache.get('a')).getOrElse(0)).toBe(1);
    expect((await cache.get('b')).getOrElse(0)).toBe(2);
    expect((await cache.get('c')).getOrElse(0)).toBe(3);
    // After the TTL all three expire together.
    await new Promise((r) => setTimeout(r, 70));
    expect((await cache.mget(['a', 'b', 'c'])).size).toBe(0);
  });

  test('mset with no TTL persists indefinitely', async () => {
    const cache = new InMemoryCache();
    await cache.mset(new Map([['a', 1], ['b', 2]] as const));
    // An absence: entries written without a TTL must still be there, which is
    // already true at t = 0 and has to survive a real window.
    await new Promise((r) => setTimeout(r, 20));
    expect((await cache.mget(['a', 'b'])).size).toBe(2);
  });

  test('mset rejects bogus ttlMs', async () => {
    const cache = new InMemoryCache();
    await expect(cache.mset(new Map([['a', 1]]), 0)).rejects.toThrow(/ttlMs/);
    await expect(cache.mset(new Map([['a', 1]]), -1)).rejects.toThrow(/ttlMs/);
  });

  test('mset on an empty Map is a no-op', async () => {
    const cache = new InMemoryCache();
    await cache.mset(new Map());
    expect(cache.sizeForTest()).toBe(0);
  });
});

// security audit HTTP-2 — the cache was an unbounded Map (lazy-expiry
// only, no cap), so a flood of distinct attacker-chosen keys (idempotency /
// rate-limit) grew it without limit → RAM DoS.  It is now LRU-bounded.
describe('InMemoryCache — bounded size / LRU eviction (HTTP-2)', () => {
  test('evicts the least-recently-used entry beyond maxEntries', async () => {
    const cache = new InMemoryCache({ maxEntries: 3, cleanupMs: 0 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('c', 3);
    await cache.get('a');          // 'a' becomes most-recently-used → 'b' is LRU
    await cache.set('d', 4);       // over cap → evict LRU ('b')
    expect(cache.sizeForTest()).toBe(3);
    expect((await cache.get('b')).isNone()).toBe(true);
    expect((await cache.get('a')).toNullable()).toBe(1);
    expect((await cache.get('c')).toNullable()).toBe(3);
    expect((await cache.get('d')).toNullable()).toBe(4);
    await cache.close();
  });

  test('a flood of distinct keys stays bounded by maxEntries', async () => {
    const cache = new InMemoryCache({ maxEntries: 50, cleanupMs: 0 });
    for (let i = 0; i < 5_000; i++) await cache.set(`k${i}`, i);
    expect(cache.sizeForTest()).toBeLessThanOrEqual(50);
    await cache.close();
  });

  test('overwriting an existing key does not evict', async () => {
    const cache = new InMemoryCache({ maxEntries: 2, cleanupMs: 0 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('a', 11);      // overwrite — no growth, no eviction
    expect(cache.sizeForTest()).toBe(2);
    expect((await cache.get('a')).toNullable()).toBe(11);
    expect((await cache.get('b')).toNullable()).toBe(2);
    await cache.close();
  });

  test('incr respects the cap', async () => {
    const cache = new InMemoryCache({ maxEntries: 3, cleanupMs: 0 });
    for (let i = 0; i < 100; i++) await cache.incr(`c${i}`);
    expect(cache.sizeForTest()).toBeLessThanOrEqual(3);
    await cache.close();
  });

  test('maxEntries: Infinity opts out of eviction (documented OOM risk)', async () => {
    const cache = new InMemoryCache({ maxEntries: Infinity, cleanupMs: 0 });
    for (let i = 0; i < 500; i++) await cache.set(`k${i}`, i);
    expect(cache.sizeForTest()).toBe(500);
    await cache.close();
  });

  /**
   * security audit HTTP-8 — which operations count as a "use" decides
   * which entries survive a flood, and the docs claimed `setIfAbsent`
   * was one of them.  It is not: it returns early on a present key
   * without touching the order, so an entry that is written once and
   * never read back — an idempotency record still waiting for a retry —
   * keeps ageing towards eviction no matter how often it is probed.
   * Pinned here so the documented rule and the code cannot drift apart
   * again.
   */
  test('only reads bump: get rescues an entry, setIfAbsent and set do not', async () => {
    const probed = new InMemoryCache({ maxEntries: 3, cleanupMs: 0 });
    await probed.set('claimed', 'record');
    await probed.set('b', 2);
    await probed.set('c', 3);
    expect(await probed.setIfAbsent('claimed', 'other')).toBe(false);  // probe...
    await probed.set('claimed', 'record2');                            // ...and rewrite
    await probed.set('d', 4);       // over cap → evicts the LRU
    expect((await probed.get('claimed')).isNone()).toBe(true);         // neither rescued it

    const read = new InMemoryCache({ maxEntries: 3, cleanupMs: 0 });
    await read.set('claimed', 'record');
    await read.set('b', 2);
    await read.set('c', 3);
    expect((await read.get('claimed')).toNullable()).toBe('record');   // a read DOES bump
    await read.set('d', 4);
    expect((await read.get('claimed')).toNullable()).toBe('record');
    expect((await read.get('b')).isNone()).toBe(true);                 // 'b' went instead

    await probed.close();
    await read.close();
  });

  test('periodic sweep reclaims expired entries (cleanupMs)', async () => {
    const cache = new InMemoryCache({ maxEntries: 100, cleanupMs: 20 });
    await cache.set('temp', 1, 10);   // expires in ~10 ms
    expect(cache.sizeForTest()).toBe(1);
    await sleep(80);              // several sweep cycles (every 20 ms)
    expect(cache.sizeForTest()).toBe(0);
    await cache.close();
  });
});

/**
 * #1080 — eviction used to be blind to what an entry was for, and the price
 * was a live `acquireLock` lock handed out twice at the UNTOUCHED DEFAULT
 * configuration: `maxEntries` 10 000, a 60 s lock, then 10 000 ordinary
 * writes.  Nothing crashed, nothing overran its TTL, and the original
 * holder's `release()` returned `false` — which `CacheLock` documented as
 * "the critical section ran longer than its TTL".
 *
 * Eviction now drains the entries that carry no guarantee first.  These tests
 * bind both directions of that, because the useful part is where the line
 * sits: `setIfAbsent` claims and `incr` counters with a finite TTL are
 * protected, a plain `set` is not — protecting a `set` would protect every
 * cached response body and therefore nothing — and the `maxEntries` bound
 * itself is untouched, so HTTP-2's "a key flood cannot grow the map" still
 * holds.
 */
describe('InMemoryCache — eviction prefers entries that carry no guarantee (#1080)', () => {
  /** Comfortably past any cap used here, so eviction is not order-sensitive. */
  const FLOOD_SIZE = 20;

  /** The victim shape from the issue, at the configuration nobody changed. */
  test('a live lock survives a flood at the default cap and is not handed out twice', async () => {
    const cache = new InMemoryCache({ cleanupMs: 0 });      // maxEntries: 10 000
    const first = await acquireLock(cache, 'lock:nightly-report', 60_000);
    expect(first.isSome()).toBe(true);
    if (!first.isSome()) throw new Error('unreachable — asserted above');

    // A response cache sharing the instance: every request mints one entry.
    // Note the finite TTL — a TTL alone must not buy protection.
    for (let i = 0; i < DEFAULT_MAX_ENTRIES; i++) await cache.set(`rsp:/public/${i}`, i, 60_000);

    expect((await acquireLock(cache, 'lock:nightly-report', 60_000)).isNone()).toBe(true);
    expect(await first.value.release()).toBe(true);
    expect(cache.sizeForTest()).toBeLessThanOrEqual(DEFAULT_MAX_ENTRIES);
    await cache.close();
  });

  test('a rate-limit counter created by incr survives a flood of ordinary writes', async () => {
    const cache = new InMemoryCache({ maxEntries: 4, cleanupMs: 0 });
    expect(await cache.incr('rate:203.0.113.9', 60_000)).toBe(1);

    for (let i = 0; i < FLOOD_SIZE; i++) await cache.set(`rsp:/public/${i}`, i);

    // The window continues from 1 instead of silently restarting at it.
    expect(await cache.incr('rate:203.0.113.9', 60_000)).toBe(2);
    await cache.close();
  });

  /**
   * `idempotent` claims the key with `setIfAbsent` and then overwrites the
   * marker with the finished response through `set`.  `Map.set` on a present
   * key does not move it, so the record inherits the claim's already-aged
   * slot — it is the *first* victim at the moment it becomes worth
   * protecting.  Which is why the guarantee has to survive the overwrite.
   */
  test('a set that replaces a live claim inherits its protection', async () => {
    const cache = new InMemoryCache({ maxEntries: 4, cleanupMs: 0 });
    expect(await cache.setIfAbsent('idem:pay-1', { inFlight: true }, 60_000)).toBe(true);
    await cache.set('idem:pay-1', { charge: 1 }, 60_000);

    for (let i = 0; i < FLOOD_SIZE; i++) await cache.set(`rsp:/public/${i}`, i);

    expect((await cache.get('idem:pay-1')).toNullable()).toEqual({ charge: 1 });
    await cache.close();
  });

  test('mset inherits a live claim the same way set does', async () => {
    const cache = new InMemoryCache({ maxEntries: 4, cleanupMs: 0 });
    expect(await cache.setIfAbsent('idem:pay-1', { inFlight: true }, 60_000)).toBe(true);
    await cache.mset(new Map([['idem:pay-1', { charge: 1 }]]), 60_000);

    for (let i = 0; i < FLOOD_SIZE; i++) await cache.set(`rsp:/public/${i}`, i);

    expect((await cache.get('idem:pay-1')).toNullable()).toEqual({ charge: 1 });
    await cache.close();
  });

  /**
   * The discriminating negative.  A cached response body is a finite-TTL
   * `set`, so if `set` manufactured protection every entry would be protected
   * and the policy would decide nothing.
   */
  test('a plain set is never protected, whatever TTL it carries', async () => {
    const cache = new InMemoryCache({ maxEntries: 4, cleanupMs: 0 });
    await cache.set('rsp:/hot', 'body', 60_000);

    for (let i = 0; i < FLOOD_SIZE; i++) await cache.set(`rsp:/public/${i}`, i);

    expect((await cache.get('rsp:/hot')).isNone()).toBe(true);
    await cache.close();
  });

  /**
   * An unbounded claim is the wedge {@link Cache.setIfAbsent} warns about, and
   * protecting one would make it permanent: nothing would ever expire it, so
   * it would hold its slot until the process ended.
   */
  test('a setIfAbsent with no TTL carries no protection', async () => {
    const cache = new InMemoryCache({ maxEntries: 4, cleanupMs: 0 });
    expect(await cache.setIfAbsent('lock:forever', 'token')).toBe(true);

    for (let i = 0; i < FLOOD_SIZE; i++) await cache.set(`rsp:/public/${i}`, i);

    expect((await cache.get('lock:forever')).isNone()).toBe(true);
    await cache.close();
  });

  /** HTTP-2 non-regression: protection re-orders victims, it never grows the map. */
  test('a flood minted through setIfAbsent itself stays bounded by maxEntries', async () => {
    const cache = new InMemoryCache({ maxEntries: 50, cleanupMs: 0 });
    for (let i = 0; i < 5_000; i++) await cache.setIfAbsent(`idem:attacker-${i}`, 'claim', 60_000);
    expect(cache.sizeForTest()).toBeLessThanOrEqual(50);
    await cache.close();
  });

  /**
   * The limit of the guarantee, and the reason `maxEntries` still has to be
   * sized: once every entry in the map carries one, there is nothing cheaper
   * left to drop.  A cache holding nothing but locks is exactly that case.
   */
  test('when every entry carries a guarantee the least-recently-used one still goes', async () => {
    const cache = new InMemoryCache({ maxEntries: 3, cleanupMs: 0 });
    const oldest = await acquireLock(cache, 'lock:a', 60_000);
    if (!oldest.isSome()) throw new Error('acquire must succeed');
    for (const key of ['lock:b', 'lock:c', 'lock:d']) {
      expect((await acquireLock(cache, key, 60_000)).isSome()).toBe(true);
    }

    expect(cache.sizeForTest()).toBe(3);
    expect((await cache.get('lock:a')).isNone()).toBe(true);
    // Handed out again while the first holder still believes it is theirs —
    // this is the residual, and `release` still cannot say which cause it hit.
    expect((await acquireLock(cache, 'lock:a', 60_000)).isSome()).toBe(true);
    expect(await oldest.value.release()).toBe(false);
    await cache.close();
  });

  test('protection does not outlive the entry: a set after the claim was dropped starts unprotected', async () => {
    const cache = new InMemoryCache({ maxEntries: 4, cleanupMs: 0 });
    await cache.setIfAbsent('idem:pay-1', { inFlight: true }, 60_000);
    await cache.delete('idem:pay-1');            // the handler threw — claim released
    await cache.set('idem:pay-1', 'late write', 60_000);

    for (let i = 0; i < FLOOD_SIZE; i++) await cache.set(`rsp:/public/${i}`, i);

    expect((await cache.get('idem:pay-1')).isNone()).toBe(true);
    await cache.close();
  });

  test('a lapsed claim confers nothing on a later write to the same key', async () => {
    const cache = new InMemoryCache({ maxEntries: 4, cleanupMs: 0 });
    expect(await cache.setIfAbsent('idem:pay-1', { inFlight: true }, 1)).toBe(true);
    // `cleanupMs: 0` leaves the lapsed claim sitting in the map, which is the
    // only state this rule is about, and the elapsed time IS the precondition
    // — an expired-but-unswept entry changes no observable to poll on.
    await sleep(30);
    await cache.set('idem:pay-1', 'late write', 60_000);

    for (let i = 0; i < FLOOD_SIZE; i++) await cache.set(`rsp:/public/${i}`, i);

    expect((await cache.get('idem:pay-1')).isNone()).toBe(true);
    await cache.close();
  });

  /**
   * A protected slot has to come back when its TTL passes, or an idempotency
   * claim whose holder crashed would hold one for the whole 24 h default.
   */
  test('the periodic sweep reclaims expired entries from the protected half too', async () => {
    const cache = new InMemoryCache({ maxEntries: 100, cleanupMs: 10 });
    expect(await cache.setIfAbsent('idem:crashed', { inFlight: true }, 5)).toBe(true);
    expect(cache.sizeForTest()).toBe(1);
    await awaitCondition(() => cache.sizeForTest() === 0, {
      label: 'the sweep reclaimed the lapsed claim',
    });
    await cache.close();
  });
});

/**
 * #607 — the step #1080 left undone.  Preferring guarantee-free victims ranks
 * *what an entry is for*; it does not rank *whose entry it is*, so two
 * consumers sharing one instance still evicted each other as soon as the map
 * held nothing cheaper.  The issue's own words for the fix: "per-prefix quotas
 * so `rsp:` inserts can only evict `rsp:` entries".
 *
 * A quota is a cap and a reservation at once, and these tests bind both
 * halves, because either one alone leaves the hole open.  Cap without
 * reservation and a flood simply evicts its neighbours before it ever reaches
 * its own limit; reservation without cap and the flood grows until the map
 * does.  The prefix boundary is also deliberately *orthogonal* to #1080's
 * guarantee: it protects an ordinary `set` from another prefix just as it
 * protects a lock, because whose key space a caller can enumerate is a
 * different question from what losing an entry costs.
 *
 * The two things it does not do are asserted as firmly as the things it does:
 * `maxEntries` is still the hard cap (a configuration that reserves the whole
 * map does not get to grow it), and a quota bounds a prefix rather than a
 * caller, which is why `tests/unit/http/cache/SharedCacheEviction.test.ts`
 * still characterises a same-prefix flood as an open exposure.
 */
describe('InMemoryCache — incr adopts a counter another call seeded (#1295)', () => {
  /** Comfortably past the caps used here, so eviction is not order-sensitive. */
  const FLOOD_SIZE = 20;

  /**
   * The half an entry sits in used to be decided by the write that created it
   * and never revisited, so a window opened by anything other than `incr`
   * stayed opportunistic for its whole life however many finite-TTL `incr`
   * calls followed — evicted first under exactly the flood the two halves
   * exist to survive.  The shipped `rateLimit` always creates its counter
   * through `incr`, so this was user code and shared-cache integrations
   * rather than a live bypass of the middleware.
   */
  test('a counter seeded by set and driven by incr survives a key flood', async () => {
    const cache = new InMemoryCache({ maxEntries: 4, cleanupMs: 0 });
    await cache.set('rl:198.51.100.7', 0, 60_000);
    expect(await cache.incr('rl:198.51.100.7', 60_000)).toBe(1);

    for (let i = 0; i < FLOOD_SIZE; i++) await cache.set(`rsp:/public/${i}`, i);

    // Continues the window instead of silently restarting it.  Without the
    // adoption this reads 1 again, which is the reset the limiter is supposed
    // to make impossible.
    expect(await cache.incr('rl:198.51.100.7', 60_000)).toBe(2);
    await cache.close();
  });

  /**
   * The other direction, and the reason adoption is keyed on the *call*: `set`
   * must still never manufacture a guarantee.  #1080 refused that deliberately
   * — every cached response body is a finite-TTL `set`, so protecting those
   * would protect nothing.
   */
  test('a set-seeded counter nobody has incremented is still unprotected', async () => {
    const cache = new InMemoryCache({ maxEntries: 4, cleanupMs: 0 });
    await cache.set('rl:203.0.113.4', 0, 60_000);

    for (let i = 0; i < FLOOD_SIZE; i++) await cache.set(`rsp:/public/${i}`, i);

    expect((await cache.get('rl:203.0.113.4')).isNone()).toBe(true);
    await cache.close();
  });

  /**
   * Same reasoning as the no-TTL claim above: nothing would ever expire an
   * unbounded counter, so adopting one would pin a slot for the life of the
   * process rather than for the life of a window.
   */
  test('incr does not adopt a counter with no TTL', async () => {
    const cache = new InMemoryCache({ maxEntries: 4, cleanupMs: 0 });
    expect(await cache.incr('rl:forever')).toBe(1);
    expect(await cache.incr('rl:forever')).toBe(2);

    for (let i = 0; i < FLOOD_SIZE; i++) await cache.set(`rsp:/public/${i}`, i);

    expect((await cache.get('rl:forever')).isNone()).toBe(true);
    await cache.close();
  });

  /**
   * Guards the plausible-looking wrong fix.  Adopting through `write` alone
   * moves the key between halves but not within one, because re-inserting a
   * key a `Map` already holds does not reorder it — so an already-guaranteed
   * counter would quietly stop counting as used, and `incr` is one of the
   * three operations that must count.  Here every entry carries a guarantee,
   * so recency is the only thing left to decide the victim.
   */
  test('incr still bumps a counter that was already guaranteed', async () => {
    const cache = new InMemoryCache({ maxEntries: 3, cleanupMs: 0 });
    await cache.incr('rl:a', 60_000);
    await cache.incr('rl:b', 60_000);
    await cache.incr('rl:c', 60_000);

    await cache.incr('rl:a', 60_000);   // a is now the most recently used
    await cache.incr('rl:d', 60_000);   // needs a slot: b is the victim

    expect((await cache.get('rl:b')).isNone()).toBe(true);
    expect((await cache.get('rl:a')).isSome()).toBe(true);
    await cache.close();
  });
});

describe('InMemoryCache — per-prefix quotas (#607)', () => {
  /** Comfortably past every cap used here, so eviction is not order-sensitive. */
  const FLOOD_SIZE = 20;

  test('a flood under one prefix evicts only that prefix\'s entries', async () => {
    const cache = new InMemoryCache({
      maxEntries: 4,
      cleanupMs: 0,
      prefixQuotas: { 'rsp:': 2, 'idem:': 2 },
    });
    await cache.set('idem:pay-1', { charge: 1 }, 60_000);
    await cache.set('idem:pay-2', { charge: 2 }, 60_000);

    for (let i = 0; i < FLOOD_SIZE; i++) await cache.set(`rsp:/public/${i}`, i, 60_000);

    expect((await cache.get('idem:pay-1')).toNullable()).toEqual({ charge: 1 });
    expect((await cache.get('idem:pay-2')).toNullable()).toEqual({ charge: 2 });
    // The flood really did have to evict — otherwise the assertions above hold
    // because nothing ever reached a cap, which proves nothing.
    expect(cache.sizeOfPrefixForTest('rsp:')).toBe(2);
    await cache.close();
  });

  /**
   * The A/B that names what the quota changed.  Both caches see the identical
   * flood of guarantee-carrying claims; only the divided one keeps the
   * counter.  This is the shape behind two of the three exposures #607 was
   * left holding — a counter flood evicting an idempotency record, and an
   * off-limiter `Idempotency-Key` flood resetting the flooder's own limit.
   */
  test('a guarantee-carrying flood cannot reach another prefix\'s guarantee', async () => {
    const divided = new InMemoryCache({
      maxEntries: 4,
      cleanupMs: 0,
      prefixQuotas: { 'rl:': 2, 'idem:': 2 },
    });
    const undivided = new InMemoryCache({ maxEntries: 4, cleanupMs: 0 });

    for (const cache of [divided, undivided]) {
      expect(await cache.incr('rl:198.51.100.7', 60_000)).toBe(1);
      for (let i = 0; i < FLOOD_SIZE; i++) {
        await cache.setIfAbsent(`idem:attacker-${i}`, { inFlight: true }, 60_000);
      }
    }

    // Divided: the window continues.  Undivided: it silently restarts at 1,
    // which is the reset the issue is titled after.
    expect(await divided.incr('rl:198.51.100.7', 60_000)).toBe(2);
    expect(await undivided.incr('rl:198.51.100.7', 60_000)).toBe(1);

    await divided.close();
    await undivided.close();
  });

  /**
   * The reservation half, isolated.  `rl:a` is a plain `set` — it carries no
   * #1080 guarantee at all — and survives a flood that fills the map, purely
   * because its prefix is below its quota and that space belongs to nobody
   * else.
   */
  test('a prefix below its quota is not evicted from by another prefix\'s growth', async () => {
    const cache = new InMemoryCache({ maxEntries: 4, cleanupMs: 0, prefixQuotas: { 'rl:': 3 } });
    await cache.set('rl:a', 'counter');

    for (let i = 0; i < FLOOD_SIZE; i++) await cache.set(`k${i}`, i);

    expect((await cache.get('rl:a')).toNullable()).toBe('counter');
    expect(cache.sizeOfPrefixForTest('rl:')).toBe(1);
    expect(cache.sizeForTest()).toBe(4);
    await cache.close();
  });

  test('the longest configured prefix claims a key', async () => {
    const cache = new InMemoryCache({
      maxEntries: 3,
      cleanupMs: 0,
      prefixQuotas: { 'rl:': 1, 'rl:tenant-a:': 2 },
    });
    await cache.set('rl:other', 'shared');
    await cache.set('rl:tenant-a:1', 1);
    await cache.set('rl:tenant-a:2', 2);
    await cache.set('rl:tenant-a:3', 3);   // tenant-a is full — it eats its own

    expect((await cache.get('rl:tenant-a:1')).isNone()).toBe(true);
    expect((await cache.get('rl:other')).toNullable()).toBe('shared');
    expect(cache.sizeOfPrefixForTest('rl:tenant-a:')).toBe(2);
    expect(cache.sizeOfPrefixForTest('rl:')).toBe(1);
    await cache.close();
  });

  /**
   * HTTP-2 non-regression, in the one configuration that can collide with it:
   * the quotas reserve every slot, so a key matching no prefix has nowhere of
   * its own to go.  A reservation is not permission to grow the map, so the
   * write takes a reserved slot rather than the cap taking the loss.
   */
  test('maxEntries stays a hard cap when the quotas reserve the whole map', async () => {
    const cache = new InMemoryCache({ maxEntries: 2, cleanupMs: 0, prefixQuotas: { 'a:': 2 } });
    await cache.set('a:1', 1);
    await cache.set('a:2', 2);
    await cache.set('unreserved', 3);

    expect(cache.sizeForTest()).toBe(2);
    expect((await cache.get('unreserved')).toNullable()).toBe(3);
    await cache.close();
  });

  test('a quota caps a prefix even in an unbounded map', async () => {
    const cache = new InMemoryCache({ maxEntries: Infinity, cleanupMs: 0, prefixQuotas: { 'rsp:': 3 } });
    for (let i = 0; i < FLOOD_SIZE; i++) {
      await cache.set(`rsp:/public/${i}`, i);
      await cache.set(`k${i}`, i);
    }
    expect(cache.sizeOfPrefixForTest('rsp:')).toBe(3);
    expect(cache.sizeForTest()).toBe(3 + FLOOD_SIZE);
    await cache.close();
  });

  /** Inside a bucket nothing changed: guarantee-free entries go first, then LRU. */
  test('within one prefix the guarantee split and the recency order still decide', async () => {
    const cache = new InMemoryCache({ maxEntries: 10, cleanupMs: 0, prefixQuotas: { 'x:': 3 } });
    expect(await cache.setIfAbsent('x:claim', { inFlight: true }, 60_000)).toBe(true);
    await cache.set('x:a', 'first');
    await cache.set('x:b', 'second');
    await cache.set('x:c', 'third');       // at quota — the oldest `set` goes

    expect((await cache.get('x:a')).isNone()).toBe(true);
    expect((await cache.get('x:claim')).toNullable()).toEqual({ inFlight: true });
    expect((await cache.get('x:b')).toNullable()).toBe('second');
    await cache.close();
  });

  /** A prefix nothing reserved has no bucket of its own, and reads as holding nothing. */
  test('sizeOfPrefixForTest answers zero for an unreserved prefix', async () => {
    const cache = new InMemoryCache({ maxEntries: 4, cleanupMs: 0, prefixQuotas: { 'a:': 2 } });
    await cache.set('b:1', 1);
    expect(cache.sizeOfPrefixForTest('b:')).toBe(0);
    expect(cache.sizeForTest()).toBe(1);
    await cache.close();
  });

  test('delete and the periodic sweep both free the reserved slot again', async () => {
    const cache = new InMemoryCache({ maxEntries: 4, cleanupMs: 10, prefixQuotas: { 'a:': 2 } });
    await cache.set('a:1', 1);
    await cache.set('a:2', 2, 5);
    await cache.delete('a:1');
    expect(cache.sizeOfPrefixForTest('a:')).toBe(1);
    await awaitCondition(() => cache.sizeOfPrefixForTest('a:') === 0, {
      label: 'the sweep reclaimed the expired reserved entry',
    });
    await cache.close();
  });
});

// Options plumbing (WP3): builder parity + OptionsError validation, replacing
// the old bare-Error maxEntries guard and covering the previously-unvalidated
// cleanupMs.
describe('InMemoryCache — options + validation', () => {
  test('builder form is equivalent to a plain object', async () => {
    const cacheOptions = InMemoryCacheOptions.create()
      .withMaxEntries(3)
      .withCleanupMs(0);
    const cache = new InMemoryCache(cacheOptions);
    for (let i = 0; i < 20; i++) await cache.set(`k${i}`, i);
    expect(cache.sizeForTest()).toBeLessThanOrEqual(3);
    await cache.close();
  });

  test('rejects a non-positive / non-integer maxEntries with OptionsError', () => {
    expect(() => new InMemoryCache({ maxEntries: 0 })).toThrow(OptionsError);
    expect(() => new InMemoryCache({ maxEntries: -1 })).toThrow(/maxEntries/);
    expect(() => new InMemoryCache({ maxEntries: 2.5 })).toThrow(/maxEntries/);
  });

  test('rejects a negative / NaN cleanupMs with OptionsError', () => {
    expect(() => new InMemoryCache({ cleanupMs: -1 })).toThrow(OptionsError);
    expect(() => new InMemoryCache({ cleanupMs: Number.NaN })).toThrow(/cleanupMs/);
  });

  test('accepts the documented opt-out values (Infinity maxEntries, 0 cleanupMs)', () => {
    expect(() => new InMemoryCache({ maxEntries: Infinity, cleanupMs: 0 })).not.toThrow();
    expect(() => new InMemoryCache({ cleanupMs: Infinity })).not.toThrow();
  });

  test('builder form carries prefixQuotas the same way', async () => {
    const cacheOptions = InMemoryCacheOptions.create()
      .withMaxEntries(4)
      .withCleanupMs(0)
      .withPrefixQuotas({ 'a:': 2 });
    const cache = new InMemoryCache(cacheOptions);
    for (let i = 0; i < 20; i++) await cache.set(`a:${i}`, i);
    expect(cache.sizeOfPrefixForTest('a:')).toBe(2);
    await cache.close();
  });

  /**
   * The cross-field rule, and the reason it is one: reservations the map
   * cannot honour would be broken in the eviction path, silently, long after
   * the configuration that caused it was written.
   */
  test('rejects prefixQuotas that reserve more than maxEntries', () => {
    expect(() => new InMemoryCache({ maxEntries: 4, prefixQuotas: { 'a:': 3, 'b:': 3 } }))
      .toThrow(OptionsError);
    expect(() => new InMemoryCache({ maxEntries: 4, prefixQuotas: { 'a:': 3, 'b:': 3 } }))
      .toThrow(/prefixQuotas/);
    // The default cap counts when maxEntries is unset — the sum is checked
    // against what the instance will actually be built with.
    expect(() => new InMemoryCache({ prefixQuotas: { 'a:': DEFAULT_MAX_ENTRIES + 1 } }))
      .toThrow(/prefixQuotas/);
  });

  test('rejects a quota that is not a positive integer, and an empty prefix', () => {
    expect(() => new InMemoryCache({ prefixQuotas: { 'a:': 0 } })).toThrow(/prefixQuotas/);
    expect(() => new InMemoryCache({ prefixQuotas: { 'a:': 1.5 } })).toThrow(/prefixQuotas/);
    expect(() => new InMemoryCache({ prefixQuotas: { 'a:': Infinity } })).toThrow(/prefixQuotas/);
    expect(() => new InMemoryCache({ prefixQuotas: { '': 2 } })).toThrow(/empty prefix/);
    expect(() => new InMemoryCache({ prefixQuotas: 4 as unknown as Record<string, number> }))
      .toThrow(OptionsError);
  });

  test('accepts quotas that exactly reserve the map, and quotas on an unbounded one', () => {
    expect(() => new InMemoryCache({ maxEntries: 4, cleanupMs: 0, prefixQuotas: { 'a:': 2, 'b:': 2 } }))
      .not.toThrow();
    expect(() => new InMemoryCache({ maxEntries: Infinity, cleanupMs: 0, prefixQuotas: { 'a:': 2 } }))
      .not.toThrow();
  });
});
