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
import {
  InMemoryReEncryptProgressStore,
  ReEncryptIncompleteError,
  reEncryptObjectStorage,
} from '../../../../../src/persistence/object-storage/ReEncryptionSweep.js';
import { MAX_REPORTED_MALFORMED_KEYS } from '../../../../../src/persistence/Constants.js';
import type { EncryptionConfig } from '../../../../../src/persistence/PersistenceOptions.js';
import type { ObjectStorageBackend, ObjectFetched, ObjectInfo } from '../../../../../src/persistence/object-storage/ObjectStorageBackend.js';
import { some, type Option } from '../../../../../src/util/Option.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'actor-ts-reencrypt-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

const v0 = new Uint8Array(32).fill(0xa0);
const v1 = new Uint8Array(32).fill(0xa1);
/** HKDF context — required on every client-side encryption config (#108). */
const info = 'acme/test/snapshot/v1';

const ringV0Only: EncryptionConfig = {
  mode: 'client-aes256-gcm',
  masterKeys: { active: { version: 0, key: v0 } },
  info,
};
const ringV1ActiveV0Retired: EncryptionConfig = {
  mode: 'client-aes256-gcm',
  masterKeys: {
    active: { version: 1, key: v1 },
    retired: [{ version: 0, key: v0 }],
  },
  info,
};
const ringV1Only: EncryptionConfig = {
  mode: 'client-aes256-gcm',
  masterKeys: { active: { version: 1, key: v1 } },
  info,
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
      info,
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
      keyPrefix: '', keyring: ringV1V0Retired, info,
    });
    expect(first.rewrote).toBe(2);

    const second = await reEncryptObjectStorage(backend, {
      keyPrefix: '', keyring: ringV1V0Retired, info,
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
      mode: 'client-aes256-gcm', masterKey: v0, info,
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
      keyPrefix: '', keyring: ring, info,
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
      info,
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
      info,
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
      info,
    })).rejects.toThrow(/version must be an integer in/);
  });
});

/* ========================= #108 — HKDF context rotation ========================= */

/**
 * `info` is the HKDF context.  Unlike the master-key version it is NOT
 * recorded in the body manifest, so the sweep's version fast-path is
 * blind to it — the reason `newInfo` has to switch that fast-path off.
 * These tests pin both halves: that a context rotation actually rewrites
 * the corpus, and that it does not quietly report success having done
 * nothing.
 */
