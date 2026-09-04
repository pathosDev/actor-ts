/**
 * The #716 key-layout migration, executed rather than described.
 *
 * #716 moved the durable-state corpus from the flat
 * `<prefix><persistenceId>/state.json` to
 * `<prefix>state/<persistenceId>/state.json`, and the release note told the
 * operator to run the *old* version with the store's `prefix` set to
 * `<prefix>state/` and re-`upsert` every record.  Three things are wrong with
 * that, and the first two describes below are the proof — they pass on the
 * tree that shipped the note:
 *
 *   - a store pointed at the destination cannot READ the source, so the
 *     procedure names no reader at all;
 *   - the natural call, `upsert(id, record.revision, state)`, throws:
 *     the destination is empty, so the compare-and-swap finds no entry to
 *     swap against;
 *   - `upsert(id, 0, state)` is the only form that lands, and it writes
 *     revision 1 over a record that was at 7 — every record in the corpus
 *     rewound to the start of its history.
 *
 * And a fourth, which no `upsert` recipe can reach: a body sealed against its
 * old storage key (#612) does not decode at the new one, so copying the bytes
 * is not a migration either.
 *
 * `migrateObjectStorageDurableStateLayout` is the procedure.  It moves the
 * *body* rather than replaying the record through the store, so the revision
 * and the timestamp are the bytes that were already there, and it re-seals a
 * bound body against its destination key rather than pretending the binding
 * is not there.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OBJECT_STORAGE_DURABLE_STATE_LEAF,
  OBJECT_STORAGE_DURABLE_STATE_NAMESPACE,
  OBJECT_STORAGE_SNAPSHOT_NAMESPACE,
} from '../../../../../src/persistence/Constants.js';
import { DurableStateConcurrencyError } from '../../../../../src/persistence/DurableStateStore.js';
import type { EncryptionConfig, IntegrityConfig } from '../../../../../src/persistence/PersistenceOptions.js';
import { encodeBody } from '../../../../../src/persistence/object-storage/BodyCodec.js';
import {
  DurableStateLayoutMigrationKeyError,
  migrateObjectStorageDurableStateLayout,
} from '../../../../../src/persistence/object-storage/DurableStateLayoutMigration.js';
import { activeEncryptKey, isVersionedKeyShape } from '../../../../../src/persistence/object-storage/Encryption.js';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { ObjectStorageDurableStateStore } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStore.js';
import { ObjectStorageDurableStateStoreOptions } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStoreOptions.js';
import { encodePayload } from '../../../../../src/persistence/storage/PayloadCodec.js';

const PREFIX = 'acme/';
const utf8 = new TextEncoder();

let directory: string;
let backend: FilesystemObjectStorageBackend;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'actor-ts-layout-migration-'));
  const backendOptions = FilesystemObjectStorageOptions.create().withDir(directory);
  backend = new FilesystemObjectStorageBackend(backendOptions);
});

afterEach(() => { try { rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ } });

/** 32 deterministic bytes — a key, not a secret; this corpus lives for one test. */
function keyBytes(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_unused, index) => (seed + index) & 0xff);
}

const masterKey = keyBytes(1);
const integrityKey = keyBytes(101);
const sealedEncryption: EncryptionConfig = {
  mode: 'client-aes256-gcm',
  masterKeys: { active: { version: 3, key: masterKey } },
  info: 'acme/prod/durable-state/v1',
};
const sealedIntegrity: IntegrityConfig = { mode: 'hmac-sha256', integrityKey };

type LegacyRecordSeed = {
  readonly persistenceId: string;
  readonly revision: number;
  readonly state: unknown;
  readonly timestamp: number;
  readonly encryption?: EncryptionConfig;
  readonly integrity?: IntegrityConfig;
  /**
   * Bind the storage key into the body's authenticators, the way every write
   * since #612 does.  Set `false` for a body older than that: it authenticates
   * its own bytes and says nothing about where they live.
   */
  readonly bindContext?: boolean;
};

/**
 * Write one record in the pre-#716 layout, byte-for-byte the way the 0.17.0
 * `ObjectStorageDurableStateStore.upsert` wrote it: the same payload shape,
 * the same framing, and the storage key of *that* layout bound in as the
 * context.  Seeding through the current store would be seeding the corpus the
 * migration is supposed to produce.
 */
async function seedLegacyRecord(seed: LegacyRecordSeed): Promise<string> {
  const sourceKey = `${PREFIX}${seed.persistenceId}/${OBJECT_STORAGE_DURABLE_STATE_LEAF}`;
  const encryption: EncryptionConfig = seed.encryption ?? { mode: 'none' };
  const active = await activeEncryptKey(encryption, seed.persistenceId);
  const body = await encodeBody(
    utf8.encode(encodePayload({ revision: seed.revision, state: seed.state, timestamp: seed.timestamp })),
    {
      compression: 'gzip',
      ...(active !== undefined
        ? {
            encryption: {
              subKey: active.subKey,
              ...(isVersionedKeyShape(encryption) ? { keyVersion: active.keyVersion } : {}),
            },
          }
        : {}),
      ...(seed.integrity?.mode === 'hmac-sha256'
        ? { integrity: { integrityKey: seed.integrity.integrityKey } }
        : {}),
      ...(seed.bindContext === false ? {} : { context: sourceKey }),
    },
  );
  await backend.put(sourceKey, body, { contentType: 'application/json', contentEncoding: 'gzip' });
  return sourceKey;
}

