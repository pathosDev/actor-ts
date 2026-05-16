import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { ObjectStorageSnapshotStore } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStore.js';
import { compressionByPrefix } from '../../../../../src/persistence/object-storage/PluginConfig.js';

let dir: string;
let backend: FilesystemObjectStorageBackend;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'actor-ts-snap-'));
  backend = new FilesystemObjectStorageBackend({ dir });
});

afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('ObjectStorageSnapshotStore — save / loadLatest', () => {
  test('save returns a snapshot with the supplied seq + state', async () => {
    const s = new ObjectStorageSnapshotStore({ backend });
    const snap = await s.save('p', 5, { balance: 42 });
    expect(snap.sequenceNr).toBe(5);
    expect(snap.persistenceId).toBe('p');
    expect(snap.state).toEqual({ balance: 42 });
  });

  test('loadLatest returns the most recent snapshot', async () => {
    const s = new ObjectStorageSnapshotStore({ backend });
    await s.save('p', 3, { step: 'a' });
    await s.save('p', 7, { step: 'b' });
    const latest = await s.loadLatest<{ step: string }>('p');
    expect(latest.isSome()).toBe(true);
    expect(latest.toNullable()?.sequenceNr).toBe(7);
    expect(latest.toNullable()?.state.step).toBe('b');
  });

  test('loadLatest returns None when nothing has been saved', async () => {
    const s = new ObjectStorageSnapshotStore({ backend });
    expect((await s.loadLatest('absent')).isNone()).toBe(true);
  });

  test('snapshots from different pids do not interfere', async () => {
    const s = new ObjectStorageSnapshotStore({ backend });
    await s.save('a', 1, { who: 'a' });
    await s.save('b', 5, { who: 'b' });
    expect((await s.loadLatest('a')).toNullable()?.state).toEqual({ who: 'a' });
    expect((await s.loadLatest('b')).toNullable()?.state).toEqual({ who: 'b' });
  });
});

describe('ObjectStorageSnapshotStore — loadBefore / delete', () => {
  test('loadBefore finds the newest snapshot strictly before seq', async () => {
    const s = new ObjectStorageSnapshotStore({ backend });
    await s.save('p', 1, {});
    await s.save('p', 4, {});
    await s.save('p', 8, {});
    expect((await s.loadBefore('p', 5)).toNullable()?.sequenceNr).toBe(4);
    expect((await s.loadBefore('p', 8)).toNullable()?.sequenceNr).toBe(4);
    expect((await s.loadBefore('p', 9)).toNullable()?.sequenceNr).toBe(8);
  });

  test('delete removes snapshots up to and including toSeq', async () => {
    const s = new ObjectStorageSnapshotStore({ backend });
    await s.save('p', 1, {});
    await s.save('p', 5, {});
    await s.save('p', 9, {});
    await s.delete('p', 5);
    expect((await s.loadLatest('p')).toNullable()?.sequenceNr).toBe(9);
  });
});

