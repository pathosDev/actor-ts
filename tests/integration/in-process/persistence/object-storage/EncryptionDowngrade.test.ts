/**
 * Regression suite for #965 — the encryption downgrade.
 *
 * `decodeBody` used to read whether a body is encrypted off the body's own
 * `flags` byte and never hold it against the caller's configuration.  A store
 * configured `client-aes256-gcm` therefore decoded a body whose flags said
 * "not encrypted" as plaintext: anyone with write access to the bucket could
 * replace an actor's encrypted state with five bytes of header and JSON of
 * their choosing, needing no key at all.  The AES-GCM tag authenticates a
 * body that claims to be encrypted; it says nothing about one that claims
 * not to be.
 *
 * Supplying a decryption key is now the assertion "this body is encrypted",
 * held both ways like the integrity key is (#579): a plaintext body is
 * refused unless `allowUnencryptedBodies` opens the migration window.
 *
 * The forged body is produced the way an attacker would: by a writer that
 * holds no key at all — a second store over a second directory with
 * encryption off — and copied over the real object.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { ObjectStorageDurableStateStore } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStore.js';
import { ObjectStorageDurableStateStoreOptions } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStoreOptions.js';
import { ObjectStorageSnapshotStore } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStore.js';
import { ObjectStorageSnapshotStoreOptions } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
import {
  OBJECT_STORAGE_DURABLE_STATE_NAMESPACE,
  OBJECT_STORAGE_SNAPSHOT_NAMESPACE,
  SEQ_PADDING,
} from '../../../../../src/persistence/Constants.js';
import { JournalError } from '../../../../../src/persistence/JournalTypes.js';
import { FLAG_ENCRYPTED, decodeBody, encodeBody } from '../../../../../src/persistence/object-storage/BodyCodec.js';

/** HKDF context — required on every client-side encryption config (#108). */
const info = 'acme/test/encryption-downgrade/v1';
const MASTER_KEY = new Uint8Array(32).fill(9);
const encryption = { mode: 'client-aes256-gcm', masterKey: MASTER_KEY, info } as const;

/** Same stated budget as the sibling suites — see `IntegrityTampering.test.ts`. */
const TEMP_TREE_BUDGET_MS = 30_000;

let honestDir: string;
let forgerDir: string;
let honestBackend: FilesystemObjectStorageBackend;
let forgerBackend: FilesystemObjectStorageBackend;