describe('reEncryptObjectStorage — #108 info rotation', () => {
  const oldInfo = 'actor-ts/snapshot/v1';
  const newInfo = 'acme/prod/snapshot/v1';

  /** Ring whose active version equals the one the corpus was written under. */
  const sameVersionRing = { active: { version: 1, key: v1 } };

  async function writeCorpus(
    backend: FilesystemObjectStorageBackend, hkdfInfo: string,
  ): Promise<void> {
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption({
        mode: 'client-aes256-gcm',
        masterKeys: sameVersionRing,
        info: hkdfInfo,
      });
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('user-1', 1, { balance: 100 });
    await store.save('user-2', 1, { balance: 200 });
  }

  test('rotates the context even when the key version does not change', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create().withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);
    await writeCorpus(backend, oldInfo);

    const result = await reEncryptObjectStorage(backend, {
      keyPrefix: '',
      keyring: sameVersionRing,
      info: oldInfo,
      newInfo,
    });

    // The trap: the version fast-path would call every one of these
    // 'skipped-current' and the sweep would be a no-op.
    expect(result.scanned).toBe(2);
    expect(result.rewrote).toBe(2);
    expect(result.skippedCurrent).toBe(0);

    // The corpus now reads under the new context only.
    const newContextOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption({ mode: 'client-aes256-gcm', masterKeys: sameVersionRing, info: newInfo });
    const newContextStore = new ObjectStorageSnapshotStore(newContextOptions);
    const loaded = await newContextStore.loadLatest<{ balance: number }>('user-1');
    expect(loaded.toNullable()?.state).toEqual({ balance: 100 });

    const oldContextOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption({ mode: 'client-aes256-gcm', masterKeys: sameVersionRing, info: oldInfo });
    const oldContextStore = new ObjectStorageSnapshotStore(oldContextOptions);
    await expect(oldContextStore.loadLatest<{ balance: number }>('user-1')).rejects.toThrow();
  });

  test('re-running a completed info rotation stays idempotent', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create().withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);
    await writeCorpus(backend, oldInfo);

    const options = { keyPrefix: '', keyring: sameVersionRing, info: oldInfo, newInfo };
    const first = await reEncryptObjectStorage(backend, options);
    expect(first.rewrote).toBe(2);

    // Second pass: every body is already under `newInfo`, so decrypting
    // with `info` fails.  Without the probe-the-target-context fallback
    // this run would abort on the first object.
    const second = await reEncryptObjectStorage(backend, options);
    expect(second.scanned).toBe(2);
    expect(second.rewrote).toBe(0);
    expect(second.skippedCurrent).toBe(2);
  });

  test('a body decryptable under neither context still raises the original error', async () => {
    // The fallback must not turn a genuinely broken corpus into a skip.
    const backendOptions = FilesystemObjectStorageOptions.create().withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);
    await writeCorpus(backend, 'some/third/context/v1');

    await expect(reEncryptObjectStorage(backend, {
      keyPrefix: '',
      keyring: sameVersionRing,
      info: oldInfo,
      newInfo,
    })).rejects.toThrow();
  });

  test('newInfo equal to info leaves the fast-path intact', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create().withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);
    await writeCorpus(backend, oldInfo);

    const result = await reEncryptObjectStorage(backend, {
      keyPrefix: '',
      keyring: sameVersionRing,
      info: oldInfo,
      newInfo: oldInfo,
    });
    expect(result.rewrote).toBe(0);
    expect(result.skippedCurrent).toBe(2);
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
      '../../../../../src/persistence/object-storage/ReEncryptionSweep.js'
    );
    const progress = new InMemoryReEncryptProgressStore();
    const ringV1V0Retired = (ringV1ActiveV0Retired as Extract<
      EncryptionConfig, { mode: 'client-aes256-gcm' } & { masterKeys: unknown }
    >).masterKeys;

    await reEncryptObjectStorage(backend, {
      keyPrefix: '',
      keyring: ringV1V0Retired,
      info,
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
      '../../../../../src/persistence/object-storage/ReEncryptionSweep.js'
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
      info,
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
      info,
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
      info,
      verifyKeyringCompleteness: false,
    })).rejects.toThrow(/no master key registered for version 0/);
  });

  // #1353.  The `??` default is clamped to the corpus, the explicit
  // override was not — so `sampleSize` past the end walked `items` off
  // its tail and died on `undefined.key` before rewriting anything.
  // The rolling-migration runbook suggests `sampleSize: 200` verbatim,
  // which made every bucket holding fewer than 200 objects a TypeError.
  test('a sampleSize larger than the corpus samples every object instead of walking off the end', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);
    const v0StoreOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption(ringV0Only);
    const v0Store = new ObjectStorageSnapshotStore(v0StoreOptions);
    await v0Store.save('pid-A', 1, { x: 1 });
    await v0Store.save('pid-B', 1, { x: 2 });

    const ringV1V0Retired = (ringV1ActiveV0Retired as Extract<
      EncryptionConfig, { mode: 'client-aes256-gcm' } & { masterKeys: unknown }
    >).masterKeys;

    // Two objects, the runbook's suggested override.
    const result = await reEncryptObjectStorage(backend, {
      keyPrefix: '',
      keyring: ringV1V0Retired,
      info,
      sampleSize: 200,
    });
    expect(result.scanned).toBe(2);
    expect(result.rewrote).toBe(2);

    // The oversized sample still did its job: a ring missing the
    // retired v0 is refused, not waved through.
    const ringV1NoRetired = (ringV1Only as Extract<
      EncryptionConfig, { mode: 'client-aes256-gcm' } & { masterKeys: unknown }
    >).masterKeys;
    const otherDirBackend = new FilesystemObjectStorageBackend(
      FilesystemObjectStorageOptions.create().withDir(mkdtempSync(join(tmpdir(), 'actor-ts-reencrypt-'))),
    );
    const staleStore = new ObjectStorageSnapshotStore(
      ObjectStorageSnapshotStoreOptions.create()
        .withBackend(otherDirBackend)
        .withEncryption(ringV0Only),
    );
    await staleStore.save('pid-C', 1, { x: 3 });
    await expect(reEncryptObjectStorage(otherDirBackend, {
      keyPrefix: '',
      keyring: ringV1NoRetired,
      info,
      sampleSize: 200,
    })).rejects.toThrow(/keyring is incomplete/);
  });

  // The two dereference sites in the sampler are `options.skip?.(item.key)`
  // and `backend.get(item.key)`; optional chaining short-circuits the
  // first when no predicate is passed, so a skip predicate is what
  // reaches it.  Pins both.
  test('a sampleSize larger than the corpus is safe with a skip predicate too', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);
    const v0StoreOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption(ringV0Only);
    const v0Store = new ObjectStorageSnapshotStore(v0StoreOptions);
    await v0Store.save('pid-A', 1, { x: 1 });
    await v0Store.save('pid-B', 1, { x: 2 });

    const ringV1V0Retired = (ringV1ActiveV0Retired as Extract<
      EncryptionConfig, { mode: 'client-aes256-gcm' } & { masterKeys: unknown }
    >).masterKeys;

    const result = await reEncryptObjectStorage(backend, {
      keyPrefix: '',
      keyring: ringV1V0Retired,
      info,
      sampleSize: 200,
      skip: (key) => key.includes('pid-B'),
    });
    expect(result.scanned).toBe(1);
    expect(result.rewrote).toBe(1);
  });
});

