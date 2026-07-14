import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { ObjectStorageDurableStateStore } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStore.js';
import { ObjectStorageDurableStateStoreOptions } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStoreOptions.js';
import { DurableStateConcurrencyError } from '../../../../../src/persistence/DurableStateStore.js';

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
    expect(items.map(i => i.key)).toContain('prod/a/state.json');
  });

  test('per-pid compression resolver is honoured', async () => {
    const seen = new Map<string, string | undefined>();
    const wrapping: typeof backend = Object.assign(Object.create(Object.getPrototypeOf(backend)), backend);
    wrapping.put = async (key, body, opts) => {
      seen.set(key, opts?.contentEncoding);
      return backend.put(key, body, opts);
    };
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(wrapping)
      .withCompression((pid) => pid.startsWith('big-') ? { algorithm: 'zstd' } : { algorithm: 'gzip' });
    const store = new ObjectStorageDurableStateStore(storeOptions);
    await store.upsert('big-payload', 0, { x: 'x'.repeat(200) });
    await store.upsert('small',       0, { x: 'tiny' });
    expect(seen.get('big-payload/state.json')).toBe('zstd');
    expect(seen.get('small/state.json')).toBe('gzip');
  });
});
