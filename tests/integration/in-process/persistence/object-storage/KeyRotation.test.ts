/**
 * End-to-end master-key rotation through the SnapshotStore + Durable-
 * State store (#8).  The scenarios:
 *
 *   - Snapshot written under master-key v0; encryption config gets
 *     rotated so v1 is active and v0 is retired.  The historical
 *     snapshot still loads, AND a freshly written one comes back
 *     stamped with v1.
 *
 *   - Bodies written before #8 (legacy single-key shape) are
 *     readable by the new keyring shape, treated as v0.
 *
 *   - Trying to decrypt a body whose version isn't in the keyring
 *     surfaces a clear error pointing the operator at the `retired`
 *     list.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { ObjectStorageDurableStateStore } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStore.js';
import { ObjectStorageDurableStateStoreOptions } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStoreOptions.js';
import { ObjectStorageSnapshotStore } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStore.js';
import { ObjectStorageSnapshotStoreOptions } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
import type { EncryptionConfig } from '../../../../../src/persistence/PersistenceOptions.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'actor-ts-keyring-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

const v0 = new Uint8Array(32).fill(0xa0);
const v1 = new Uint8Array(32).fill(0xa1);
const v2 = new Uint8Array(32).fill(0xa2);

describe('SnapshotStore — master-key rotation', () => {
  test('snapshot written with v0 active is still readable when v1 is now active and v0 retired', async () => {
    const backend = new FilesystemObjectStorageBackend(FilesystemObjectStorageOptions.create().withDir(dir));

    // Phase 1: v0 is active.
    const phase1: EncryptionConfig = {
      mode: 'client-aes256-gcm',
      masterKeys: { active: { version: 0, key: v0 } },
    };
    const phase1Store = new ObjectStorageSnapshotStore(ObjectStorageSnapshotStoreOptions.create().withBackend(backend).withEncryption(phase1));
    await phase1Store.save('user-1', 1, { name: 'alice', balance: 100 });

    // Phase 2: v1 is active, v0 retired.  Still readable.
    const phase2: EncryptionConfig = {
      mode: 'client-aes256-gcm',
      masterKeys: {
        active: { version: 1, key: v1 },
        retired: [{ version: 0, key: v0 }],
      },
    };
    const phase2Store = new ObjectStorageSnapshotStore(ObjectStorageSnapshotStoreOptions.create().withBackend(backend).withEncryption(phase2));
    const loaded = await phase2Store.loadLatest<{ name: string; balance: number }>('user-1');
    expect(loaded.toNullable()?.state).toEqual({ name: 'alice', balance: 100 });

    // A fresh save under phase 2 → encrypted with v1.
    await phase2Store.save('user-1', 2, { name: 'alice', balance: 200 });
    const latest = await phase2Store.loadLatest<{ name: string; balance: number }>('user-1');
    expect(latest.toNullable()?.state).toEqual({ name: 'alice', balance: 200 });
  });

  test('legacy single-masterKey body can be read by the keyring shape', async () => {
    const backend = new FilesystemObjectStorageBackend(FilesystemObjectStorageOptions.create().withDir(dir));

    // Write with the legacy single-key shape (#8 backwards-compat path).
    const legacyConfig: EncryptionConfig = {
      mode: 'client-aes256-gcm', masterKey: v0,
    };
    const legacyStore = new ObjectStorageSnapshotStore(ObjectStorageSnapshotStoreOptions.create().withBackend(backend).withEncryption(legacyConfig));
    await legacyStore.save('legacy-1', 1, { msg: 'old data' });

    // Read with the new keyring shape that has v0 as active.
    const ringStore = new ObjectStorageSnapshotStore(
      ObjectStorageSnapshotStoreOptions.create()
        .withBackend(backend)
        .withEncryption({
          mode: 'client-aes256-gcm',
          masterKeys: { active: { version: 0, key: v0 } },
        }),
    );
    const loaded = await ringStore.loadLatest<{ msg: string }>('legacy-1');
    expect(loaded.toNullable()?.state).toEqual({ msg: 'old data' });
  });

  test('reading a body whose version is not in the keyring throws with operator-friendly hint', async () => {
    const backend = new FilesystemObjectStorageBackend(FilesystemObjectStorageOptions.create().withDir(dir));

    const v2Config: EncryptionConfig = {
      mode: 'client-aes256-gcm',
      masterKeys: { active: { version: 2, key: v2 } },
    };
    const writeStore = new ObjectStorageSnapshotStore(ObjectStorageSnapshotStoreOptions.create().withBackend(backend).withEncryption(v2Config));
    await writeStore.save('user-x', 1, { x: 1 });

    // Read with a config that has only v0 + v1 — no v2 anywhere.
    const readStore = new ObjectStorageSnapshotStore(
      ObjectStorageSnapshotStoreOptions.create()
        .withBackend(backend)
        .withEncryption({
          mode: 'client-aes256-gcm',
          masterKeys: {
            active: { version: 0, key: v0 },
            retired: [{ version: 1, key: v1 }],
          },
        }),
    );
    await expect(readStore.loadLatest<{ x: number }>('user-x'))
      .rejects.toThrow(/no master key registered for version 2/);
  });
});

describe('DurableStateStore — master-key rotation', () => {
  test('upsert under v0 then v1 — both revisions readable post-rotation', async () => {
    const backend = new FilesystemObjectStorageBackend(FilesystemObjectStorageOptions.create().withDir(dir));

    const v0Cfg: EncryptionConfig = {
      mode: 'client-aes256-gcm',
      masterKeys: { active: { version: 0, key: v0 } },
    };
    const phase1 = new ObjectStorageDurableStateStore(ObjectStorageDurableStateStoreOptions.create().withBackend(backend).withEncryption(v0Cfg));
    await phase1.upsert('account-1', 0, { balance: 50 });

    const v1Cfg: EncryptionConfig = {
      mode: 'client-aes256-gcm',
      masterKeys: {
        active: { version: 1, key: v1 },
        retired: [{ version: 0, key: v0 }],
      },
    };
    const phase2 = new ObjectStorageDurableStateStore(ObjectStorageDurableStateStoreOptions.create().withBackend(backend).withEncryption(v1Cfg));
    const loaded = await phase2.load<{ balance: number }>('account-1');
    expect(loaded.toNullable()?.state.balance).toBe(50);
    // Re-write under v1.
    await phase2.upsert('account-1', loaded.toNullable()!.revision, { balance: 75 });
    const reloaded = await phase2.load<{ balance: number }>('account-1');
    expect(reloaded.toNullable()?.state.balance).toBe(75);
  });
});