/**
 * Backend whose `list()` reports keys the framework would never write.
 *
 * Keys come from the bucket, not from us — that is the threat model, and a
 * fake is the only way to present one.
 *
 * The rationale that stood here before #747 claimed such a key "can only
 * enter the corpus out-of-band" because "the real backends validate on
 * `put`".  That was false in both directions at the time: the S3 backend
 * validated nothing at all, and the filesystem backend's rules did not
 * include `rejectControlChars`, so it wrote a key containing 0x01 or 0x0A
 * that the sweep then refused.  Both write paths reject those keys now, which
 * is what finally makes the sentence true — and the agreement is pinned by
 * `tests/unit/persistence/storage/KeyValidator.test.ts` rather than by a
 * comment.
 */
class MalformedKeyBackend implements ObjectStorageBackend {
  readonly fetched: string[] = [];
  readonly written: string[] = [];
  constructor(private readonly keys: string[]) {}

  async list(): Promise<ObjectInfo[]> {
    return this.keys.map(key => ({ key, size: 1, lastModified: new Date(0) }));
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

  /** Runs the sweep and returns the `ReEncryptIncompleteError` it must throw. */
  const expectIncomplete = async (
    backend: ObjectStorageBackend,
    keyPrefix: string,
  ): Promise<ReEncryptIncompleteError> => {
    try {
      await reEncryptObjectStorage(backend, {
        keyPrefix, keyring, info, verifyKeyringCompleteness: false,
      });
    } catch (thrown) {
      if (thrown instanceof ReEncryptIncompleteError) return thrown;
      throw thrown;
    }
    throw new Error('expected the sweep to refuse to certify the corpus, but it returned');
  };

  test('a key that yields no persistence id is skipped, counted, and fails the sweep', async () => {
    // The extracted persistence id is the HKDF salt, and the sweep *rewrites*
    // the body — so a wrong salt is not a failed read, it is data the owning
    // store can never decrypt again.  These keys all yield an empty id under
    // the default extractor.
    const backend = new MalformedKeyBackend(['', '/', 'prefix/']);
    const error = await expectIncomplete(backend, 'prefix/');

    expect(error.result.skippedMalformedKey).toBe(3);
    expect(error.result.rewrote).toBe(0);
    expect(error.malformedKeys).toEqual(['', '/', 'prefix/']);
    // Skipped before the fetch: a key we will not sweep is a key we do not read.
    expect(backend.fetched).toEqual([]);
    expect(backend.written).toEqual([]);
  });

  test('a key carrying control characters is skipped', async () => {
    const backend = new MalformedKeyBackend([`pid${String.fromCharCode(0)}x/snap`, `pid${String.fromCharCode(10)}y/snap`]);
    const error = await expectIncomplete(backend, '');

    expect(error.result.skippedMalformedKey).toBe(2);
    expect(backend.written).toEqual([]);
  });

  /**
   * #747 — the counter was the whole defence, and the runbook never read it.
   *
   * The rotation runbook's next step after a returning sweep is dropping the
   * retired master key, and every object counted here is still encrypted
   * under it.  So the sweep has to refuse to return rather than hand back a
   * result that has to be inspected to notice.
   */
  test('the failure names the offending keys and says not to drop the retired key', async () => {
    const backend = new MalformedKeyBackend(['tenant/user-1/snap.json']);
    const error = await expectIncomplete(backend, '');

    expect(error.name).toBe('ReEncryptIncompleteError');
    expect(error.message).toContain('tenant/user-1/snap.json');
    expect(error.message).toMatch(/do NOT drop the retired master key/i);
  });

  test('healthy objects are still rotated before the pass refuses to certify', async () => {
    // Failing at the end rather than at the first bad key: the operator gets
    // every offender from one run, and the work that *could* be done was.
    const backend = new MalformedKeyBackend(['good-1/snap', 'tenant/nested/snap', 'good-2/snap']);
    const error = await expectIncomplete(backend, '');

    expect(error.result.skippedMalformedKey).toBe(1);
    // Both healthy keys were read; only the nested one never was.
    expect(backend.fetched).toEqual(['good-1/snap', 'good-2/snap']);
    expect(error.result.skippedNonAts1).toBe(2);
  });

  test('a sample of at most MAX_REPORTED_MALFORMED_KEYS keys is carried, the count is exact', async () => {
    // An all-malformed corpus must not pin one retained string per object.
    const keys = Array.from({ length: MAX_REPORTED_MALFORMED_KEYS + 5 }, (_, i) => `a/b/${i}`);
    const error = await expectIncomplete(new MalformedKeyBackend(keys), '');

    expect(error.result.skippedMalformedKey).toBe(keys.length);
    expect(error.malformedKeys).toHaveLength(MAX_REPORTED_MALFORMED_KEYS);
    expect(error.message).toContain(`+5 more`);
  });

  test('the skip predicate is the escape hatch for objects that are not ours', async () => {
    // Excluding a foreign object is how an operator gets a certifying run
    // back — the sweep never adds an "ignore this" option, because ignoring
    // is what it stopped doing.
    const backend = new MalformedKeyBackend(['vendor/export/dump.csv', 'user-1/snap']);
    const result = await reEncryptObjectStorage(backend, {
      keyPrefix: '', keyring, info, verifyKeyringCompleteness: false,
      skip: (key) => key.startsWith('vendor/'),
    });

    expect(result.skippedMalformedKey).toBe(0);
    expect(backend.fetched).toEqual(['user-1/snap']);
  });

  test('well-formed keys are still swept', async () => {
    // The guard must not turn into a blanket refusal.
    const backend = new MalformedKeyBackend(['user-1/snap-1', 'user-2/snap-1']);
    const result = await reEncryptObjectStorage(backend, {
      keyPrefix: '', keyring, info, verifyKeyringCompleteness: false,
    });

    expect(result.skippedMalformedKey).toBe(0);
    expect(backend.fetched).toHaveLength(2);
    // Reached the framing check, i.e. got past the key check.
    expect(result.skippedNonAts1).toBe(2);
  });
});