beforeEach(() => {
  honestDir = mkdtempSync(join(tmpdir(), 'actor-ts-downgrade-honest-'));
  forgerDir = mkdtempSync(join(tmpdir(), 'actor-ts-downgrade-forger-'));
  const honestOptions = FilesystemObjectStorageOptions.create().withDir(honestDir);
  const forgerOptions = FilesystemObjectStorageOptions.create().withDir(forgerDir);
  honestBackend = new FilesystemObjectStorageBackend(honestOptions);
  forgerBackend = new FilesystemObjectStorageBackend(forgerOptions);
}, TEMP_TREE_BUDGET_MS);
afterEach(() => {
  for (const dir of [honestDir, forgerDir]) {
    if (dir === undefined || dir === '') continue;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}, TEMP_TREE_BUDGET_MS);

const stateFile = (dir: string, persistenceId: string) =>
  join(dir, OBJECT_STORAGE_DURABLE_STATE_NAMESPACE, persistenceId, 'state.json');
const snapshotFile = (dir: string, persistenceId: string, seq: number) =>
  join(dir, OBJECT_STORAGE_SNAPSHOT_NAMESPACE, persistenceId, `${String(seq).padStart(SEQ_PADDING, '0')}.json`);

const flagsOf = (path: string) => new Uint8Array(readFileSync(path))[4]!;

async function loadError(load: () => Promise<unknown>): Promise<Error | null> {
  try { await load(); } catch (e) { return e as Error; }
  return null;
}

/** The error's message followed by its cause's — the stores wrap the codec's wording. */
const messageChain = (error: Error | null): string =>
  error === null ? '' : `${error.message} <- ${(error.cause as Error | undefined)?.message ?? ''}`;

type Account = { owner: string; balanceCents: number; role: string };
const HONEST: Account = { owner: 'alice', balanceCents: 1000, role: 'user' };
const FORGED: Account = { owner: 'alice', balanceCents: 999_999_999, role: 'admin' };

describe('#965 — decodeBody holds a plaintext body to a supplied key', () => {
  const plaintext = new TextEncoder().encode('{"forged":true}');

  test('a body without FLAG_ENCRYPTED is refused when a decryption key is supplied', async () => {
    const forged = await encodeBody(plaintext);
    expect(forged[4]! & FLAG_ENCRYPTED).toBe(0);
    const error = await loadError(() => decodeBody(forged, { encryption: { subKey: new Uint8Array(32).fill(1) } }));
    expect(error?.message).toContain('body is not encrypted but a decryption key was supplied');
    expect(error?.message).toContain('allowUnencryptedBodies');
  });

  test('the resolver shape is held to the same rule', async () => {
    const forged = await encodeBody(plaintext);
    const error = await loadError(() => decodeBody(forged, {
      encryption: { subKeyFor: async () => new Uint8Array(32).fill(1) },
    }));
    expect(error?.message).toContain('body is not encrypted');
  });

  test('allowUnencryptedBodies re-admits a plaintext body for the migration window', async () => {
    const forged = await encodeBody(plaintext);
    const decoded = await decodeBody(forged, {
      encryption: { subKey: new Uint8Array(32).fill(1), allowUnencryptedBodies: true },
    });
    expect(decoded.encrypted).toBe(false);
    expect(new TextDecoder().decode(decoded.payload)).toBe('{"forged":true}');
  });

  test('without a key a plaintext body still decodes — nothing asked for encryption', async () => {
    const decoded = await decodeBody(await encodeBody(plaintext));
    expect(decoded.encrypted).toBe(false);
  });
});

describe('#965 — the durable-state store refuses a plaintext body under client-aes256-gcm', () => {
  const honestStore = (allowUnencryptedBodies?: boolean) => {
    const builder = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(honestBackend)
      .withEncryption(encryption);
    const options = allowUnencryptedBodies === undefined ? builder : builder.withAllowUnencryptedBodies(allowUnencryptedBodies);
    return new ObjectStorageDurableStateStore(options);
  };

  /** The issue's walkthrough: a keyless writer's body copied over the encrypted one. */
  async function overwriteWithForgery(): Promise<void> {
    const forgerOptions = ObjectStorageDurableStateStoreOptions.create().withBackend(forgerBackend);
    const forger = new ObjectStorageDurableStateStore(forgerOptions);
    await forger.upsert('account-1', 0, FORGED);
    expect(flagsOf(stateFile(forgerDir, 'account-1')) & FLAG_ENCRYPTED).toBe(0);
    copyFileSync(stateFile(forgerDir, 'account-1'), stateFile(honestDir, 'account-1'));
  }

  test('the honest body is encrypted and round-trips', async () => {
    const store = honestStore();
    await store.upsert('account-1', 0, HONEST);
    expect(flagsOf(stateFile(honestDir, 'account-1')) & FLAG_ENCRYPTED).toBe(FLAG_ENCRYPTED);
    expect((await store.load<Account>('account-1')).toNullable()?.state).toEqual(HONEST);
  });

  test('a forged plaintext body makes load() throw instead of returning the forged state', async () => {
    const writer = honestStore();
    await writer.upsert('account-1', 0, HONEST);
    await overwriteWithForgery();

    const reader = honestStore();
    const error = await loadError(() => reader.load<Account>('account-1'));
    expect(error).toBeInstanceOf(JournalError);
    expect(messageChain(error)).toContain('body is not encrypted');
  });

  test('the per-call encryption an actor passes demands the same', async () => {
    // A store with no default encryption, reached by an actor whose
    // `PersistenceOptions.encryption` says client-aes256-gcm.
    const plainOptions = ObjectStorageDurableStateStoreOptions.create().withBackend(honestBackend);
    const store = new ObjectStorageDurableStateStore(plainOptions);
    await store.upsert('account-1', 0, HONEST, { encryption });
    await overwriteWithForgery();
    store.forgetEtagForTest('account-1');
    const error = await loadError(() => store.load<Account>('account-1', { encryption }));
    expect(error).toBeInstanceOf(JournalError);
    expect(messageChain(error)).toContain('body is not encrypted');
  });

  test('withAllowUnencryptedBodies opens the migration window, and only then is a plaintext body read', async () => {
    await honestStore().upsert('account-1', 0, HONEST);
    await overwriteWithForgery();
    const migrating = honestStore(true);
    expect((await migrating.load<Account>('account-1')).toNullable()?.state).toEqual(FORGED);
    // …and an explicit `false` is the default, not a third reading.
    const closed = honestStore(false);
    expect(await loadError(() => closed.load('account-1'))).toBeInstanceOf(JournalError);
  });
});

describe('#965 — the snapshot store refuses a plaintext body under client-aes256-gcm', () => {
  const honestStore = (allowUnencryptedBodies?: boolean) => {
    const builder = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(honestBackend)
      .withEncryption(encryption);
    const options = allowUnencryptedBodies === undefined ? builder : builder.withAllowUnencryptedBodies(allowUnencryptedBodies);
    return new ObjectStorageSnapshotStore(options);
  };

  async function overwriteWithForgery(): Promise<void> {
    const forgerOptions = ObjectStorageSnapshotStoreOptions.create().withBackend(forgerBackend);
    const forger = new ObjectStorageSnapshotStore(forgerOptions);
    await forger.save('account-1', 5, FORGED);
    expect(flagsOf(snapshotFile(forgerDir, 'account-1', 5)) & FLAG_ENCRYPTED).toBe(0);
    copyFileSync(snapshotFile(forgerDir, 'account-1', 5), snapshotFile(honestDir, 'account-1', 5));
  }

  test('a forged plaintext snapshot makes loadLatest() throw instead of seeding recovery with it', async () => {
    const store = honestStore();
    await store.save('account-1', 5, HONEST);
    expect(flagsOf(snapshotFile(honestDir, 'account-1', 5)) & FLAG_ENCRYPTED).toBe(FLAG_ENCRYPTED);
    await overwriteWithForgery();

    const error = await loadError(() => store.loadLatest<Account>('account-1'));
    expect(error).toBeInstanceOf(JournalError);
    expect(messageChain(error)).toContain('body is not encrypted');
  });

  test('withAllowUnencryptedBodies opens the migration window for snapshots too', async () => {
    const store = honestStore();
    await store.save('account-1', 5, HONEST);
    await overwriteWithForgery();
    const migrating = honestStore(true);
    expect((await migrating.loadLatest<Account>('account-1')).toNullable()?.state).toEqual(FORGED);
  });
});
