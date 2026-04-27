import { describe, expect, test } from 'bun:test';
import { InMemoryCache } from '../../../src/cache/InMemoryCache.js';

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
