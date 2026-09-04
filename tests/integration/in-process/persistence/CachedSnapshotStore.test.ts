import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCache } from '../../../../src/cache/InMemoryCache.js';
import { FilesystemObjectStorageBackend } from '../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { CachedSnapshotStore } from '../../../../src/persistence/snapshot-stores/CachedSnapshotStore.js';
import { CachedSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/CachedSnapshotStoreOptions.js';
import { InMemorySnapshotStore } from '../../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import { ObjectStorageSnapshotStore } from '../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStore.js';
import { ObjectStorageSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
import type { EncryptionConfig, EncryptionResolver } from '../../../../src/persistence/object-storage/PluginConfig.js';
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

describe('CachedSnapshotStore — plaintext cache guard', () => {
  const encryptedOptions: PersistenceOptions = { encryption: { mode: 'sse-s3' } };
  const explicitlyUnprotectedOptions: PersistenceOptions = { encryption: { mode: 'none' } };

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
    // The advisory names which of the two routes produced it, and the docs
    // quote both lines verbatim — so these two assertions are what keeps the
    // quotes honest.
    expect(warnings[0]).toContain('this loadLatest asked for encryption');
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

/**
 * The composition #782's own walkthrough describes, and the one the
 * object-storage page's example builds: encryption configured on the **store**
 * with `withEncryption(...)`, nothing per call.  That is the path the
 * documentation presents as the norm — `PersistentActor.encryption()` is the
 * per-actor override, not the default — so a guard that saw only the per-call
 * directive left the documented path unguarded, and four documentation lines
 * claiming otherwise (#782 as first shipped).
 *
 * These tests build the composition end to end against a real
 * `ObjectStorageSnapshotStore` over a filesystem backend rather than a fake,
 * because the point in question is exactly what the *store* does with its own
 * configuration: it decrypts on `loadLatest` and hands back the decoded state,
 * which is what the decorator would then write into a cache the operator
 * shares with other subsystems.
 */
describe('CachedSnapshotStore — encryption configured on the wrapped store (#782)', () => {
  /** 32 bytes — the single-key shorthand of `client-aes256-gcm`. */
  const MASTER_KEY = new Uint8Array(32).fill(0x2b);
  /** HKDF context — required on every client-side encryption config (#108). */
  const HKDF_INFO = 'acme/test/cached-snapshot/v1';
  /** A value that must never be findable in the cache while the bucket is encrypted. */
  const SECRET = 'DE00-1234-5678-9012';

  let directory: string;
  let backend: FilesystemObjectStorageBackend;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'actor-ts-cached-snapshot-'));
    backend = new FilesystemObjectStorageBackend(FilesystemObjectStorageOptions.create().withDir(directory));
  });

  afterEach(() => { try { rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ } });

  const clientSideEncryption: EncryptionConfig = {
    mode: 'client-aes256-gcm',
    masterKey: MASTER_KEY,
    info: HKDF_INFO,
  };

  const storeConfigured = (encryption?: EncryptionConfig | EncryptionResolver): ObjectStorageSnapshotStore => {
    const objectStorageOptions = ObjectStorageSnapshotStoreOptions.create().withBackend(backend);
    return new ObjectStorageSnapshotStore(
      encryption === undefined ? objectStorageOptions : objectStorageOptions.withEncryption(encryption),
    );
  };

  test('the plaintext never enters the cache, and the refusal warns once', async () => {
    const cache = new InMemoryCache();
    const cachedSnapshotStoreOptions = CachedSnapshotStoreOptions.create().withCache(cache);
    const store = new CachedSnapshotStore(storeConfigured(clientSideEncryption), cachedSnapshotStoreOptions);
    // No per-call options anywhere: the store's own config is the whole story.
    await store.save('pid-secret', 1, { iban: SECRET });

    const warnings = await captureWarnings(async () => {
      await store.loadLatest('pid-secret');
      await store.loadLatest('pid-secret');
    });

    // The exploit assertion first, because it is the one that reads as the
    // issue's walkthrough: the account number must not be findable in a
    // datastore the bucket's operators may not even administer.
    const cached = await cache.get('snap:pid-secret');
    expect(JSON.stringify(cached)).not.toContain(SECRET);
    expect(cached.isNone()).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('caches decoded snapshot state');
    expect(warnings[0]).toContain("the store's own configuration keeps this persistenceId encrypted");
    expect(warnings[0]).toContain('withAllowPlaintextCache');
  });

  test('the load still returns the decrypted snapshot — refusing to cache is not refusing to serve', async () => {
    const cachedSnapshotStoreOptions = CachedSnapshotStoreOptions.create().withCache(new InMemoryCache());
    const store = new CachedSnapshotStore(storeConfigured(clientSideEncryption), cachedSnapshotStoreOptions);
    await store.save('pid-secret', 1, { iban: SECRET });

    await captureWarnings(async () => {
      const loaded = await store.loadLatest<{ iban: string }>('pid-secret');
      expect(loaded.isSome()).toBe(true);
      expect(loaded.getOrElse({ iban: '' } as never).state.iban).toBe(SECRET);
    });
  });

  test('withAllowPlaintextCache(true) is the acknowledgement here too', async () => {
    const cache = new InMemoryCache();
    const cachedSnapshotStoreOptions = CachedSnapshotStoreOptions.create()
      .withCache(cache)
      .withAllowPlaintextCache(true);
    const store = new CachedSnapshotStore(storeConfigured(clientSideEncryption), cachedSnapshotStoreOptions);
    await store.save('pid-secret', 1, { iban: SECRET });

    const warnings = await captureWarnings(async () => { await store.loadLatest('pid-secret'); });

    expect((await cache.get('snap:pid-secret')).isSome()).toBe(true);
    expect(warnings).toEqual([]);
  });

  test('a store that is not encrypting still caches — the guard is about exposure, not about object storage', async () => {
    const cache = new InMemoryCache();
    const cachedSnapshotStoreOptions = CachedSnapshotStoreOptions.create().withCache(cache);
    const store = new CachedSnapshotStore(storeConfigured(), cachedSnapshotStoreOptions);
    await store.save('pid-open', 1, { balance: 7 });

    const warnings = await captureWarnings(async () => { await store.loadLatest('pid-open'); });

    expect((await cache.get('snap:pid-open')).isSome()).toBe(true);
    expect(warnings).toEqual([]);
  });

  test("an explicit { mode: 'none' } on the store is an opt-out, not a refusal", async () => {
    const cache = new InMemoryCache();
    const cachedSnapshotStoreOptions = CachedSnapshotStoreOptions.create().withCache(cache);
    const store = new CachedSnapshotStore(storeConfigured({ mode: 'none' }), cachedSnapshotStoreOptions);
    await store.save('pid-open', 1, { balance: 7 });

    const warnings = await captureWarnings(async () => { await store.loadLatest('pid-open'); });

    expect((await cache.get('snap:pid-open')).isSome()).toBe(true);
    expect(warnings).toEqual([]);
  });

  test('encryptsAtRest is delegated, and an undeclared store stays undeclared', () => {
    const cachedOptions = (): CachedSnapshotStoreOptions =>
      CachedSnapshotStoreOptions.create().withCache(new InMemoryCache());

    expect(new CachedSnapshotStore(storeConfigured(clientSideEncryption), cachedOptions())
      .encryptsAtRest('pid-secret')).toBe(true);
    expect(new CachedSnapshotStore(storeConfigured(), cachedOptions())
      .encryptsAtRest('pid-open')).toBe(false);
    // `InMemorySnapshotStore` cannot encrypt and says so once, through
    // `persistenceOptionSupport`; it declares nothing here, and a decorator
    // that answered `false` for it would launder unknown into a claim.
    expect(new CachedSnapshotStore(new InMemorySnapshotStore(), cachedOptions())
      .encryptsAtRest('pid-open')).toBeUndefined();
    // Stacked decorators see through, because each one delegates.
    const inner = new CachedSnapshotStore(storeConfigured(clientSideEncryption), cachedOptions());
    expect(new CachedSnapshotStore(inner, cachedOptions()).encryptsAtRest('pid-secret')).toBe(true);
  });

  test('a per-persistenceId resolver is decided per persistenceId, not once for the store', async () => {
    // `encryptionByPrefix`-shaped config: one prefix encrypted, everything
    // else not.  A coarse "this store has a resolver, assume encrypted" would
    // pass the first assertion and kill the cache for `open-`, which is the
    // whole population the cache exists for.
    const byPrefix: EncryptionResolver = (persistenceId) => (
      persistenceId.startsWith('secret-') ? clientSideEncryption : { mode: 'none' }
    );
    const cache = new InMemoryCache();
    const cachedSnapshotStoreOptions = CachedSnapshotStoreOptions.create().withCache(cache);
    const store = new CachedSnapshotStore(storeConfigured(byPrefix), cachedSnapshotStoreOptions);
    await store.save('secret-1', 1, { iban: SECRET });
    await store.save('open-1', 1, { balance: 7 });

    await captureWarnings(async () => {
      await store.loadLatest('secret-1');
      await store.loadLatest('open-1');
    });

    expect((await cache.get('snap:secret-1')).isNone()).toBe(true);
    expect((await cache.get('snap:open-1')).isSome()).toBe(true);
  });
});
