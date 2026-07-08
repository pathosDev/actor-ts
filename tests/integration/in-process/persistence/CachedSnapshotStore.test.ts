import { describe, expect, test } from 'bun:test';
import { InMemoryCache } from '../../../../src/cache/InMemoryCache.js';
import { CachedSnapshotStore } from '../../../../src/persistence/snapshot-stores/CachedSnapshotStore.js';
import { CachedSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/CachedSnapshotStoreOptions.js';
import { InMemorySnapshotStore } from '../../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import type { SnapshotStore } from '../../../../src/persistence/SnapshotStore.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/**
 * Spy wrapper that counts loadLatest / save / delete calls on the
 * underlying store, so tests can assert that the cache really
 * short-circuited the trip to disk.
 */
class CountingStore implements SnapshotStore {
  loadLatestCalls = 0;
  saveCalls = 0;
  loadBeforeCalls = 0;
  deleteCalls = 0;
  constructor(private readonly inner: SnapshotStore) {}
  async save<S>(...args: Parameters<SnapshotStore['save']>): ReturnType<SnapshotStore['save']> {
    this.saveCalls++; return this.inner.save(...(args as Parameters<typeof this.inner.save>)) as ReturnType<SnapshotStore['save']>;
  }
  async loadLatest<S>(...args: Parameters<SnapshotStore['loadLatest']>): ReturnType<SnapshotStore['loadLatest']> {
    this.loadLatestCalls++; return this.inner.loadLatest(...args);
  }
  async loadBefore<S>(...args: Parameters<SnapshotStore['loadBefore']>): ReturnType<SnapshotStore['loadBefore']> {
    this.loadBeforeCalls++; return this.inner.loadBefore(...args);
  }
  async delete(...args: Parameters<SnapshotStore['delete']>): ReturnType<SnapshotStore['delete']> {
    this.deleteCalls++; return this.inner.delete(...args);
  }
}

describe('CachedSnapshotStore — read-through behaviour', () => {
  test('first loadLatest hits underlying store; second hits cache', async () => {
    const counting = new CountingStore(new InMemorySnapshotStore());
    const cache = new InMemoryCache();
    const cachedSnapshotStoreOptions = CachedSnapshotStoreOptions.create()
      .withCache(cache)
      .withTtlMs(5_000);
    const store = new CachedSnapshotStore(counting, cachedSnapshotStoreOptions);
    await store.save('pid-1', 5, { x: 1 });
    expect(counting.saveCalls).toBe(1);

    const r1 = await store.loadLatest<{ x: number }>('pid-1');
    const r2 = await store.loadLatest<{ x: number }>('pid-1');
    expect(r1.toNullable()?.state).toEqual({ x: 1 });
    expect(r2.toNullable()?.state).toEqual({ x: 1 });
    expect(counting.loadLatestCalls).toBe(1);  // second call served from cache
  });

  test('cache miss returns None when there is no snapshot', async () => {
    const counting = new CountingStore(new InMemorySnapshotStore());
    const cache = new InMemoryCache();
    const cachedSnapshotStoreOptions = CachedSnapshotStoreOptions.create()
      .withCache(cache)
      .withTtlMs(5_000);
    const store = new CachedSnapshotStore(counting, cachedSnapshotStoreOptions);
    expect((await store.loadLatest('absent')).isNone()).toBe(true);
    expect(counting.loadLatestCalls).toBe(1);
  });

  test('TTL: cache entry expires and the underlying store is queried again', async () => {
    const counting = new CountingStore(new InMemorySnapshotStore());
    const cache = new InMemoryCache();
    const cachedSnapshotStoreOptions = CachedSnapshotStoreOptions.create()
      .withCache(cache)
      .withTtlMs(30);
    const store = new CachedSnapshotStore(counting, cachedSnapshotStoreOptions);
    await store.save('p', 1, { v: 1 });
    await store.loadLatest('p');
    expect(counting.loadLatestCalls).toBe(1);
    await sleep(50);
    await store.loadLatest('p');
    expect(counting.loadLatestCalls).toBe(2);
  });
});

describe('CachedSnapshotStore — invalidation on save / delete', () => {
  test('save invalidates the cache entry (next loadLatest re-fetches)', async () => {
    const counting = new CountingStore(new InMemorySnapshotStore());
    const cache = new InMemoryCache();
    const cachedSnapshotStoreOptions = CachedSnapshotStoreOptions.create()
      .withCache(cache)
      .withTtlMs(60_000);
    const store = new CachedSnapshotStore(counting, cachedSnapshotStoreOptions);
    await store.save('p', 1, { v: 1 });
    await store.loadLatest('p');                // populate cache
    expect(counting.loadLatestCalls).toBe(1);
    await store.save('p', 2, { v: 2 });          // ← invalidates
    const after = await store.loadLatest<{ v: number }>('p');
    expect(after.toNullable()?.state).toEqual({ v: 2 });
    expect(counting.loadLatestCalls).toBe(2);    // had to re-fetch
  });

  test('delete also invalidates the cache', async () => {
    const counting = new CountingStore(new InMemorySnapshotStore());
    const cache = new InMemoryCache();
    const cachedSnapshotStoreOptions = CachedSnapshotStoreOptions.create()
      .withCache(cache)
      .withTtlMs(60_000);
    const store = new CachedSnapshotStore(counting, cachedSnapshotStoreOptions);
    await store.save('p', 1, { v: 1 });
    await store.loadLatest('p');
    await store.delete('p', 1);
    expect((await store.loadLatest('p')).isNone()).toBe(true);
    expect(counting.deleteCalls).toBe(1);
  });
});

describe('CachedSnapshotStore — bypass paths', () => {
  test('loadBefore is NOT cached (always goes to underlying)', async () => {
    const counting = new CountingStore(new InMemorySnapshotStore());
    const cache = new InMemoryCache();
    const cachedSnapshotStoreOptions = CachedSnapshotStoreOptions.create()
      .withCache(cache)
      .withTtlMs(60_000);
    const store = new CachedSnapshotStore(counting, cachedSnapshotStoreOptions);
    await store.save('p', 1, {});
    await store.save('p', 2, {});
    await store.save('p', 3, {});
    await store.loadBefore('p', 3);
    await store.loadBefore('p', 3);
    expect(counting.loadBeforeCalls).toBe(2);
  });
});

describe('CachedSnapshotStore — config guards', () => {
  test('rejects invalid ttl', () => {
    const cache = new InMemoryCache();
    const inner = new InMemorySnapshotStore();
    const ttlZeroOptions = CachedSnapshotStoreOptions.create()
      .withCache(cache)
      .withTtlMs(0);
    expect(() => new CachedSnapshotStore(inner, ttlZeroOptions)).toThrow(OptionsError);
    const ttlNegativeOptions = CachedSnapshotStoreOptions.create()
      .withCache(cache)
      .withTtlMs(-1);
    expect(() => new CachedSnapshotStore(inner, ttlNegativeOptions)).toThrow(OptionsError);
  });

  test('rejects a missing cache', () => {
    const inner = new InMemorySnapshotStore();
    // No withCache() — the backing cache is required.
    const noCacheOptions = CachedSnapshotStoreOptions.create().withTtlMs(1000);
    expect(() => new CachedSnapshotStore(inner, noCacheOptions)).toThrow(OptionsError);
    expect(() => new CachedSnapshotStore(inner, noCacheOptions)).toThrow(/cache is required/);
  });

  test('keyPrefix is honoured', async () => {
    const cache = new InMemoryCache();
    const inner = new InMemorySnapshotStore();
    const cachedSnapshotStoreOptions = CachedSnapshotStoreOptions.create()
      .withCache(cache)
      .withTtlMs(5_000)
      .withKeyPrefix('env-prod:snap:');
    const store = new CachedSnapshotStore(inner, cachedSnapshotStoreOptions);
    await store.save('p', 1, { v: 1 });
    await store.loadLatest('p');  // populate
    // Direct cache probe with the expected key:
    expect((await cache.get('env-prod:snap:p')).isSome()).toBe(true);
  });
});
