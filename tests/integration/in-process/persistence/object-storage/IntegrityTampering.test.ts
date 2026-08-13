/**
 * Regression suite for #116 — DurableState revision tampering.
 *
 * Pre-fix scenario: a body written with `mode: 'none'` (no encryption)
 * carries the `revision` field as plain JSON.  An attacker with write
 * access to the object-storage backend can edit the JSON and bypass
 * the `expectedRevision` CAS check on the next `load + upsert` cycle.
 *
 * Fix: opt-in HMAC-SHA256 over the framed body (manifest + payload).
 * Reading a tampered body with the integrity config configured throws
 * a clear error.
 *
 * #579 closed the hole that left in place: an untagged body used to
 * decode cleanly under an integrity config, so an attacker could strip
 * the tag and clear `FLAG_INTEGRITY_HMAC` and face no verification at
 * all.  Configuring integrity now REQUIRES a tag; a legacy corpus opts
 * its untagged bodies back in with `allowUntaggedBodies`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { ObjectStorageDurableStateStore } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStore.js';
import { ObjectStorageDurableStateStoreOptions } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStoreOptions.js';
import { ObjectStorageSnapshotStore } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStore.js';
import { ObjectStorageSnapshotStoreOptions } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
import { SEQ_PADDING } from '../../../../../src/persistence/Constants.js';
import { JournalError } from '../../../../../src/persistence/JournalTypes.js';
import {
  ATS1_MAGIC,
  FLAG_INTEGRITY_HMAC,
  encodeBody,
  decodeBody,
} from '../../../../../src/persistence/object-storage/BodyCodec.js';

let dir: string;
let backend: FilesystemObjectStorageBackend;

/** HKDF context — required on every client-side encryption config (#108). */
const info = 'acme/test/snapshot/v1';

const INTEGRITY_KEY = new Uint8Array(32).fill(7);
const OTHER_KEY     = new Uint8Array(32).fill(8);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'actor-ts-integrity-'));
  const backendOptions = FilesystemObjectStorageOptions.create()
    .withDir(dir);
  backend = new FilesystemObjectStorageBackend(backendOptions);
});
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

/**
 * The FS backend stores each key at `dir/<key>` 1:1, so for DurableState
 * with `persistenceId='a'` the body lives at `dir/a/state.json`.  Lock files
 * (`<key>.lock`), etag files (`<key>.etag`), and stale tmpfiles
 * (`<key>.tmp.*`) sit alongside.
 */
function bodyFileFor(persistenceId: string): string {
  return join(dir, persistenceId, 'state.json');
}

describe('#116 — DurableState revision-tampering exploit (pre-fix demonstration)', () => {
  test('without integrity config a tampered revision is read as-is', async () => {
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' });
    const store = new ObjectStorageDurableStateStore(storeOptions);
    await store.upsert('a', 0, { balance: 100 });   // writes revision=1
    const path = bodyFileFor('a');
    const raw = readFileSync(path);
    // Find the JSON in the body and bump revision to 999.
    const decoded = await decodeBody(new Uint8Array(raw));
    const json = new TextDecoder().decode(decoded.payload);
    expect(json).toContain('"revision":1');
    const tampered = json.replace('"revision":1', '"revision":999');
    const reframed = await encodeBody(new TextEncoder().encode(tampered)); // no integrity → ATS1 unencrypted
    writeFileSync(path, reframed);

    // Wipe the cache so load() actually reads the file.
    store.forgetEtagForTest('a');
    const loaded = await store.load<{ balance: number }>('a');
    // Pre-fix: tampered revision is trusted.
    expect(loaded.toNullable()?.revision).toBe(999);
  });
});

