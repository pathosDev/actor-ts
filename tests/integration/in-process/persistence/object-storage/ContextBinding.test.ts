/**
 * Regression suite for #612 — nothing bound a body to the storage key
 * it lived at, so an authentic body replayed onto another key verified.
 *
 * Both authenticators covered the bytes and stopped there.  AES-GCM's
 * tag proves the holder of the subkey produced this ciphertext;  the
 * HMAC proves the holder of the integrity key produced these framed
 * bytes.  Neither said *which object* the bytes belonged to, and the
 * integrity key in particular is one flat deployment-wide secret with
 * no per-`persistenceId` derivation at all — so one pid's body copied
 * onto another pid's key verified cleanly and came back as that other
 * pid's state.
 *
 * Fix, in two halves:
 *
 *   1. The storage key goes into the AES-GCM AAD and into the HMAC
 *      input (length-prefixed), marked with `FLAG_CONTEXT_BOUND`.
 *   2. `requireContextBinding` refuses bodies that carry no binding —
 *      necessary because the flag is a manifest byte, so until it is
 *      set, one authentic pre-binding body is a replay token.
 *
 * The same-pid rollback (an authentic OLDER body over a newer one)
 * cannot be caught by binding at all — the key is identical and the
 * revision sits inside the authenticated bytes.  That is what the
 * in-process `rejectRevisionRollback` floor is for.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { ObjectStorageDurableStateStore } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStore.js';
import { ObjectStorageDurableStateStoreOptions, type ObjectStorageDurableStateStoreOptionsBuilder } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStoreOptions.js';
import { ObjectStorageSnapshotStore } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStore.js';
import { ObjectStorageSnapshotStoreOptions } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
import { reEncryptObjectStorage } from '../../../../../src/persistence/object-storage/ReEncryptionSweep.js';
import {
  OBJECT_STORAGE_DURABLE_STATE_NAMESPACE,
  OBJECT_STORAGE_SNAPSHOT_NAMESPACE,
  SEQ_PADDING,
} from '../../../../../src/persistence/Constants.js';
import { JournalError } from '../../../../../src/persistence/JournalTypes.js';
import {
  FLAG_CONTEXT_BOUND,
  FLAG_INTEGRITY_HMAC,
  decodeBody,
  encodeBody,
} from '../../../../../src/persistence/object-storage/BodyCodec.js';

let dir: string;
let backend: FilesystemObjectStorageBackend;

/** HKDF context — required on every client-side encryption config (#108). */
const info = 'acme/test/state/v1';

const INTEGRITY_KEY = new Uint8Array(32).fill(7);
const MASTER_KEY = new Uint8Array(32).fill(9);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'actor-ts-context-'));
  const backendOptions = FilesystemObjectStorageOptions.create()
    .withDir(dir);
  backend = new FilesystemObjectStorageBackend(backendOptions);
});
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

/**
 * On-disk path of a durable-state record, and of a snapshot.  Both carry the
 * namespace segment their store owns (#716) — the two corpora no longer share
 * a directory even when they share a `prefix`.
 */
function bodyFileFor(persistenceId: string, prefix = ''): string {
  return join(dir, prefix, OBJECT_STORAGE_DURABLE_STATE_NAMESPACE, persistenceId, 'state.json');
}

