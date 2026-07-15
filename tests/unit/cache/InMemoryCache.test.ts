import { describe, expect, test } from 'bun:test';
import { InMemoryCache } from '../../../src/cache/InMemoryCache.js';
import { InMemoryCacheOptions } from '../../../src/cache/InMemoryCacheOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
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

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

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
    await sleep(50);
    expect((await cache.get('k')).isNone()).toBe(true);
  });

  test('set without TTL never expires', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', 1);
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

  test('periodic sweep reclaims expired entries (cleanupMs)', async () => {
    const cache = new InMemoryCache({ maxEntries: 100, cleanupMs: 20 });
    await cache.set('temp', 1, 10);   // expires in ~10 ms
    expect(cache.sizeForTest()).toBe(1);
    await sleep(80);              // several sweep cycles (every 20 ms)
    expect(cache.sizeForTest()).toBe(0);
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
});
