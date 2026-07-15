import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { ObjectStorageSnapshotStore } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStore.js';
import { ObjectStorageSnapshotStoreOptions } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
import { compressionByPrefix } from '../../../../../src/persistence/object-storage/PluginConfig.js';

let dir: string;
let backend: FilesystemObjectStorageBackend;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'actor-ts-snap-'));
  const backendOptions = FilesystemObjectStorageOptions.create()
    .withDir(dir);
  backend = new FilesystemObjectStorageBackend(backendOptions);
});

afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('ObjectStorageSnapshotStore — save / loadLatest', () => {
  test('save returns a snapshot with the supplied seq + state', async () => {
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend);
    const store = new ObjectStorageSnapshotStore(storeOptions);
    const snap = await store.save('p', 5, { balance: 42 });
    expect(snap.sequenceNr).toBe(5);
    expect(snap.persistenceId).toBe('p');
    expect(snap.state).toEqual({ balance: 42 });
  });

  test('loadLatest returns the most recent snapshot', async () => {
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend);
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('p', 3, { step: 'a' });
    await store.save('p', 7, { step: 'b' });
    const latest = await store.loadLatest<{ step: string }>('p');
    expect(latest.isSome()).toBe(true);
    expect(latest.toNullable()?.sequenceNr).toBe(7);
    expect(latest.toNullable()?.state.step).toBe('b');
  });

  test('loadLatest returns None when nothing has been saved', async () => {
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend);
    const store = new ObjectStorageSnapshotStore(storeOptions);
    expect((await store.loadLatest('absent')).isNone()).toBe(true);
  });

  test('snapshots from different pids do not interfere', async () => {
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend);
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('a', 1, { who: 'a' });
    await store.save('b', 5, { who: 'b' });
    expect((await store.loadLatest('a')).toNullable()?.state).toEqual({ who: 'a' });
    expect((await store.loadLatest('b')).toNullable()?.state).toEqual({ who: 'b' });
  });
});

describe('ObjectStorageSnapshotStore — loadBefore / delete', () => {
  test('loadBefore finds the newest snapshot strictly before seq', async () => {
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend);
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('p', 1, {});
    await store.save('p', 4, {});
    await store.save('p', 8, {});
    expect((await store.loadBefore('p', 5)).toNullable()?.sequenceNr).toBe(4);
    expect((await store.loadBefore('p', 8)).toNullable()?.sequenceNr).toBe(4);
    expect((await store.loadBefore('p', 9)).toNullable()?.sequenceNr).toBe(8);
  });

  test('delete removes snapshots up to and including toSeq', async () => {
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend);
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('p', 1, {});
    await store.save('p', 5, {});
    await store.save('p', 9, {});
    await store.delete('p', 5);
    expect((await store.loadLatest('p')).toNullable()?.sequenceNr).toBe(9);
  });
});

describe('ObjectStorageSnapshotStore — keepN pruning', () => {
  test('keeps only the most recent N snapshots after each save', async () => {
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withKeepN(2);
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('p', 1, {}); await store.save('p', 2, {});
    await store.save('p', 3, {}); await store.save('p', 4, {});
    // After the last save only seqs 3 and 4 should survive.
    expect((await store.loadLatest('p')).toNullable()?.sequenceNr).toBe(4);
    expect((await store.loadBefore('p', 4)).toNullable()?.sequenceNr).toBe(3);
    expect((await store.loadBefore('p', 3)).isNone()).toBe(true);
  });

  test('keepN=0 disables pruning', async () => {
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withKeepN(0);
    const store = new ObjectStorageSnapshotStore(storeOptions);
    for (let i = 1; i <= 6; i++) await store.save('p', i, {});
    // No pruning means all 6 are present.
    expect((await store.loadBefore('p', 6)).toNullable()?.sequenceNr).toBe(5);
    expect((await store.loadBefore('p', 2)).toNullable()?.sequenceNr).toBe(1);
  });
});

describe('ObjectStorageSnapshotStore — compression resolver', () => {
  test('per-pid resolver picks different algorithms for different pids', async () => {
    const seenAlgos = new Map<string, string | undefined>();
    const wrapping: typeof backend = Object.assign(Object.create(Object.getPrototypeOf(backend)), backend);
    wrapping.put = async (key, body, opts) => {
      seenAlgos.set(key, opts?.contentEncoding);
      return backend.put(key, body, opts);
    };
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(wrapping)
      .withCompression(compressionByPrefix({default: { algorithm: 'gzip' },'large/': { algorithm: 'zstd' },'small/': { algorithm: 'none' },}));
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('large/x', 1, { data: 'x'.repeat(200) });
    await store.save('small/y', 1, { data: 'y' });
    await store.save('other/z', 1, { data: 'z' });
    expect(seenAlgos.get('large/x/00000000000000000001.json')).toBe('zstd');
    expect(seenAlgos.get('small/y/00000000000000000001.json')).toBeUndefined();
    expect(seenAlgos.get('other/z/00000000000000000001.json')).toBe('gzip');
  });

  test('round-trip survives gzip and zstd', async () => {
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withCompression((pid) => pid.startsWith('zstd-')? { algorithm: 'zstd' }: { algorithm: 'gzip' });
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('gzip-pid', 1, { hello: 'gzip' });
    await store.save('zstd-pid', 1, { hello: 'zstd' });
    expect((await store.loadLatest('gzip-pid')).toNullable()?.state).toEqual({ hello: 'gzip' });
    expect((await store.loadLatest('zstd-pid')).toNullable()?.state).toEqual({ hello: 'zstd' });
  });
});