/** A store on the post-#716 layout — the version the operator is upgrading to. */
function newLayoutStore(sealed = false): ObjectStorageDurableStateStore {
  const storeOptions = ObjectStorageDurableStateStoreOptions.create()
    .withBackend(backend)
    .withOwnsBackend(false)
    .withPrefix(PREFIX)
    .withCompression({ algorithm: 'gzip' });
  if (sealed) {
    storeOptions
      .withEncryption(sealedEncryption)
      .withIntegrity(sealedIntegrity)
      .withRequireContextBinding(true);
  }
  return new ObjectStorageDurableStateStore(storeOptions);
}

function newLayoutKeyOf(persistenceId: string): string {
  return `${PREFIX}${OBJECT_STORAGE_DURABLE_STATE_NAMESPACE}${persistenceId}/${OBJECT_STORAGE_DURABLE_STATE_LEAF}`;
}

/* ============ what the shipped note actually does when you run it ========= */

describe('#716 — the note\'s re-upsert recipe, executed', () => {
  test('upsert at the record\'s own revision throws against the empty destination', async () => {
    await seedLegacyRecord({ persistenceId: 'account-1', revision: 7, state: { balance: 700 }, timestamp: 1_000 });
    const store = newLayoutStore();

    // The only call an operator would write from the note: keep the revision
    // the record already has.  The destination key does not exist yet, so the
    // store's cache-refresh load comes back empty and the CAS is refused.
    await expect(store.upsert('account-1', 7, { balance: 700 }))
      .rejects.toBeInstanceOf(DurableStateConcurrencyError);
  });

  test('upsert at revision 0 is the form that lands, and it rewinds the record', async () => {
    await seedLegacyRecord({ persistenceId: 'account-1', revision: 7, state: { balance: 700 }, timestamp: 1_000 });
    const store = newLayoutStore();

    const written = await store.upsert('account-1', 0, { balance: 700 });
    // Seven revisions of history restated as one.  Every CAS the application
    // performs from here on is against the wrong number.
    expect(written.revision).toBe(1);
  });

  test('a byte copy of a sealed body does not decode at its new key', async () => {
    // Why the migration cannot simply be `aws s3 cp` for an encrypted or
    // HMAC-protected corpus: the storage key is inside what the authenticator
    // covers (#612), so moving the bytes invalidates them.
    const sourceKey = await seedLegacyRecord({
      persistenceId: 'account-1',
      revision: 4,
      state: { balance: 400 },
      timestamp: 2_000,
      encryption: sealedEncryption,
      integrity: sealedIntegrity,
    });
    const fetched = await backend.get(sourceKey);
    await backend.put(newLayoutKeyOf('account-1'), fetched.toNullable()!.body, { contentType: 'application/json' });

    const store = newLayoutStore(true);
    await expect(store.load('account-1')).rejects.toThrow();
  });
});

/* ================= the procedure the note should carry =================== */