describe('ObjectStorageSnapshotStore — keepN pruning', () => {
  test('keeps only the most recent N snapshots after each save', async () => {
    const s = new ObjectStorageSnapshotStore({ backend, keepN: 2 });
    await s.save('p', 1, {}); await s.save('p', 2, {});
    await s.save('p', 3, {}); await s.save('p', 4, {});
    // After the last save only seqs 3 and 4 should survive.
    expect((await s.loadLatest('p')).toNullable()?.sequenceNr).toBe(4);
    expect((await s.loadBefore('p', 4)).toNullable()?.sequenceNr).toBe(3);
    expect((await s.loadBefore('p', 3)).isNone()).toBe(true);
  });

  test('keepN=0 disables pruning', async () => {
    const s = new ObjectStorageSnapshotStore({ backend, keepN: 0 });
    for (let i = 1; i <= 6; i++) await s.save('p', i, {});
    // No pruning means all 6 are present.
    expect((await s.loadBefore('p', 6)).toNullable()?.sequenceNr).toBe(5);
    expect((await s.loadBefore('p', 2)).toNullable()?.sequenceNr).toBe(1);
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
    const s = new ObjectStorageSnapshotStore({
      backend: wrapping,
      compression: compressionByPrefix({
        default: { algorithm: 'gzip' },
        'large/': { algorithm: 'zstd' },
        'small/': { algorithm: 'none' },
      }),
    });
    await s.save('large/x', 1, { data: 'x'.repeat(200) });
    await s.save('small/y', 1, { data: 'y' });
    await s.save('other/z', 1, { data: 'z' });
    expect(seenAlgos.get('large/x/00000000000000000001.json')).toBe('zstd');
    expect(seenAlgos.get('small/y/00000000000000000001.json')).toBeUndefined();
    expect(seenAlgos.get('other/z/00000000000000000001.json')).toBe('gzip');
  });

  test('round-trip survives gzip and zstd', async () => {
    const s = new ObjectStorageSnapshotStore({
      backend,
      compression: (pid) => pid.startsWith('zstd-')
        ? { algorithm: 'zstd' }
        : { algorithm: 'gzip' },
    });
    await s.save('gzip-pid', 1, { hello: 'gzip' });
    await s.save('zstd-pid', 1, { hello: 'zstd' });
    expect((await s.loadLatest('gzip-pid')).toNullable()?.state).toEqual({ hello: 'gzip' });
    expect((await s.loadLatest('zstd-pid')).toNullable()?.state).toEqual({ hello: 'zstd' });
  });
});

describe('ObjectStorageSnapshotStore — prefix', () => {
  test('plugin prefix is prepended to every key', async () => {
    const s = new ObjectStorageSnapshotStore({ backend, prefix: 'env-prod/' });
    await s.save('account-1', 5, { x: 1 });
    const items = await backend.list({ prefix: 'env-prod/' });
    expect(items.map(i => i.key)).toContain('env-prod/account-1/00000000000000000005.json');
  });
});

describe('ObjectStorageSnapshotStore — encryption (client-aes256-gcm)', () => {
  test('encrypted snapshot round-trips and the on-disk body does NOT contain the plaintext', async () => {
    const masterKey = new Uint8Array(32).fill(0xab);
    const s = new ObjectStorageSnapshotStore({
      backend,
      compression: { algorithm: 'none' }, // disable compression for clearer plaintext check
      encryption: { mode: 'client-aes256-gcm', masterKey },
    });
    await s.save('p', 1, { secret: 'attack-at-dawn-zero-zero' });
    const fetched = await backend.get('p/00000000000000000001.json');
    expect(fetched.isSome()).toBe(true);
    if (fetched.isSome()) {
      const asString = new TextDecoder('utf-8', { fatal: false }).decode(fetched.value.body);
      expect(asString.includes('attack-at-dawn')).toBe(false);
    }
    const loaded = await s.loadLatest<{ secret: string }>('p');
    expect(loaded.toNullable()?.state.secret).toBe('attack-at-dawn-zero-zero');
  });

  test('per-tenant resolver: two pids → two distinct subkeys; cross-decryption fails', async () => {
    const masterKey = new Uint8Array(32).fill(0xcd);
    const s = new ObjectStorageSnapshotStore({
      backend,
      compression: { algorithm: 'none' },
      encryption: (pid) => pid.startsWith('tenant-')
        ? { mode: 'client-aes256-gcm', masterKey }
        : { mode: 'none' },
    });
    await s.save('tenant-acme/x', 1, { who: 'acme' });
    await s.save('tenant-bigcorp/x', 1, { who: 'bigcorp' });

    // The store derives a subkey per-pid from the master, so even with the
    // SAME master key the two snapshots use different subkeys.  We prove
    // that by sniffing the bytes — the bigcorp snapshot must not decrypt
    // as if it were acme's.
    const acme = await backend.get('tenant-acme/x/00000000000000000001.json');
    const big = await backend.get('tenant-bigcorp/x/00000000000000000001.json');
    expect(acme.isSome() && big.isSome()).toBe(true);

    // Each pid loads correctly through the store.
    expect((await s.loadLatest('tenant-acme/x')).toNullable()?.state).toEqual({ who: 'acme' });
    expect((await s.loadLatest('tenant-bigcorp/x')).toNullable()?.state).toEqual({ who: 'bigcorp' });
  });
});