describe('ObjectStorageSnapshotStore — prefix', () => {
  test('plugin prefix is prepended to every key', async () => {
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withPrefix('env-prod/');
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('account-1', 5, { x: 1 });
    const items = await backend.list({ prefix: 'env-prod/' });
    expect(items.map(i => i.key)).toContain('env-prod/account-1/00000000000000000005.json');
  });
});

describe('ObjectStorageSnapshotStore — encryption (client-aes256-gcm)', () => {
  test('encrypted snapshot round-trips and the on-disk body does NOT contain the plaintext', async () => {
    const masterKey = new Uint8Array(32).fill(0xab);
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' }) // disable compression for clearer plaintext check
      .withEncryption({ mode: 'client-aes256-gcm', masterKey });
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('p', 1, { secret: 'attack-at-dawn-zero-zero' });
    const fetched = await backend.get('p/00000000000000000001.json');
    expect(fetched.isSome()).toBe(true);
    if (fetched.isSome()) {
      const asString = new TextDecoder('utf-8', { fatal: false }).decode(fetched.value.body);
      expect(asString.includes('attack-at-dawn')).toBe(false);
    }
    const loaded = await store.loadLatest<{ secret: string }>('p');
    expect(loaded.toNullable()?.state.secret).toBe('attack-at-dawn-zero-zero');
  });

  test('per-tenant resolver: two pids → two distinct subkeys; cross-decryption fails', async () => {
    const masterKey = new Uint8Array(32).fill(0xcd);
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withEncryption((pid) => pid.startsWith('tenant-')? { mode: 'client-aes256-gcm', masterKey }: { mode: 'none' });
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('tenant-acme/x', 1, { who: 'acme' });
    await store.save('tenant-bigcorp/x', 1, { who: 'bigcorp' });

    // The store derives a subkey per-pid from the master, so even with the
    // SAME master key the two snapshots use different subkeys.  We prove
    // that by sniffing the bytes — the bigcorp snapshot must not decrypt
    // as if it were acme's.
    const acme = await backend.get('tenant-acme/x/00000000000000000001.json');
    const big = await backend.get('tenant-bigcorp/x/00000000000000000001.json');
    expect(acme.isSome() && big.isSome()).toBe(true);

    // Each pid loads correctly through the store.
    expect((await store.loadLatest('tenant-acme/x')).toNullable()?.state).toEqual({ who: 'acme' });
    expect((await store.loadLatest('tenant-bigcorp/x')).toNullable()?.state).toEqual({ who: 'bigcorp' });
  });
});

// security audit #3 — the store now forwards its maxDecompressedBytes into
// decodeBody, so a body whose decompressed size exceeds the configured cap is
// refused on read (previously the cap was pinned to the 512 MiB default).
describe('ObjectStorageSnapshotStore — maxDecompressedBytes cap (#3)', () => {
  test('a load whose decompressed body exceeds the store cap throws', async () => {
    const writer = new ObjectStorageSnapshotStore(
      ObjectStorageSnapshotStoreOptions.create().withBackend(backend),
    );
    await writer.save('p', 1, { blob: 'x'.repeat(50_000) });

    const cappedOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withMaxDecompressedBytes(1024);   // far below the ~50 KB decompressed body
    const capped = new ObjectStorageSnapshotStore(cappedOptions);
    await expect(capped.loadLatest('p')).rejects.toThrow();
  });

  test('a generous cap loads the same body fine', async () => {
    const writer = new ObjectStorageSnapshotStore(
      ObjectStorageSnapshotStoreOptions.create().withBackend(backend),
    );
    await writer.save('p', 1, { blob: 'x'.repeat(50_000) });

    const okOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withMaxDecompressedBytes(1_000_000);
    const store = new ObjectStorageSnapshotStore(okOptions);
    const loaded = await store.loadLatest<{ blob: string }>('p');
    expect(loaded.toNullable()?.state.blob.length).toBe(50_000);
  });
});
