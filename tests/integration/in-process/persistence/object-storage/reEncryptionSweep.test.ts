/**
 * Operator-tool test for `reEncryptObjectStorage` (#70).
 *
 * Master-key rotation always leaves historical bodies stamped with the
 * old version — they keep decrypting because the retired key is still
 * in the keyring, but you can't drop the retired entry without first
 * re-encrypting the corpus under the active key.  This is that sweep.
 *
 * Scenarios:
 *   - Sweep rewrites v0-stamped bodies to v1, idempotently (second run
 *     is a pure-skip pass).
 *   - Legacy unversioned bodies (single-masterKey shape) are rewritten
 *     to a versioned body stamped with the active version.
 *   - Bodies already at the active version are skipped on the fast
 *     path — no GET-rewrite churn.
 *   - Non-encrypted ATS1 bodies pass through untouched.
 *   - After a successful sweep, dropping the retired key from the
 *     config still lets every body decrypt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { ObjectStorageSnapshotStore } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStore.js';
import { ObjectStorageSnapshotStoreOptions } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
import { reEncryptObjectStorage } from '../../../../../src/persistence/object-storage/reEncryptionSweep.js';
import type { EncryptionConfig } from '../../../../../src/persistence/PersistenceOptions.js';
import type { ObjectStorageBackend, ObjectFetched } from '../../../../../src/persistence/object-storage/ObjectStorageBackend.js';
import { some, type Option } from '../../../../../src/util/Option.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'actor-ts-reencrypt-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

const v0 = new Uint8Array(32).fill(0xa0);
const v1 = new Uint8Array(32).fill(0xa1);

const ringV0Only: EncryptionConfig = {
  mode: 'client-aes256-gcm',
  masterKeys: { active: { version: 0, key: v0 } },
};
const ringV1ActiveV0Retired: EncryptionConfig = {
  mode: 'client-aes256-gcm',
  masterKeys: {
    active: { version: 1, key: v1 },
    retired: [{ version: 0, key: v0 }],
  },
};
const ringV1Only: EncryptionConfig = {
  mode: 'client-aes256-gcm',
  masterKeys: { active: { version: 1, key: v1 } },
};

describe('reEncryptObjectStorage', () => {
  test('rewrites v0-stamped bodies to v1, then post-sweep config can drop v0 entirely', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);

    // Stage 1: write three snapshots under v0.
    const v0StoreOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption(ringV0Only);
    const v0Store = new ObjectStorageSnapshotStore(v0StoreOptions);
    await v0Store.save('user-1', 1, { balance: 100 });
    await v0Store.save('user-1', 2, { balance: 110 });
    await v0Store.save('user-2', 1, { balance: 500 });

    // Stage 2: sweep with v1 as active, v0 retired.
    const result = await reEncryptObjectStorage(backend, {
      keyPrefix: '',
      keyring: ringV1ActiveV0Retired.mode === 'client-aes256-gcm'
        && 'masterKeys' in ringV1ActiveV0Retired
          ? ringV1ActiveV0Retired.masterKeys
          : (null as never),
    });
    expect(result.scanned).toBe(3);
    expect(result.rewrote).toBe(3);
    expect(result.skippedCurrent).toBe(0);

    // Stage 3: drop the retired entry — the corpus is now decryptable
    // with v1 alone.
    const v1StoreOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption(ringV1Only);
    const v1Store = new ObjectStorageSnapshotStore(v1StoreOptions);
    const u1 = await v1Store.loadLatest<{ balance: number }>('user-1');
    const u2 = await v1Store.loadLatest<{ balance: number }>('user-2');
    expect(u1.toNullable()?.state).toEqual({ balance: 110 });
    expect(u2.toNullable()?.state).toEqual({ balance: 500 });
  });

  test('second sweep is a pure skip-pass (idempotent)', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);
    const v0StoreOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption(ringV0Only);
    const v0Store = new ObjectStorageSnapshotStore(v0StoreOptions);
    await v0Store.save('pid-1', 1, { x: 1 });
    await v0Store.save('pid-2', 1, { x: 2 });

    const ringV1V0Retired = (ringV1ActiveV0Retired as Extract<
      EncryptionConfig, { mode: 'client-aes256-gcm' } & { masterKeys: unknown }
    >).masterKeys;

    const first = await reEncryptObjectStorage(backend, {
      keyPrefix: '', keyring: ringV1V0Retired,
    });
    expect(first.rewrote).toBe(2);

    const second = await reEncryptObjectStorage(backend, {
      keyPrefix: '', keyring: ringV1V0Retired,
    });
    expect(second.scanned).toBe(2);
    expect(second.rewrote).toBe(0);
    expect(second.skippedCurrent).toBe(2);
  });

  test('legacy unversioned bodies are rewritten to versioned active bodies', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);

    // Write under the legacy single-masterKey shape (no version byte
    // in the manifest — pre-#8 wire format).
    const legacyConfig: EncryptionConfig = {
      mode: 'client-aes256-gcm', masterKey: v0,
    };
    const legacyStoreOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption(legacyConfig);
    const legacyStore = new ObjectStorageSnapshotStore(legacyStoreOptions);
    await legacyStore.save('legacy-1', 1, { v: 'old' });

    // Sweep — keyring's v0 retired matches the legacy implicit-v0 path,
    // active becomes v1.
    const ring = (ringV1ActiveV0Retired as Extract<
      EncryptionConfig, { mode: 'client-aes256-gcm' } & { masterKeys: unknown }
    >).masterKeys;
    const result = await reEncryptObjectStorage(backend, {
      keyPrefix: '', keyring: ring,
    });
    expect(result.rewrote).toBe(1);

    // Now the body should decrypt cleanly under v1-only.
    const v1StoreOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption(ringV1Only);
    const v1Store = new ObjectStorageSnapshotStore(v1StoreOptions);
    const loaded = await v1Store.loadLatest<{ v: string }>('legacy-1');
    expect(loaded.toNullable()?.state).toEqual({ v: 'old' });
  });

  test('progress callback fires for every scanned object', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption(ringV0Only);
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('a', 1, { x: 1 });
    await store.save('b', 1, { x: 2 });
    await store.save('c', 1, { x: 3 });

    const events: string[] = [];
    const ring = (ringV1ActiveV0Retired as Extract<
      EncryptionConfig, { mode: 'client-aes256-gcm' } & { masterKeys: unknown }
    >).masterKeys;
    await reEncryptObjectStorage(backend, {
      keyPrefix: '',
      keyring: ring,
      onProgress: (e) => events.push(`${e.action}:${e.key.split('/')[0]}`),
    });
    expect(events.length).toBe(3);
    expect(events).toContain('rewrote:a');
    expect(events).toContain('rewrote:b');
    expect(events).toContain('rewrote:c');
  });

  test('skip predicate excludes matched keys from the sweep', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption(ringV0Only);
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('keep', 1, { x: 1 });
    await store.save('skip', 1, { x: 2 });

    const ring = (ringV1ActiveV0Retired as Extract<
      EncryptionConfig, { mode: 'client-aes256-gcm' } & { masterKeys: unknown }
    >).masterKeys;
    const result = await reEncryptObjectStorage(backend, {
      keyPrefix: '',
      keyring: ring,
      skip: (k) => k.startsWith('skip/'),
    });
    expect(result.scanned).toBe(1);
    expect(result.rewrote).toBe(1);
  });

  test('rejects invalid activeVersion in the keyring', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);
    await expect(reEncryptObjectStorage(backend, {
      keyPrefix: '',
      keyring: { active: { version: 999, key: v0 } },
    })).rejects.toThrow(/version must be an integer in/);
  });
});

/* ============================== #109 — resumability ============================== */

