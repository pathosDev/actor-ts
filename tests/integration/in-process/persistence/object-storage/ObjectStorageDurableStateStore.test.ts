import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { ObjectStorageDurableStateStore } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStore.js';
import { ObjectStorageDurableStateStoreOptions } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStoreOptions.js';
import { DurableStateConcurrencyError } from '../../../../../src/persistence/DurableStateStore.js';
import { OBJECT_STORAGE_DURABLE_STATE_NAMESPACE } from '../../../../../src/persistence/Constants.js';

let dir: string;
let backend: FilesystemObjectStorageBackend;
let store: ObjectStorageDurableStateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'actor-ts-ds-'));
  const backendOptions = FilesystemObjectStorageOptions.create()
    .withDir(dir);
  backend = new FilesystemObjectStorageBackend(backendOptions);
  const storeOptions = ObjectStorageDurableStateStoreOptions.create()
    .withBackend(backend);
  store = new ObjectStorageDurableStateStore(storeOptions);
});

afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('ObjectStorageDurableStateStore — happy path', () => {
  test('upsert with expectedRevision=0 creates a record with revision=1', async () => {
    const result = await store.upsert('a', 0, { balance: 100 });
    expect(result.revision).toBe(1);
    expect(result.state).toEqual({ balance: 100 });
    expect(result.persistenceId).toBe('a');
  });

  test('load returns the most recent record', async () => {
    await store.upsert('a', 0, { v: 1 });
    await store.upsert('a', 1, { v: 2 });
    const loaded = await store.load<{ v: number }>('a');
    expect(loaded.isSome()).toBe(true);
    expect(loaded.toNullable()?.revision).toBe(2);
    expect(loaded.toNullable()?.state).toEqual({ v: 2 });
  });

  test('load returns None for an unknown pid', async () => {
    expect((await store.load('nope')).isNone()).toBe(true);
  });

  test('delete removes the record and load thereafter returns None', async () => {
    await store.upsert('a', 0, {});
    await store.delete('a');
    expect((await store.load('a')).isNone()).toBe(true);
  });

  test('different pids do not interfere', async () => {
    await store.upsert('alice', 0, { who: 'alice' });
    await store.upsert('bob',   0, { who: 'bob'   });
    expect((await store.load('alice')).toNullable()?.state).toEqual({ who: 'alice' });
    expect((await store.load('bob')).toNullable()?.state).toEqual({ who: 'bob' });
  });
});

