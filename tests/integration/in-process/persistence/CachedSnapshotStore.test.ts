import { describe, expect, test } from 'bun:test';
import { InMemoryCache } from '../../../../src/cache/InMemoryCache.js';
import { CachedSnapshotStore } from '../../../../src/persistence/snapshot-stores/CachedSnapshotStore.js';
import { CachedSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/CachedSnapshotStoreOptions.js';
import { InMemorySnapshotStore } from '../../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import type { Snapshot } from '../../../../src/persistence/JournalTypes.js';
import type { PersistenceOptions } from '../../../../src/persistence/PersistenceOptions.js';
import type { SnapshotStore } from '../../../../src/persistence/SnapshotStore.js';
import type { Option } from '../../../../src/util/Option.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import { sleep } from '../../../util/AwaitCondition.js';

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

  /*
   * Spelled out rather than forwarded through `Parameters<SnapshotStore
   * ['save']>`.  That trick reads as "whatever the interface takes", but
   * it instantiates the generic at its default — so `save` promised
   * `Snapshot<unknown>` where the interface promises `Snapshot<S>`, and
   * this fake stopped being assignable to the thing it fakes.
   */
  async save<S = unknown>(
    persistenceId: string, seq: number, state: S, options?: PersistenceOptions,
  ): Promise<Snapshot<S>> {
    this.saveCalls++;
    return this.inner.save<S>(persistenceId, seq, state, options);
  }

  async loadLatest<S = unknown>(
    persistenceId: string, options?: PersistenceOptions,
  ): Promise<Option<Snapshot<S>>> {
    this.loadLatestCalls++;
    return this.inner.loadLatest<S>(persistenceId, options);
  }

  async loadBefore<S = unknown>(
    persistenceId: string, seq: number, options?: PersistenceOptions,
  ): Promise<Option<Snapshot<S>>> {
    this.loadBeforeCalls++;
    return this.inner.loadBefore<S>(persistenceId, seq, options);
  }

  async delete(persistenceId: string, toSeq: number): Promise<void> {
    this.deleteCalls++;
    return this.inner.delete(persistenceId, toSeq);
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
    // The elapsed time IS the assertion: the entry has to outlive the 30 ms TTL
    // configured above, and only the clock can make that happen (#418).
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

/**
 * A stub that claims all three fields, standing in for the object-storage
 * store without dragging a filesystem backend into this suite.
 */
class HonouringStore extends InMemorySnapshotStore {
  override readonly persistenceOptionSupport = { encryption: true, compression: true, integrity: true } as const;
}

describe('CachedSnapshotStore — capability delegation', () => {
  /**
   * The decorator forwards `options` to the wrapped store verbatim and adds
   * no codec of its own, so its `persistenceOptionSupport` genuinely IS the
   * inner store's (#960).  A literal would be a lie in both directions: a
   * hard-coded `false` refuses an actor whose object-storage store can
   * encrypt, a hard-coded `true` waves one through over Postgres.
   *
   * Note this reports the *inner store's* at-rest behaviour and says nothing
   * about what the cache itself holds — see #782.
   */
  const cachedOptions = (): CachedSnapshotStoreOptions =>
    CachedSnapshotStoreOptions.create().withCache(new InMemoryCache());

  test('reports what the wrapped store reports', () => {
    const plaintext = new CachedSnapshotStore(new InMemorySnapshotStore(), cachedOptions());
    expect(plaintext.persistenceOptionSupport)
      .toEqual({ encryption: false, compression: false, integrity: false });

    const honouring = new CachedSnapshotStore(new HonouringStore(), cachedOptions());
    expect(honouring.persistenceOptionSupport)
      .toEqual({ encryption: true, compression: true, integrity: true });
  });

  test('an undeclared inner store stays undeclared rather than becoming a confident answer', () => {
    // `CountingStore` declares nothing, which is the third-party shape: the
    // actor-side check treats it as unknown and never refuses.  A decorator
    // that defaulted here would launder that into a claim nobody made.
    const spy = new CountingStore(new InMemorySnapshotStore());
    expect(new CachedSnapshotStore(spy, cachedOptions()).persistenceOptionSupport).toBeUndefined();
  });
});

/**
 * The cache holds the *decoded* snapshot, so composing this decorator with
 * client-side snapshot encryption puts a second, plaintext copy of the state
 * in a datastore the caller owns and usually shares (#782).  The per-call
 * `encryption` directive is the half of that the decorator can actually see —
 * it arrives on every read and write — and it used to be forwarded blind.
 */
describe('CachedSnapshotStore — plaintext cache guard', () => {
  const encryptedOptions: PersistenceOptions = { encryption: { mode: 'sse-s3' } };
  const explicitlyUnprotectedOptions: PersistenceOptions = { encryption: { mode: 'none' } };

  /**
   * Swap `console.warn` for the duration of one call and hand back what it
   * saw.  The advisory has no `ActorSystem` to log through, for the reason
   * `ObjectStoragePlugin` states, so the console *is* the observable.
   */
  const captureWarnings = async (body: () => Promise<void>): Promise<string[]> => {
    const captured: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]): void => { captured.push(String(args[0])); };
    try { await body(); } finally { console.warn = original; }
    return captured;
  };

  test('an encrypted loadLatest is served from the wrapped store, never cached, and warns once', async () => {
    const counting = new CountingStore(new HonouringStore());
    const cache = new InMemoryCache();
    const cachedSnapshotStoreOptions = CachedSnapshotStoreOptions.create().withCache(cache);
    const store = new CachedSnapshotStore(counting, cachedSnapshotStoreOptions);
    await store.save('pid-secret', 1, { balance: 42 }, encryptedOptions);

    const warnings = await captureWarnings(async () => {
      await store.loadLatest('pid-secret', encryptedOptions);
      await store.loadLatest('pid-secret', encryptedOptions);
    });

    // Two loads, two trips to the wrapped store — nothing was cached for the
    // second one to hit, which is the point.
    expect(counting.loadLatestCalls).toBe(2);
    expect((await cache.get('snap:pid-secret')).isNone()).toBe(true);
    // Once per store, not once per cold start.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('caches decoded snapshot state');
    expect(warnings[0]).toContain('withAllowPlaintextCache');
  });

  test('withAllowPlaintextCache(true) is the acknowledgement — caching resumes, silently', async () => {
    const counting = new CountingStore(new HonouringStore());
    const cache = new InMemoryCache();
    const cachedSnapshotStoreOptions = CachedSnapshotStoreOptions.create()
      .withCache(cache)
      .withAllowPlaintextCache(true);
    const store = new CachedSnapshotStore(counting, cachedSnapshotStoreOptions);
    await store.save('pid-secret', 1, { balance: 42 }, encryptedOptions);

    const warnings = await captureWarnings(async () => {
      await store.loadLatest('pid-secret', encryptedOptions);
      await store.loadLatest('pid-secret', encryptedOptions);
    });

    expect(counting.loadLatestCalls).toBe(1);  // second call served from cache
    expect((await cache.get('snap:pid-secret')).isSome()).toBe(true);
    expect(warnings).toEqual([]);
  });

  test('an explicit mode: none is an opt-out, not a refusal', async () => {
    // `{ mode: 'none' }` is how an actor says "deliberately unprotected" —
    // the same reading `unhonouredPersistenceOptions` gives it.  Turning that
    // into a cache bypass would punish the one caller who said what they meant.
    const counting = new CountingStore(new HonouringStore());
    const cache = new InMemoryCache();
    const cachedSnapshotStoreOptions = CachedSnapshotStoreOptions.create().withCache(cache);
    const store = new CachedSnapshotStore(counting, cachedSnapshotStoreOptions);
    await store.save('pid-open', 1, { balance: 7 }, explicitlyUnprotectedOptions);

    const warnings = await captureWarnings(async () => {
      await store.loadLatest('pid-open', explicitlyUnprotectedOptions);
      await store.loadLatest('pid-open', explicitlyUnprotectedOptions);
      // And an absent directive, the overwhelmingly common case, is untouched.
      await store.loadLatest('pid-open');
    });

    expect(counting.loadLatestCalls).toBe(1);
    expect((await cache.get('snap:pid-open')).isSome()).toBe(true);
    expect(warnings).toEqual([]);
  });
});