describe('reEncryptObjectStorage — #109 resume + completeness', () => {
  test('persists progress every saveProgressEveryN rewrites and clears on success', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);
    const v0StoreOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption(ringV0Only);
    const v0Store = new ObjectStorageSnapshotStore(v0StoreOptions);
    for (let i = 0; i < 6; i++) await v0Store.save(`pid-${i}`, 1, { x: i });

    const { InMemoryReEncryptProgressStore } = await import(
      '../../../../../src/persistence/object-storage/reEncryptionSweep.js'
    );
    const progress = new InMemoryReEncryptProgressStore();
    const ringV1V0Retired = (ringV1ActiveV0Retired as Extract<
      EncryptionConfig, { mode: 'client-aes256-gcm' } & { masterKeys: unknown }
    >).masterKeys;

    await reEncryptObjectStorage(backend, {
      keyPrefix: '',
      keyring: ringV1V0Retired,
      progress,
      saveProgressEveryN: 2,
    });
    // After a successful sweep, progress.clear() ran → state is reset.
    const cleared = await progress.load();
    expect(cleared.lastKey).toBeNull();
    expect(cleared.processedCount).toBe(0);
  });

  test('resumes from saved lastKey, skipping already-processed items', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);
    const v0StoreOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption(ringV0Only);
    const v0Store = new ObjectStorageSnapshotStore(v0StoreOptions);
    for (let i = 0; i < 5; i++) await v0Store.save(`pid-${i}`, 1, { x: i });

    const { InMemoryReEncryptProgressStore } = await import(
      '../../../../../src/persistence/object-storage/reEncryptionSweep.js'
    );
    const progress = new InMemoryReEncryptProgressStore();
    const ringV1V0Retired = (ringV1ActiveV0Retired as Extract<
      EncryptionConfig, { mode: 'client-aes256-gcm' } & { masterKeys: unknown }
    >).masterKeys;

    // Pre-seed progress as if the first run crashed after processing
    // pid-0 + pid-1 (so lastKey points to pid-1's key).
    const items = await backend.list({ prefix: '' });
    const sorted = [...items].map((i) => i.key).sort();
    await progress.save({ lastKey: sorted[1]!, processedCount: 2 });

    const result = await reEncryptObjectStorage(backend, {
      keyPrefix: '',
      keyring: ringV1V0Retired,
      progress,
    });
    // Only the last 3 keys should have been touched.
    expect(result.rewrote).toBe(3);
    expect(result.scanned).toBe(3);
  });

  test('keyring-completeness pre-check refuses to start when a version is missing', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);
    // Write bodies under v0.
    const v0StoreOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption(ringV0Only);
    const v0Store = new ObjectStorageSnapshotStore(v0StoreOptions);
    await v0Store.save('pid-A', 1, { x: 1 });

    // Try sweeping with a keyring that has only v1 (no retired v0).
    // The bodies are stamped v0, decoder couldn't decrypt them — but
    // we want to fail BEFORE touching the corpus.
    const ringV1NoRetired = (ringV1Only as Extract<
      EncryptionConfig, { mode: 'client-aes256-gcm' } & { masterKeys: unknown }
    >).masterKeys;

    await expect(reEncryptObjectStorage(backend, {
      keyPrefix: '',
      keyring: ringV1NoRetired,
    })).rejects.toThrow(/keyring is incomplete/);
  });

  test('completeness check can be disabled for operators with independent assurance', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);
    const v0StoreOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption(ringV0Only);
    const v0Store = new ObjectStorageSnapshotStore(v0StoreOptions);
    await v0Store.save('pid-A', 1, { x: 1 });

    const ringV1NoRetired = (ringV1Only as Extract<
      EncryptionConfig, { mode: 'client-aes256-gcm' } & { masterKeys: unknown }
    >).masterKeys;

    // With verifyKeyringCompleteness: false, the sweep proceeds and
    // eventually fails at the decode step (not the pre-check) — but
    // not at the boundary.  Confirms the toggle works.
    await expect(reEncryptObjectStorage(backend, {
      keyPrefix: '',
      keyring: ringV1NoRetired,
      verifyKeyringCompleteness: false,
    })).rejects.toThrow(/no master key registered for version 0/);
  });
});