function snapshotFileFor(persistenceId: string, seq: number): string {
  return join(
    dir,
    OBJECT_STORAGE_SNAPSHOT_NAMESPACE,
    persistenceId,
    `${String(seq).padStart(SEQ_PADDING, '0')}.json`,
  );
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

async function caught(run: () => Promise<unknown>): Promise<Error | null> {
  try { await run(); return null; } catch (e) { return e as Error; }
}

/* ===================== the exploit, and what closes it ==================== */

describe('#612 — cross-persistenceId replay under unencrypted + HMAC', () => {
  test('one pid\'s authentic body replayed onto another pid\'s key is refused', async () => {
    // The configuration the docs describe: no client-side encryption,
    // a flat deployment-wide integrity key.  Nothing here derives per
    // pid, so before the binding the tag was equally valid everywhere.
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const store = new ObjectStorageDurableStateStore(storeOptions);

    await store.upsert('alice', 0, { balance: 1_000_000 });
    await store.upsert('bob', 0, { balance: 1 });

    // Attacker with bucket write access copies alice's whole object —
    // manifest, payload, tag, untouched — onto bob's key.  Both are at
    // revision 1, so the rollback floor has nothing to say about it and
    // only the binding can catch this.
    writeFileSync(bodyFileFor('bob'), readFileSync(bodyFileFor('alice')));

    store.forgetEtagForTest('bob');
    const error = await caught(() => store.load('bob'));
    expect(error).toBeInstanceOf(JournalError);
    expect(error!.message).toContain('integrity / decode failure');
  });

  test('the binding is what catches it — an unbound body of the same shape verifies', async () => {
    // Proves the previous test is about the storage key and not about
    // something else in the frame: the identical payload, signed with
    // the identical key but WITHOUT a context, still verifies at a
    // foreign key.  This is precisely the pre-#612 body, and it is the
    // reason `requireContextBinding` has to exist.
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const store = new ObjectStorageDurableStateStore(storeOptions);
    await store.upsert('bob', 0, { balance: 1 });

    const legacyAliceBody = await encodeBody(
      utf8(JSON.stringify({ revision: 1, state: { balance: 1_000_000 }, timestamp: Date.now() })),
      { compression: 'none', integrity: { integrityKey: INTEGRITY_KEY } },
    );
    expect(legacyAliceBody[4]! & FLAG_CONTEXT_BOUND).toBe(0);
    writeFileSync(bodyFileFor('bob'), legacyAliceBody);

    store.forgetEtagForTest('bob');
    const loaded = await store.load<{ balance: number }>('bob');
    expect(loaded.toNullable()?.state).toEqual({ balance: 1_000_000 });

    // …and that is exactly what requireContextBinding refuses.
    const strictOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY })
      .withRequireContextBinding();
    const strict = new ObjectStorageDurableStateStore(strictOptions);
    const error = await caught(() => strict.load('bob'));
    expect(error).toBeInstanceOf(JournalError);
    expect(error!.message).toContain('integrity / decode failure');
  });

  test('the prefix is part of the key, so a body cannot cross deployments', async () => {
    const stagingOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withPrefix('staging/')
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const staging = new ObjectStorageDurableStateStore(stagingOptions);
    const productionOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withPrefix('production/')
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const production = new ObjectStorageDurableStateStore(productionOptions);

    await staging.upsert('acct', 0, { balance: 999 });
    await production.upsert('acct', 0, { balance: 1 });
    writeFileSync(bodyFileFor('acct', 'production'), readFileSync(bodyFileFor('acct', 'staging')));

    production.forgetEtagForTest('acct');
    const error = await caught(() => production.load('acct'));
    expect(error).toBeInstanceOf(JournalError);
  });
});

describe('#612 — cross-key replay under client-side encryption', () => {
  test('a snapshot replayed onto another sequence number of the same pid is refused', async () => {
    // The HKDF salt is the persistenceId, so both snapshots below are
    // sealed under the SAME subkey — per-pid derivation cannot separate
    // two objects belonging to one pid.  Only the key binding can.
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withEncryption({ mode: 'client-aes256-gcm', masterKey: MASTER_KEY, info });
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('p', 5, { balance: 100 });
    await store.save('p', 9, { balance: 200 });

    writeFileSync(snapshotFileFor('p', 9), readFileSync(snapshotFileFor('p', 5)));

    const error = await caught(() => store.loadLatest('p'));
    expect(error).toBeInstanceOf(JournalError);
    expect(error!.message).toContain('integrity / decode failure');
  });

  test('a snapshot replayed onto another pid is refused', async () => {
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('rich', 5, { balance: 1_000_000 });
    await store.save('poor', 5, { balance: 1 });

    writeFileSync(snapshotFileFor('poor', 5), readFileSync(snapshotFileFor('rich', 5)));

    const error = await caught(() => store.loadLatest('poor'));
    expect(error).toBeInstanceOf(JournalError);
  });
});

/* ========================= the rollback floor ============================ */