describe('#116 — defense via opt-in HMAC integrity', () => {
  test('integrity-configured store rejects a tampered body', async () => {
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const store = new ObjectStorageDurableStateStore(storeOptions);
    await store.upsert('a', 0, { balance: 100 });

    // Tamper the body by replacing every byte after the magic+flags
    // header with a fresh ATS1 body containing a different payload.
    // The integrity tag from the original write doesn't cover the
    // attacker's payload, so decode must reject.
    const path = bodyFileFor('a');
    const raw = readFileSync(path);
    // Flip a byte in the middle of the payload, well after the magic.
    raw[20] ^= 0xff;
    writeFileSync(path, raw);

    store.forgetEtagForTest('a');
    let err: Error | null = null;
    try { await store.load('a'); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(JournalError);
    expect(err!.message).toContain('integrity / decode failure');
  });

  test('integrity-configured store rejects a body signed with a different key', async () => {
    // Write with INTEGRITY_KEY, then re-write with OTHER_KEY to simulate
    // an attacker who has write access but doesn't know our key.
    const writerOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const writer = new ObjectStorageDurableStateStore(writerOptions);
    await writer.upsert('a', 0, { balance: 100 });
    const path = bodyFileFor('a');

    // Forge: encode a body claiming `revision: 999` but signed under OTHER_KEY.
    const forged = await encodeBody(
      new TextEncoder().encode(JSON.stringify({ revision: 999, state: { balance: 100 }, timestamp: Date.now() })),
      { integrity: { integrityKey: OTHER_KEY } },
    );
    writeFileSync(path, forged);

    const readerOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const reader = new ObjectStorageDurableStateStore(readerOptions);
    let err: Error | null = null;
    try { await reader.load('a'); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(JournalError);
  });

  test('legitimate write+read cycle works under integrity', async () => {
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const store = new ObjectStorageDurableStateStore(storeOptions);
    await store.upsert('a', 0, { balance: 100 });
    await store.upsert('a', 1, { balance: 150 });
    const loaded = await store.load<{ balance: number }>('a');
    expect(loaded.toNullable()?.revision).toBe(2);
    expect(loaded.toNullable()?.state).toEqual({ balance: 150 });
  });

  test('body carries the FLAG_INTEGRITY_HMAC bit when integrity is configured', async () => {
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const store = new ObjectStorageDurableStateStore(storeOptions);
    await store.upsert('a', 0, { balance: 100 });
    const raw = new Uint8Array(readFileSync(bodyFileFor('a')));
    // ATS1 magic at 0..3, flags at byte 4.
    expect(raw[0]).toBe(ATS1_MAGIC[0]);
    expect(raw[4]! & FLAG_INTEGRITY_HMAC).toBe(FLAG_INTEGRITY_HMAC);
  });
});

describe('#579 — the tag cannot be stripped', () => {
  test('DEFAULT integrity config rejects a body whose tag and flag were removed', async () => {
    // This is the exploit: `withIntegrity(...)` and nothing else — the
    // configuration a developer gets from following the docs.
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const store = new ObjectStorageDurableStateStore(storeOptions);
    await store.upsert('a', 0, { balance: 100 });   // writes revision=1, tagged

    // The attacker cannot forge the tag without the key, so they don't
    // try: they re-frame the body with FLAG_INTEGRITY_HMAC clear and no
    // tag at all, carrying whatever revision they like.
    const path = bodyFileFor('a');
    const original = new Uint8Array(readFileSync(path));
    expect(original[4]! & FLAG_INTEGRITY_HMAC).toBe(FLAG_INTEGRITY_HMAC);
    const downgraded = await encodeBody(
      new TextEncoder().encode(JSON.stringify({ revision: 999, state: { balance: 1_000_000 }, timestamp: Date.now() })),
    );
    expect(downgraded[4]! & FLAG_INTEGRITY_HMAC).toBe(0);
    writeFileSync(path, downgraded);

    store.forgetEtagForTest('a');
    let err: Error | null = null;
    try { await store.load('a'); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(JournalError);
    expect(err!.message).toContain('integrity / decode failure');
  });

  test('a legacy untagged body is refused by default once integrity is configured', async () => {
    // Write without integrity (simulates a pre-#116 body on disk).
    const writerOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' });
    const writer = new ObjectStorageDurableStateStore(writerOptions);
    await writer.upsert('a', 0, { balance: 100 });

    const readerOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const reader = new ObjectStorageDurableStateStore(readerOptions);
    let err: Error | null = null;
    try { await reader.load('a'); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(JournalError);
    expect(err!.message).toContain('integrity / decode failure');
  });

  test('per-call PersistenceOptions.integrity demands a tag as well', async () => {
    // The store itself has no integrity config; the key arrives per call.
    // The demand has to travel with the key, or this path stays open.
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' });
    const store = new ObjectStorageDurableStateStore(storeOptions);
    await store.upsert('a', 0, { balance: 100 });   // untagged

    store.forgetEtagForTest('a');
    let err: Error | null = null;
    try {
      await store.load('a', { integrity: { mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY } });
    } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(JournalError);
    expect(err!.message).toContain('integrity / decode failure');
  });
});

describe('#579 — allowUntaggedBodies is the migration window', () => {
  test('an untagged body decodes again when the window is opened', async () => {
    const writerOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' });
    const writer = new ObjectStorageDurableStateStore(writerOptions);
    await writer.upsert('a', 0, { balance: 100 });

    const readerOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY })
      .withAllowUntaggedBodies(true);
    const reader = new ObjectStorageDurableStateStore(readerOptions);
    const loaded = await reader.load<{ balance: number }>('a');
    expect(loaded.toNullable()?.state).toEqual({ balance: 100 });
  });

  test('the window still verifies a body that DOES carry a tag', async () => {
    // Opening the window must not degrade into "never check anything" —
    // a tagged body signed with the wrong key stays a hard failure.
    const writerOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: OTHER_KEY });
    const writer = new ObjectStorageDurableStateStore(writerOptions);
    await writer.upsert('a', 0, { balance: 100 });

    const readerOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY })
      .withAllowUntaggedBodies(true);
    const reader = new ObjectStorageDurableStateStore(readerOptions);
    let err: Error | null = null;
    try { await reader.load('a'); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(JournalError);
  });

  test('allowUntaggedBodies without an integrity config changes nothing', async () => {
    // No key anywhere means no verification to weaken — the option is
    // inert rather than an error, because a store whose callers supply
    // the key per call legitimately sets it.
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withAllowUntaggedBodies(true);
    const store = new ObjectStorageDurableStateStore(storeOptions);
    await store.upsert('a', 0, { balance: 100 });
    const loaded = await store.load<{ balance: number }>('a');
    expect(loaded.toNullable()?.revision).toBe(1);
  });
});