/**
 * #747 — the invariant the three rule sets exist to hold: **a key this
 * framework can write is a key the sweep can process.**
 *
 * Stated behaviourally against the real backend rather than by comparing rule
 * objects, because the rule objects are not what an operator meets.  Whatever
 * `put` accepts, the sweep must not count as malformed — otherwise the body
 * is written under the retired key and left there while the run reports
 * success.  Before the fix the filesystem backend accepted a control
 * character and the sweep refused it, which is the gap this closes.
 */
describe('reEncryptObjectStorage — write path and sweep agree on every key (#747)', () => {
  const keyring = { active: { version: 1, key: v1 }, retired: [{ version: 0, key: v0 }] };

  /**
   * Adversarial but plausible key shapes, all `<pid>/<leaf>` so the default
   * extractor has something to work with.  Composed rather than written as
   * literals where a control byte is involved.
   */
  const candidateKeys = [
    'user-1/snap.json',
    'user 1/snap.json',                                   // space
    'a..b/snap.json',                                     // dots that are not a segment
    'ünïcodé/snap.json',                   // 2-byte UTF-8
    'ユーザー/snap.json',                 // 3-byte UTF-8
    'dm-channel-alice|bob/snap.json',                     // a documented legitimate pid shape
    `pid${String.fromCharCode(1)}x/snap.json`,            // SOH — POSIX-legal, sweep-hostile
    `pid${String.fromCharCode(10)}y/snap.json`,           // newline
    `pid${String.fromCharCode(127)}z/snap.json`,          // DEL — the one NTFS also permits
  ];

  test('every key the filesystem backend accepts is one the sweep processes', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);

    const accepted: string[] = [];
    for (const key of candidateKeys) {
      // A rejection may come from the validator or from the OS (NTFS refuses
      // 0x01-0x1F in a filename outright).  Either way the key never entered
      // the corpus, so it is not the sweep's problem.
      try {
        await backend.put(key, new Uint8Array([1, 2, 3, 4, 5]));
        accepted.push(key);
      } catch { /* not writable here — nothing to agree about */ }
    }
    // The corpus has to contain something, or the assertion below is vacuous.
    expect(accepted).toContain('user-1/snap.json');
    expect(accepted).not.toContain(`pid${String.fromCharCode(127)}z/snap.json`);

    // No throw is the assertion: a single malformed key fails the sweep now.
    const result = await reEncryptObjectStorage(backend, {
      keyPrefix: '', keyring, info, verifyKeyringCompleteness: false,
    });
    expect(result.skippedMalformedKey).toBe(0);
    expect(result.scanned).toBe(accepted.length);
    // Unframed bodies, so every one lands in the non-ATS1 bucket — which is
    // past the key check, and that is what is being proven.
    expect(result.skippedNonAts1).toBe(accepted.length);
  });
});