describe('#612 — an authentic older body replayed over a newer one', () => {
  /**
   * The exploit's own configuration: client-side AES-GCM *and* an HMAC.
   *
   * Returns the **builder**, not the `XOptions` union: the union carries no
   * methods, so a caller chaining a further `.withX()` onto the result does not
   * type-check even though it runs.
   */
  function fullyProtected(): ObjectStorageDurableStateStoreOptionsBuilder {
    return ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withEncryption({ mode: 'client-aes256-gcm', masterKey: MASTER_KEY, info })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
  }

  test('the rollback floor refuses it, and an actor restart does not clear the floor', async () => {
    const store = new ObjectStorageDurableStateStore(fullyProtected());
    await store.upsert('a', 0, { balance: 100 });
    const revisionOne = readFileSync(bodyFileFor('a'));
    await store.upsert('a', 1, { balance: 90 });
    await store.upsert('a', 2, { balance: 80 });

    // Byte-identical authentic body, same key, same revision field it
    // was written with.  Every authenticator in the frame agrees.
    writeFileSync(bodyFileFor('a'), revisionOne);

    // `forgetEtagForTest` is the actor restart from the exploit
    // walkthrough — no process restart and no CAS failure needed.
    store.forgetEtagForTest('a');
    const error = await caught(() => store.load('a'));
    expect(error).toBeInstanceOf(JournalError);
    expect(error!.message).toContain('revision rollback');
  });

  test('with the floor switched off the replay is adopted — the floor is what catches it', async () => {
    const storeOptions = fullyProtected().withRejectRevisionRollback(false);
    const store = new ObjectStorageDurableStateStore(storeOptions);
    await store.upsert('a', 0, { balance: 100 });
    const revisionOne = readFileSync(bodyFileFor('a'));
    await store.upsert('a', 1, { balance: 90 });
    writeFileSync(bodyFileFor('a'), revisionOne);

    store.forgetEtagForTest('a');
    const loaded = await store.load<{ balance: number }>('a');
    expect(loaded.toNullable()?.revision).toBe(1);
    expect(loaded.toNullable()?.state).toEqual({ balance: 100 });
  });

  test('an equal revision is not a rollback — reloading the same body stays legal', async () => {
    const store = new ObjectStorageDurableStateStore(fullyProtected());
    await store.upsert('a', 0, { balance: 100 });
    store.forgetEtagForTest('a');
    expect((await store.load<{ balance: number }>('a')).toNullable()?.revision).toBe(1);
    store.forgetEtagForTest('a');
    expect((await store.load<{ balance: number }>('a')).toNullable()?.revision).toBe(1);
  });

  test('deleting the record drops its floor so a recreated record starts over', async () => {
    const store = new ObjectStorageDurableStateStore(fullyProtected());
    await store.upsert('a', 0, { balance: 100 });
    await store.upsert('a', 1, { balance: 90 });
    await store.delete('a');
    await store.upsert('a', 0, { balance: 5 });
    const loaded = await store.load<{ balance: number }>('a');
    expect(loaded.toNullable()?.revision).toBe(1);
  });

  test('a CAS rejection does not drop the floor (#117 drops the etag, not the floor)', async () => {
    // Two stores over one backend: `second` advances the bucket, `store`
    // sends a stale etag and is rejected, which deletes its etag cache
    // entry (#117).  The floor lives in a separate map precisely so that
    // deletion does not take it along — otherwise provoking a CAS
    // conflict would be enough to clear it.
    const store = new ObjectStorageDurableStateStore(fullyProtected());
    const second = new ObjectStorageDurableStateStore(fullyProtected());

    await store.upsert('a', 0, { v: 1 });
    const revisionOne = readFileSync(bodyFileFor('a'));
    await second.upsert('a', 1, { v: 2 });
    await expect(store.upsert('a', 1, { v: 3 })).rejects.toThrow();

    // #117's recovery still works: the dropped etag sends the retry
    // through the refresh path, which is also where `store` first
    // observes revision 2 and lifts its floor.
    const healed = await store.upsert('a', 2, { v: 4 });
    expect(healed.revision).toBe(3);

    writeFileSync(bodyFileFor('a'), revisionOne);
    const error = await caught(() => store.load('a'));
    expect(error).toBeInstanceOf(JournalError);
    expect(error!.message).toContain('revision rollback');
  });
});

/* ====================== the manifest flag and its guard =================== */