describe('#116 — encrypted body is already protected by AES-GCM', () => {
  test('tampering ciphertext on an encrypted body invalidates the auth tag', async () => {
    const masterKey = new Uint8Array(32).fill(9);
    const storeOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withEncryption({ mode: 'client-aes256-gcm', masterKey, info });
    const store = new ObjectStorageDurableStateStore(storeOptions);
    await store.upsert('a', 0, { balance: 100 });

    // Flip a byte in the ciphertext.
    const path = bodyFileFor('a');
    const raw = readFileSync(path);
    raw[raw.length - 5] ^= 0xff;
    writeFileSync(path, raw);

    store.forgetEtagForTest('a');
    let err: Error | null = null;
    try { await store.load('a'); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(JournalError);
  });
});

/* ============ #613 — the snapshot store gets the same control ============ */

/**
 * A snapshot is the starting state recovery folds events on top of, so
 * an unverified snapshot is an unverified actor.  Until #613 the store
 * had no integrity plumbing at all and silently discarded
 * `PersistenceOptions.integrity`.
 *
 * FS backend key layout for snapshots: `dir/<pid>/<seq padded to
 * SEQ_PADDING>.json`.
 */
function snapshotFileFor(persistenceId: string, seq: number): string {
  return join(dir, persistenceId, `${String(seq).padStart(SEQ_PADDING, '0')}.json`);
}

describe('#613 — snapshot bodies carry an integrity tag', () => {
  test('a snapshot written under integrity carries FLAG_INTEGRITY_HMAC and round-trips', async () => {
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('p', 5, { balance: 100 });

    const raw = new Uint8Array(readFileSync(snapshotFileFor('p', 5)));
    expect(raw[0]).toBe(ATS1_MAGIC[0]);
    expect(raw[4]! & FLAG_INTEGRITY_HMAC).toBe(FLAG_INTEGRITY_HMAC);

    const loaded = await store.loadLatest<{ balance: number }>('p');
    expect(loaded.toNullable()?.state).toEqual({ balance: 100 });
  });

  test('a tampered snapshot body is refused', async () => {
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('p', 5, { balance: 100 });

    const path = snapshotFileFor('p', 5);
    const raw = readFileSync(path);
    raw[20] ^= 0xff;
    writeFileSync(path, raw);

    let err: Error | null = null;
    try { await store.loadLatest('p'); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(JournalError);
    expect(err!.message).toContain('integrity / decode failure');
  });

  test('a snapshot re-framed without a tag is refused (the #579 downgrade)', async () => {
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await store.save('p', 5, { balance: 100 });

    const downgraded = await encodeBody(
      new TextEncoder().encode(JSON.stringify({
        persistenceId: 'p', sequenceNr: 5, state: { balance: 1_000_000 }, timestamp: Date.now(),
      })),
    );
    expect(downgraded[4]! & FLAG_INTEGRITY_HMAC).toBe(0);
    writeFileSync(snapshotFileFor('p', 5), downgraded);

    let err: Error | null = null;
    try { await store.loadLatest('p'); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(JournalError);
  });

  test('loadBefore verifies too, not just loadLatest', async () => {
    const writerOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: OTHER_KEY });
    const writer = new ObjectStorageSnapshotStore(writerOptions);
    await writer.save('p', 5, { balance: 100 });
    await writer.save('p', 9, { balance: 200 });

    const readerOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const reader = new ObjectStorageSnapshotStore(readerOptions);
    let err: Error | null = null;
    try { await reader.loadBefore('p', 9); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(JournalError);
  });

  test('a legacy untagged snapshot needs allowUntaggedBodies', async () => {
    const writerOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' });
    const writer = new ObjectStorageSnapshotStore(writerOptions);
    await writer.save('p', 5, { balance: 100 });

    const strictOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const strict = new ObjectStorageSnapshotStore(strictOptions);
    let err: Error | null = null;
    try { await strict.loadLatest('p'); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(JournalError);

    const migratingOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY })
      .withAllowUntaggedBodies(true);
    const migrating = new ObjectStorageSnapshotStore(migratingOptions);
    const loaded = await migrating.loadLatest<{ balance: number }>('p');
    expect(loaded.toNullable()?.state).toEqual({ balance: 100 });
  });

  test('per-call PersistenceOptions.integrity is honoured instead of discarded', async () => {
    // The store has no integrity config: before #613 the field was
    // bound by the signature and thrown away on both paths.
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' });
    const store = new ObjectStorageSnapshotStore(storeOptions);
    const perCall = { integrity: { mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY } } as const;
    await store.save('p', 5, { balance: 100 }, perCall);

    const raw = new Uint8Array(readFileSync(snapshotFileFor('p', 5)));
    expect(raw[4]! & FLAG_INTEGRITY_HMAC).toBe(FLAG_INTEGRITY_HMAC);

    const loaded = await store.loadLatest<{ balance: number }>('p', perCall);
    expect(loaded.toNullable()?.state).toEqual({ balance: 100 });

    // …and the key actually has to match.
    let err: Error | null = null;
    try {
      await store.loadLatest('p', { integrity: { mode: 'hmac-sha256', integrityKey: OTHER_KEY } });
    } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(JournalError);
  });
});