/**
 * #747 — `defaultPidFromKey` used to take the first segment after the prefix
 * and discard the rest, so a key with an extra level yielded a *plausible*
 * persistence id rather than no id at all.  That is the dangerous shape: an
 * empty id was already refused, a wrong-but-plausible one was accepted and
 * became the HKDF salt of a body the sweep then rewrote.
 */
describe('reEncryptObjectStorage — the default pid extractor refuses ambiguous keys (#747)', () => {
  const keyring = { active: { version: 1, key: v1 }, retired: [{ version: 0, key: v0 }] };

  const sweep = async (backend: ObjectStorageBackend, keyPrefix: string): Promise<void> => {
    await reEncryptObjectStorage(backend, {
      keyPrefix, keyring, info, verifyKeyringCompleteness: false,
    });
  };

  test('a persistenceId containing a slash is refused, not truncated to its first segment', async () => {
    // Pre-fix this yielded 'tenant' — one salt shared by every pid under that
    // tenant, and the body rewritten under it.
    const backend = new MalformedKeyBackend(['snap/tenant/user-1/00000000000000000001.json']);
    await expect(sweep(backend, 'snap/')).rejects.toThrow(ReEncryptIncompleteError);
    expect(backend.fetched).toEqual([]);
  });

  test('a keyPrefix shorter than the store prefix is refused rather than salting on the prefix', async () => {
    // Store writes under 'snapshots/prod/', operator sweeps 'snapshots/'.
    // Pre-fix every key in the corpus yielded 'prod'.  The persistenceId
    // validator (#133) cannot catch this one: the bad segment is not the id.
    const backend = new MalformedKeyBackend([
      'snapshots/prod/user-1/00000000000000000001.json',
      'snapshots/prod/user-2/00000000000000000001.json',
    ]);
    await expect(sweep(backend, 'snapshots/')).rejects.toThrow(ReEncryptIncompleteError);
    expect(backend.written).toEqual([]);
  });

  test('a key with no leaf after the pid is refused', async () => {
    await expect(sweep(new MalformedKeyBackend(['user-1/']), '')).rejects.toThrow(ReEncryptIncompleteError);
  });

  test('a key not under the sweep prefix at all is refused', async () => {
    await expect(sweep(new MalformedKeyBackend(['elsewhere/user-1/snap']), 'snap/'))
      .rejects.toThrow(ReEncryptIncompleteError);
  });

  test('both built-in store layouts are accepted', async () => {
    // `<prefix><pid>/<seq>.json` (snapshots) and `<prefix><pid>/state.json`
    // (durable state) — the two layouts the extractor exists for.
    const backend = new MalformedKeyBackend([
      'snap/user-1/00000000000000000007.json',
      'snap/user-2/state.json',
    ]);
    await sweep(backend, 'snap/');
    expect(backend.fetched).toEqual(['snap/user-1/00000000000000000007.json', 'snap/user-2/state.json']);
  });

  test('a custom pidFromKey still decides for a layout the default cannot express', async () => {
    // Refusing deeper nesting is a statement about the *default* extractor,
    // not a cap on what the sweep can handle.
    const backend = new MalformedKeyBackend(['snap/tenant/user-1/00000000000000000001.json']);
    const result = await reEncryptObjectStorage(backend, {
      keyPrefix: 'snap/', keyring, info, verifyKeyringCompleteness: false,
      pidFromKey: (key) => key.split('/').slice(1, 3).join('/'),
    });

    expect(result.skippedMalformedKey).toBe(0);
    expect(backend.fetched).toEqual(['snap/tenant/user-1/00000000000000000001.json']);
  });

  test('a custom pidFromKey that throws is counted rather than crashing the sweep', async () => {
    const backend = new MalformedKeyBackend(['user-1/snap']);
    await expect(reEncryptObjectStorage(backend, {
      keyPrefix: '', keyring, info, verifyKeyringCompleteness: false,
      pidFromKey: () => { throw new Error('unrecognised layout'); },
    })).rejects.toThrow(ReEncryptIncompleteError);
  });
});