describe('ObjectStorageDurableStateStore — strict CAS', () => {
  test('second create with expectedRevision=0 throws DurableStateConcurrencyError', async () => {
    await store.upsert('a', 0, { v: 1 });
    await expect(store.upsert('a', 0, { v: 2 })).rejects.toBeInstanceOf(DurableStateConcurrencyError);
  });

  test('upsert with stale expectedRevision throws DurableStateConcurrencyError', async () => {
    await store.upsert('a', 0, { v: 1 });   // → revision 1
    await store.upsert('a', 1, { v: 2 });   // → revision 2
    await expect(store.upsert('a', 1, { v: 3 })).rejects.toBeInstanceOf(DurableStateConcurrencyError);
  });

  test('two parallel initial upserts: one wins, the other gets a CAS error', async () => {
    const racing = await Promise.allSettled([
      store.upsert('a', 0, { side: 'A' }),
      store.upsert('a', 0, { side: 'B' }),
    ]);
    const winners = racing.filter(result => result.status === 'fulfilled');
    const losers = racing.filter(result => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(DurableStateConcurrencyError);
  });

  test('etag cache loss on restart: re-load + upsert succeeds when revision still matches', async () => {
    await store.upsert('a', 0, { v: 1 });
    store.forgetEtagForTest('a');
    // Caller has the right revision; upsert should refresh internally then succeed.
    const result = await store.upsert('a', 1, { v: 99 });
    expect(result.revision).toBe(2);
    expect(result.state).toEqual({ v: 99 });
  });

  test('etag cache loss + diverged store revision surfaces a CAS error', async () => {
    await store.upsert('a', 0, { v: 1 });    // → 1
    await store.upsert('a', 1, { v: 2 });    // → 2 (real)
    store.forgetEtagForTest('a');
    await expect(store.upsert('a', 1, { v: 'wrong' })).rejects.toBeInstanceOf(DurableStateConcurrencyError);
  });

  test('a CAS rejection drops the stale etag so a correct retry can succeed (#117)', async () => {
    // Two stores over one backend reproduce what a second writer leaves
    // behind: `first` holds a cached etag that the backend has since replaced,
    // while the revision it cached is still the one the caller expects — so the
    // up-front revision check passes and the CAS is decided by the backend.
    const secondOptions = ObjectStorageDurableStateStoreOptions.create().withBackend(backend);
    const second = new ObjectStorageDurableStateStore(secondOptions);

    await store.upsert('a', 0, { v: 1 });          // → revision 1, `store` caches its etag
    await second.upsert('a', 1, { v: 2 });         // → revision 2, new etag in the bucket

    // `store` still believes revision 1, and sends its now-stale etag.
    await expect(store.upsert('a', 1, { v: 3 })).rejects.toBeInstanceOf(DurableStateConcurrencyError);

    // The caller learns the real revision and retries correctly.  Before the
    // fix the rejected etag stayed cached, so this threw again — and reported
    // `actual: 1` from the stale cache, which is not the truth either.  The
    // recovery path for a missing etag already existed; a CAS failure simply
    // never routed into it.
    const healed = await store.upsert('a', 2, { v: 4 });
    expect(healed.revision).toBe(3);
    expect(healed.state).toEqual({ v: 4 });

    const reread = await second.load('a');
    expect(reread.isSome()).toBe(true);
    if (reread.isSome()) expect(reread.value.state).toEqual({ v: 4 });
  });
});

describe('ObjectStorageDurableStateStore — input validation', () => {
  test('non-integer / negative expectedRevision is rejected synchronously', async () => {
    await expect(store.upsert('a', -1, {})).rejects.toThrow(/non-negative integer/);
    await expect(store.upsert('a',  1.5, {})).rejects.toThrow(/non-negative integer/);
  });
});

describe('ObjectStorageDurableStateStore — prefix and resolvers', () => {
  test('prefix is honoured for both upsert and load', async () => {
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withPrefix('prod/');
    const store = new ObjectStorageDurableStateStore(storeOptions);
    await store.upsert('a', 0, { x: 1 });
    expect((await store.load('a')).toNullable()?.state).toEqual({ x: 1 });
    const items = await backend.list({ prefix: 'prod/' });
    // The prefix leads, then the namespace this store owns (#716).
    expect(items.map(i => i.key))
      .toContain(`prod/${OBJECT_STORAGE_DURABLE_STATE_NAMESPACE}a/state.json`);
  });

  test('per-pid compression resolver is honoured', async () => {
    const seen = new Map<string, string | undefined>();
    const wrapping: typeof backend = Object.assign(Object.create(Object.getPrototypeOf(backend)), backend);
    wrapping.put = async (key, body, options) => {
      seen.set(key, options?.contentEncoding);
      return backend.put(key, body, options);
    };
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(wrapping)
      .withCompression((persistenceId) => persistenceId.startsWith('big-') ? { algorithm: 'zstd' } : { algorithm: 'gzip' });
    const store = new ObjectStorageDurableStateStore(storeOptions);
    await store.upsert('big-payload', 0, { x: 'x'.repeat(200) });
    await store.upsert('small',       0, { x: 'tiny' });
    expect(seen.get(`${OBJECT_STORAGE_DURABLE_STATE_NAMESPACE}big-payload/state.json`)).toBe('zstd');
    expect(seen.get(`${OBJECT_STORAGE_DURABLE_STATE_NAMESPACE}small/state.json`)).toBe('gzip');
  });
});