describe('#612 — FLAG_CONTEXT_BOUND', () => {
  test('set on an authenticated body, and absent when nothing authenticates it', async () => {
    const boundOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const bound = new ObjectStorageDurableStateStore(boundOptions);
    await bound.upsert('tagged', 0, { x: 1 });
    expect(new Uint8Array(readFileSync(bodyFileFor('tagged')))[4]! & FLAG_CONTEXT_BOUND)
      .toBe(FLAG_CONTEXT_BOUND);

    // No encryption and no integrity: there is nothing to bind the key
    // to, so the flag would be a claim the decoder cannot check.
    const plainOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' });
    const plain = new ObjectStorageDurableStateStore(plainOptions);
    await plain.upsert('plain', 0, { x: 1 });
    expect(new Uint8Array(readFileSync(bodyFileFor('plain')))[4]! & FLAG_CONTEXT_BOUND).toBe(0);
  });

  test('a plain body forging the flag is rejected rather than believed', async () => {
    const framed = await encodeBody(utf8('{"revision":1}'), { compression: 'none' });
    framed[4] = framed[4]! | FLAG_CONTEXT_BOUND;
    await expect(decodeBody(framed, { context: 'anything' }))
      .rejects.toThrow(/carries neither encryption nor an integrity tag/);
  });

  test('a bound body decoded without a context is refused, not silently unbound', async () => {
    const framed = await encodeBody(utf8('payload'), {
      compression: 'none',
      integrity: { integrityKey: INTEGRITY_KEY },
      context: 'some/key.json',
    });
    await expect(decodeBody(framed, { integrity: { integrityKey: INTEGRITY_KEY } }))
      .rejects.toThrow(/no context was supplied/);
  });

  test('requireContextBinding without a context is a configuration error', async () => {
    const framed = await encodeBody(utf8('payload'), { compression: 'none' });
    await expect(decodeBody(framed, { requireContextBinding: true }))
      .rejects.toThrow(/nothing to verify the binding against/);
  });

  test('a pre-#612 body still decodes — the migration is backwards compatible', async () => {
    const legacy = await encodeBody(utf8('legacy payload'), {
      compression: 'none',
      integrity: { integrityKey: INTEGRITY_KEY },
    });
    const decoded = await decodeBody(legacy, {
      integrity: { integrityKey: INTEGRITY_KEY },
      context: 'the/reader/passes/one/anyway.json',
    });
    expect(decoded.contextBound).toBe(false);
    expect(fromUtf8(decoded.payload)).toBe('legacy payload');
  });

  test('an empty context is no context — it never reaches the wire', async () => {
    // A zero-length AES-GCM AAD is not portably the same tag as an
    // omitted one, so a body written with `context: ''` on one runtime
    // could fail to decrypt on another.  No storage key is ever empty,
    // so the case is ruled out rather than encoded.
    const framed = await encodeBody(utf8('x'), {
      compression: 'none',
      integrity: { integrityKey: INTEGRITY_KEY },
      context: '',
    });
    expect(framed[4]! & FLAG_CONTEXT_BOUND).toBe(0);
    await expect(decodeBody(framed, { integrity: { integrityKey: INTEGRITY_KEY }, requireContextBinding: true, context: '' }))
      .rejects.toThrow(/nothing to verify the binding against/);
  });

  test('a context is only bound where an authenticator carries it', async () => {
    const framed = await encodeBody(utf8('x'), { compression: 'none', context: 'k' });
    expect(framed[4]! & FLAG_CONTEXT_BOUND).toBe(0);
    const decoded = await decodeBody(framed, { context: 'a completely different key' });
    expect(decoded.contextBound).toBe(false);
    expect(fromUtf8(decoded.payload)).toBe('x');
  });
});

/* =========================== corpus migration ============================ */