/**
 * #747 — the progress store must not let a later run inherit a clean bill of
 * health for a corpus this one refused.
 */
describe('reEncryptObjectStorage — a refused pass leaves no resume state (#747)', () => {
  const keyring = { active: { version: 1, key: v1 }, retired: [{ version: 0, key: v0 }] };

  test('resume state is cleared before the pass refuses, so a re-run re-detects', async () => {
    const progress = new InMemoryReEncryptProgressStore();
    // Sorts before the corpus, so the resume scan skips nothing and the
    // malformed key is actually reached — the state is here to be *cleared*,
    // not to skip past anything.
    await progress.save({ lastKey: 'AAA-earlier-run', processedCount: 10 });
    const backend = new MalformedKeyBackend(['aaa/nested/snap']);

    await expect(reEncryptObjectStorage(backend, {
      keyPrefix: '', keyring, info, verifyKeyringCompleteness: false, progress,
    })).rejects.toThrow(ReEncryptIncompleteError);

    // Had the resume state survived, the re-run would start past the bad key
    // and return a result reading `skippedMalformedKey: 0` — a clean verdict
    // on the corpus that just failed.
    expect(await progress.load()).toEqual({ lastKey: null, processedCount: 0 });
    await expect(reEncryptObjectStorage(backend, {
      keyPrefix: '', keyring, info, verifyKeyringCompleteness: false, progress,
    })).rejects.toThrow(ReEncryptIncompleteError);
  });
});