/**
 * Backend whose `list()` reports keys the framework would never write.
 *
 * The real backends validate on `put`, so a malformed key can only enter the
 * corpus out-of-band — which is exactly the threat model: keys come from the
 * bucket, not from us.  A fake is the only way to present one.
 */
class MalformedKeyBackend implements ObjectStorageBackend {
  readonly fetched: string[] = [];
  readonly written: string[] = [];
  constructor(private readonly keys: string[]) {}

  async list(): Promise<Array<{ key: string; size: number }>> {
    return this.keys.map(key => ({ key, size: 1 }));
  }
  async get(key: string): Promise<Option<ObjectFetched>> {
    this.fetched.push(key);
    // A deliberately un-framed body.  The sweep reaches its `skipped-non-ats1`
    // branch, which is enough to show the *key* passed validation without
    // needing a real encrypted body — these tests are about the key check.
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    return some({ body, etag: 'e', contentType: 'application/json' } as unknown as ObjectFetched);
  }
  async put(key: string): Promise<{ etag: string }> {
    this.written.push(key);
    return { etag: 'e2' };
  }
  async delete(): Promise<void> {}
}

describe('reEncryptObjectStorage — malformed keys from list() (#123)', () => {
  const keyring = { active: { version: 1, key: v1 }, retired: [{ version: 0, key: v0 }] };

  test('a key that yields no persistence id is skipped and counted, not swept', async () => {
    // The extracted persistence id is the HKDF salt, and the sweep *rewrites*
    // the body — so a wrong salt is not a failed read, it is data the owning
    // store can never decrypt again.  These keys all yield an empty id under
    // the default extractor.
    const backend = new MalformedKeyBackend(['', '/', 'prefix/']);
    const result = await reEncryptObjectStorage(backend, {
      keyPrefix: 'prefix/', keyring, verifyKeyringCompleteness: false,
    });

    expect(result.skippedMalformedKey).toBe(3);
    expect(result.rewrote).toBe(0);
    // Skipped before the fetch: a key we will not sweep is a key we do not read.
    expect(backend.fetched).toEqual([]);
    expect(backend.written).toEqual([]);
  });

  test('a key carrying control characters is skipped', async () => {
    const backend = new MalformedKeyBackend([`pid${String.fromCharCode(0)}x/snap`, `pid${String.fromCharCode(10)}y/snap`]);
    const result = await reEncryptObjectStorage(backend, {
      keyPrefix: '', keyring, verifyKeyringCompleteness: false,
    });

    expect(result.skippedMalformedKey).toBe(2);
    expect(backend.written).toEqual([]);
  });

  test('well-formed keys are still swept', async () => {
    // The guard must not turn into a blanket refusal.
    const backend = new MalformedKeyBackend(['user-1/snap-1', 'user-2/snap-1']);
    const result = await reEncryptObjectStorage(backend, {
      keyPrefix: '', keyring, verifyKeyringCompleteness: false,
    });

    expect(result.skippedMalformedKey).toBe(0);
    expect(backend.fetched).toHaveLength(2);
    // Reached the framing check, i.e. got past the key check.
    expect(result.skippedNonAts1).toBe(2);
  });
});