describe('#612 — reEncryptObjectStorage migrates a corpus to bound bodies', () => {
  test('a sweep rebinds bodies at the active key version and is idempotent afterwards', async () => {
    const keyring = { active: { version: 0, key: MASTER_KEY } };
    const encryption = { mode: 'client-aes256-gcm', masterKeys: keyring, info } as const;

    // Write the pre-#612 shape by hand: same key version, no binding.  The
    // key carries the snapshot namespace (#716), and the sweep runs at the
    // shared prefix, so this also exercises the extractor reading past it.
    const storageKey = `${OBJECT_STORAGE_SNAPSHOT_NAMESPACE}p/00000000000000000001.json`;
    const { deriveSubkey } = await import('../../../../../src/persistence/object-storage/Encryption.js');
    const subKey = await deriveSubkey(MASTER_KEY, 'p', info);
    const unbound = await encodeBody(
      utf8(JSON.stringify({ persistenceId: 'p', sequenceNr: 1, state: { v: 1 }, timestamp: 1 })),
      { compression: 'none', encryption: { subKey, keyVersion: 0 } },
    );
    expect(unbound[4]! & FLAG_CONTEXT_BOUND).toBe(0);
    await backend.put(storageKey, unbound, { contentType: 'application/json' });

    // The version fast-path must NOT skip it: the body is already at the
    // active version, and the sweep is the only corpus-wide rewrite tool.
    const first = await reEncryptObjectStorage(backend, { keyPrefix: '', keyring, info });
    expect(first.rewrote).toBe(1);
    expect(first.skippedCurrent).toBe(0);

    const rewritten = (await backend.get(storageKey)).toNullable()!.body;
    expect(rewritten[4]! & FLAG_CONTEXT_BOUND).toBe(FLAG_CONTEXT_BOUND);

    // Converged on both axes now, so a second run is a pure skip pass.
    const second = await reEncryptObjectStorage(backend, { keyPrefix: '', keyring, info });
    expect(second.rewrote).toBe(0);
    expect(second.skippedCurrent).toBe(1);

    // And the store reads it back under the strict setting.
    const strictOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption(encryption)
      .withRequireContextBinding();
    const strict = new ObjectStorageSnapshotStore(strictOptions);
    const loaded = await strict.loadLatest<{ v: number }>('p');
    expect(loaded.toNullable()?.state).toEqual({ v: 1 });
  });

  test('a sweep rebinds an integrity-tagged body and re-seals its tag (#739)', async () => {
    // The configuration this migration path could not reach until #739: both
    // authenticators on, and a body written before either of them bound the
    // storage key.  The sweep used to abort on it for want of an integrity
    // key, so a bucket that had turned #116 on could never be rebound and
    // `requireContextBinding` could never be switched on either.
    const keyring = { active: { version: 0, key: MASTER_KEY } };
    const encryption = { mode: 'client-aes256-gcm', masterKeys: keyring, info } as const;
    const integrity = { mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY } as const;

    const storageKey = `${OBJECT_STORAGE_SNAPSHOT_NAMESPACE}q/00000000000000000001.json`;
    const { deriveSubkey } = await import('../../../../../src/persistence/object-storage/Encryption.js');
    const subKey = await deriveSubkey(MASTER_KEY, 'q', info);
    const unbound = await encodeBody(
      utf8(JSON.stringify({ persistenceId: 'q', sequenceNr: 1, state: { v: 2 }, timestamp: 1 })),
      {
        compression: 'none',
        encryption: { subKey, keyVersion: 0 },
        integrity: { integrityKey: INTEGRITY_KEY },
      },
    );
    expect(unbound[4]! & FLAG_CONTEXT_BOUND).toBe(0);
    expect(unbound[4]! & FLAG_INTEGRITY_HMAC).toBe(FLAG_INTEGRITY_HMAC);
    await backend.put(storageKey, unbound, { contentType: 'application/json' });

    const result = await reEncryptObjectStorage(backend, {
      keyPrefix: '', keyring, info, integrity,
    });
    expect(result.rewrote).toBe(1);

    const rewritten = (await backend.get(storageKey)).toNullable()!.body;
    expect(rewritten[4]! & FLAG_CONTEXT_BOUND).toBe(FLAG_CONTEXT_BOUND);
    expect(rewritten[4]! & FLAG_INTEGRITY_HMAC).toBe(FLAG_INTEGRITY_HMAC);

    // The tag was recomputed over the new bytes *and* the binding rather
    // than carried across: it verifies at this key and at no other.
    const reread = await decodeBody(rewritten, {
      encryption: { subKey },
      integrity: { integrityKey: INTEGRITY_KEY },
      context: storageKey,
    });
    expect(reread.contextBound).toBe(true);
    await expect(decodeBody(rewritten, {
      encryption: { subKey },
      integrity: { integrityKey: INTEGRITY_KEY },
      context: `${OBJECT_STORAGE_SNAPSHOT_NAMESPACE}q/00000000000000000002.json`,
    })).rejects.toThrow(/integrity check failed/);

    // And the store reads it back with both strict settings on.
    const strictOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption(encryption)
      .withIntegrity(integrity)
      .withRequireContextBinding();
    const strict = new ObjectStorageSnapshotStore(strictOptions);
    expect((await strict.loadLatest<{ v: number }>('q')).toNullable()?.state).toEqual({ v: 2 });
  });
});