describe('#716 — migrateObjectStorageDurableStateLayout', () => {
  test('a plain corpus arrives with revisions, state and timestamps intact', async () => {
    await seedLegacyRecord({ persistenceId: 'account-1', revision: 7, state: { balance: 700 }, timestamp: 1_000 });
    await seedLegacyRecord({ persistenceId: 'account-2', revision: 2, state: { balance: 200 }, timestamp: 1_100 });

    const result = await migrateObjectStorageDurableStateLayout(backend, { prefix: PREFIX });
    expect(result.migrated).toBe(2);

    const store = newLayoutStore();
    const first = await store.load<{ balance: number }>('account-1');
    expect(first.toNullable()).toEqual({
      persistenceId: 'account-1', revision: 7, state: { balance: 700 }, timestamp: 1_000,
    });
    const second = await store.load<{ balance: number }>('account-2');
    expect(second.toNullable()?.revision).toBe(2);
  });

  test('the migrated record continues its history rather than restarting it', async () => {
    await seedLegacyRecord({ persistenceId: 'account-1', revision: 7, state: { balance: 700 }, timestamp: 1_000 });
    await migrateObjectStorageDurableStateLayout(backend, { prefix: PREFIX });

    const store = newLayoutStore();
    await store.load('account-1');
    const written = await store.upsert('account-1', 7, { balance: 750 });
    expect(written.revision).toBe(8);
  });

  test('a sealed corpus is re-sealed against its destination key', async () => {
    await seedLegacyRecord({
      persistenceId: 'account-1',
      revision: 4,
      state: { balance: 400 },
      timestamp: 2_000,
      encryption: sealedEncryption,
      integrity: sealedIntegrity,
    });

    const result = await migrateObjectStorageDurableStateLayout(backend, {
      prefix: PREFIX,
      encryption: sealedEncryption,
      integrity: sealedIntegrity,
    });
    expect(result.migrated).toBe(1);

    // `requireContextBinding` is on, so a body that merely decoded would not
    // be enough — this asserts the binding names the new key.
    const store = newLayoutStore(true);
    expect((await store.load<{ balance: number }>('account-1')).toNullable()).toEqual({
      persistenceId: 'account-1', revision: 4, state: { balance: 400 }, timestamp: 2_000,
    });
  });

  test('the source objects survive the migration unless asked to go', async () => {
    const sourceKey = await seedLegacyRecord({
      persistenceId: 'account-1', revision: 7, state: { balance: 700 }, timestamp: 1_000,
    });

    await migrateObjectStorageDurableStateLayout(backend, { prefix: PREFIX });
    expect((await backend.get(sourceKey)).isSome()).toBe(true);

    await migrateObjectStorageDurableStateLayout(backend, { prefix: PREFIX, deleteSource: true });
    expect((await backend.get(sourceKey)).isNone()).toBe(true);
  });

  test('re-running it is a no-op rather than an error or a second write', async () => {
    await seedLegacyRecord({ persistenceId: 'account-1', revision: 7, state: { balance: 700 }, timestamp: 1_000 });

    const first = await migrateObjectStorageDurableStateLayout(backend, { prefix: PREFIX });
    expect(first.migrated).toBe(1);
    const second = await migrateObjectStorageDurableStateLayout(backend, { prefix: PREFIX });
    expect(second.migrated).toBe(0);
    expect(second.skippedAlreadyMigrated).toBe(1);

    const store = newLayoutStore();
    expect((await store.load('account-1')).toNullable()?.revision).toBe(7);
  });

  test('snapshots and already-migrated records are left where they are', async () => {
    await seedLegacyRecord({ persistenceId: 'account-1', revision: 7, state: { balance: 700 }, timestamp: 1_000 });
    const snapshotKey = `${PREFIX}${OBJECT_STORAGE_SNAPSHOT_NAMESPACE}account-1/00000000000000000009.json`;
    await backend.put(snapshotKey, utf8.encode('a snapshot body'), { contentType: 'application/json' });

    const result = await migrateObjectStorageDurableStateLayout(backend, { prefix: PREFIX });

    expect(result.migrated).toBe(1);
    // The snapshot corpus needs no migration and must not be touched by one.
    const snapshot = await backend.get(snapshotKey);
    expect(new TextDecoder().decode(snapshot.toNullable()!.body)).toBe('a snapshot body');
  });

  test('a pre-binding tagged body keeps its tag, verified at the new key', async () => {
    // The corpus a 0.17.x bucket actually holds is mixed: bodies written
    // before #612 authenticate their bytes and not their key, so they move
    // verbatim.  Verbatim has to mean the tag comes along — a migration that
    // quietly dropped it would leave the corpus readable and unprotected,
    // which is the failure nobody notices.
    await seedLegacyRecord({
      persistenceId: 'account-1',
      revision: 6,
      state: { balance: 600 },
      timestamp: 4_000,
      integrity: sealedIntegrity,
      bindContext: false,
    });

    await migrateObjectStorageDurableStateLayout(backend, { prefix: PREFIX, integrity: sealedIntegrity });

    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withOwnsBackend(false)
      .withPrefix(PREFIX)
      .withCompression({ algorithm: 'gzip' })
      .withIntegrity(sealedIntegrity);
    // The store demands a tag on every body once an integrity key is
    // configured, so a load that succeeds is the tag surviving the move.
    const store = new ObjectStorageDurableStateStore(storeOptions);
    expect((await store.load('account-1')).toNullable()?.revision).toBe(6);
  });

  test('a sealed body with no key supplied is refused, and nothing is written', async () => {
    await seedLegacyRecord({
      persistenceId: 'account-1',
      revision: 4,
      state: { balance: 400 },
      timestamp: 2_000,
      encryption: sealedEncryption,
      integrity: sealedIntegrity,
    });

    await expect(migrateObjectStorageDurableStateLayout(backend, { prefix: PREFIX }))
      .rejects.toBeInstanceOf(DurableStateLayoutMigrationKeyError);
    // Refusing has to mean refusing: half a record at the destination would
    // be indistinguishable from a finished migration on the next run.
    expect((await backend.get(newLayoutKeyOf('account-1'))).isNone()).toBe(true);
  });

  test('an entity named after the destination namespace migrates too', async () => {
    // `state` is a legal persistenceId, so its old key is `<prefix>state/state.json`
    // — one segment shorter than a migrated record and therefore not one.  A
    // filter that excluded everything under `state/` would strand this entity
    // silently, which is the worst shape a migration bug can take.
    await seedLegacyRecord({ persistenceId: 'state', revision: 5, state: { balance: 500 }, timestamp: 3_000 });

    const result = await migrateObjectStorageDurableStateLayout(backend, { prefix: PREFIX });
    expect(result.migrated).toBe(1);

    const store = newLayoutStore();
    expect((await store.load('state')).toNullable()?.revision).toBe(5);
  });
});
