import { describe, expect, test } from 'bun:test';
import { InMemoryCache } from '../../../src/cache/InMemoryCache.js';
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
    const c = new InMemoryCache();
    await c.set('k', { hello: 'world' });
    const result = await c.get<{ hello: string }>('k');
    expect(result.toNullable()).toEqual({ hello: 'world' });
  });

  test('get on missing key returns None', async () => {
    const c = new InMemoryCache();
    expect((await c.get('absent')).isNone()).toBe(true);
  });

  test('set with TTL expires after the TTL elapses', async () => {
    const c = new InMemoryCache();
    await c.set('k', 'temp', 30);
    expect((await c.get('k')).toNullable()).toBe('temp');
    await sleep(50);
    expect((await c.get('k')).isNone()).toBe(true);
  });

  test('set without TTL never expires', async () => {
    const c = new InMemoryCache();
    await c.set('k', 1);
    await sleep(20);
    expect((await c.get('k')).toNullable()).toBe(1);
  });

  test('set rejects non-positive TTL', async () => {
    const c = new InMemoryCache();
    await expect(c.set('k', 1, 0)).rejects.toThrow();
    await expect(c.set('k', 1, -5)).rejects.toThrow();
  });
});

describe('InMemoryCache — incr', () => {
  test('first incr seeds counter at 1, subsequent calls increase', async () => {
    const c = new InMemoryCache();
    expect(await c.incr('counter')).toBe(1);
    expect(await c.incr('counter')).toBe(2);
    expect(await c.incr('counter')).toBe(3);
  });

  test('TTL applies only on creation, not on subsequent increments', async () => {
    const c = new InMemoryCache();
    expect(await c.incr('rate', 50)).toBe(1);
    await sleep(20);
    expect(await c.incr('rate', 50)).toBe(2);  // ttlMs ignored on existing key
    await sleep(40);  // total ~60ms, original TTL=50 should have expired by now
    expect(await c.incr('rate', 50)).toBe(1);  // counter reset
  });

  test('incr on a non-numeric key throws', async () => {
    const c = new InMemoryCache();
    await c.set('k', 'a string');
    await expect(c.incr('k')).rejects.toThrow();
  });
});

describe('InMemoryCache — setIfAbsent', () => {
  test('returns true on first call, false on subsequent', async () => {
    const c = new InMemoryCache();
    expect(await c.setIfAbsent('k', 'v1')).toBe(true);
    expect(await c.setIfAbsent('k', 'v2')).toBe(false);
    expect((await c.get('k')).toNullable()).toBe('v1');
  });

  test('after expiry, setIfAbsent succeeds again', async () => {
    const c = new InMemoryCache();
    expect(await c.setIfAbsent('k', 'v1', 30)).toBe(true);
    await sleep(50);
    expect(await c.setIfAbsent('k', 'v2', 30)).toBe(true);
    expect((await c.get('k')).toNullable()).toBe('v2');
  });
});

describe('InMemoryCache — delete', () => {
  test('delete removes a single key', async () => {
    const c = new InMemoryCache();
    await c.set('k', 1);
    await c.delete('k');
    expect((await c.get('k')).isNone()).toBe(true);
  });

  test('delete is variadic and idempotent', async () => {
    const c = new InMemoryCache();
    await c.set('a', 1); await c.set('b', 2);
    await c.delete('a', 'b', 'c');
    expect((await c.get('a')).isNone()).toBe(true);
    expect((await c.get('b')).isNone()).toBe(true);
  });
});

describe('InMemoryCache — close', () => {
  test('close clears the cache', async () => {
    const c = new InMemoryCache();
    await c.set('k', 1);
    await c.close();
    expect(c.sizeForTest()).toBe(0);
  });
});

describe('InMemoryCache — mget / mset (#14)', () => {
  test('mget returns a Map of hits; misses are absent', async () => {
    const c = new InMemoryCache();
    await c.set('a', 1);
    await c.set('b', 'two');
    const got = await c.mget<unknown>(['a', 'b', 'missing']);
    expect(got.size).toBe(2);
    expect(got.get('a')).toBe(1);
    expect(got.get('b')).toBe('two');
    expect(got.has('missing')).toBe(false);
  });

  test('mget on an empty input array returns an empty Map', async () => {
    const c = new InMemoryCache();
    const got = await c.mget([]);
    expect(got.size).toBe(0);
  });

  test('mget lazily expires entries — same semantics as single-key `get`', async () => {
    const c = new InMemoryCache();
    await c.set('a', 1, 10);  // 10 ms TTL
    await c.set('b', 2);      // no TTL
    await new Promise((r) => setTimeout(r, 20));
    const got = await c.mget(['a', 'b']);
    expect(got.has('a')).toBe(false);
    expect(got.get('b')).toBe(2);
  });

  test('mset writes every entry with the shared TTL', async () => {
    const c = new InMemoryCache();
    await c.mset(new Map([['a', 1], ['b', 2], ['c', 3]] as const), 50);
    expect((await c.get('a')).getOrElse(0)).toBe(1);
    expect((await c.get('b')).getOrElse(0)).toBe(2);
    expect((await c.get('c')).getOrElse(0)).toBe(3);
    // After the TTL all three expire together.
    await new Promise((r) => setTimeout(r, 70));
    expect((await c.mget(['a', 'b', 'c'])).size).toBe(0);
  });

  test('mset with no TTL persists indefinitely', async () => {
    const c = new InMemoryCache();
    await c.mset(new Map([['a', 1], ['b', 2]] as const));
    await new Promise((r) => setTimeout(r, 20));
    expect((await c.mget(['a', 'b'])).size).toBe(2);
  });

  test('mset rejects bogus ttlMs', async () => {
    const c = new InMemoryCache();
    await expect(c.mset(new Map([['a', 1]]), 0)).rejects.toThrow(/ttlMs/);
    await expect(c.mset(new Map([['a', 1]]), -1)).rejects.toThrow(/ttlMs/);
  });

  test('mset on an empty Map is a no-op', async () => {
    const c = new InMemoryCache();
    await c.mset(new Map());
    expect(c.sizeForTest()).toBe(0);
  });
});

// SECURITY_AUDIT.md HTTP-2 — the cache was an unbounded Map (lazy-expiry
// only, no cap), so a flood of distinct attacker-chosen keys (idempotency /
// rate-limit) grew it without limit → RAM DoS.  It is now LRU-bounded.
describe('InMemoryCache — bounded size / LRU eviction (HTTP-2)', () => {
  test('evicts the least-recently-used entry beyond maxEntries', async () => {
    const c = new InMemoryCache({ maxEntries: 3, cleanupMs: 0 });
    await c.set('a', 1);
    await c.set('b', 2);
    await c.set('c', 3);
    await c.get('a');          // 'a' becomes most-recently-used → 'b' is LRU
    await c.set('d', 4);       // over cap → evict LRU ('b')
    expect(c.sizeForTest()).toBe(3);
    expect((await c.get('b')).isNone()).toBe(true);
    expect((await c.get('a')).toNullable()).toBe(1);
    expect((await c.get('c')).toNullable()).toBe(3);
    expect((await c.get('d')).toNullable()).toBe(4);
    await c.close();
  });

  test('a flood of distinct keys stays bounded by maxEntries', async () => {
    const c = new InMemoryCache({ maxEntries: 50, cleanupMs: 0 });
    for (let i = 0; i < 5_000; i++) await c.set(`k${i}`, i);
    expect(c.sizeForTest()).toBeLessThanOrEqual(50);
    await c.close();
  });

  test('overwriting an existing key does not evict', async () => {
    const c = new InMemoryCache({ maxEntries: 2, cleanupMs: 0 });
    await c.set('a', 1);
    await c.set('b', 2);
    await c.set('a', 11);      // overwrite — no growth, no eviction
    expect(c.sizeForTest()).toBe(2);
    expect((await c.get('a')).toNullable()).toBe(11);
    expect((await c.get('b')).toNullable()).toBe(2);
    await c.close();
  });

  test('incr respects the cap', async () => {
    const c = new InMemoryCache({ maxEntries: 3, cleanupMs: 0 });
    for (let i = 0; i < 100; i++) await c.incr(`c${i}`);
    expect(c.sizeForTest()).toBeLessThanOrEqual(3);
    await c.close();
  });

  test('maxEntries: Infinity opts out of eviction (documented OOM risk)', async () => {
    const c = new InMemoryCache({ maxEntries: Infinity, cleanupMs: 0 });
    for (let i = 0; i < 500; i++) await c.set(`k${i}`, i);
    expect(c.sizeForTest()).toBe(500);
    await c.close();
  });

  test('constructor rejects a non-positive / non-integer maxEntries', () => {
    expect(() => new InMemoryCache({ maxEntries: 0 })).toThrow(/maxEntries/);
    expect(() => new InMemoryCache({ maxEntries: -1 })).toThrow(/maxEntries/);
    expect(() => new InMemoryCache({ maxEntries: 2.5 })).toThrow(/maxEntries/);
  });

  test('periodic sweep reclaims expired entries (cleanupMs)', async () => {
    const c = new InMemoryCache({ maxEntries: 100, cleanupMs: 20 });
    await c.set('temp', 1, 10);   // expires in ~10 ms
    expect(c.sizeForTest()).toBe(1);
    await sleep(80);              // several sweep cycles (every 20 ms)
    expect(c.sizeForTest()).toBe(0);
    await c.close();
  });
});
