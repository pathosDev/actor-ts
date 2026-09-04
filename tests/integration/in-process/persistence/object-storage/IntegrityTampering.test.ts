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
import {
  OBJECT_STORAGE_DURABLE_STATE_NAMESPACE,
  OBJECT_STORAGE_SNAPSHOT_NAMESPACE,
  SEQ_PADDING,
} from '../../../../../src/persistence/Constants.js';
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
 * with `persistenceId='a'` the body lives at `dir/state/a/state.json` — the
 * `state/` segment is the namespace that store owns (#716).  Lock files
 * (`<key>.lock`), etag files (`<key>.etag`), and stale tmpfiles
 * (`<key>.tmp.*`) sit alongside.
 */
function bodyFileFor(persistenceId: string): string {
  return join(dir, OBJECT_STORAGE_DURABLE_STATE_NAMESPACE, persistenceId, 'state.json');
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
  return join(
    dir,
    OBJECT_STORAGE_SNAPSHOT_NAMESPACE,
    persistenceId,
    `${String(seq).padStart(SEQ_PADDING, '0')}.json`,
  );
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

/**
 * #1354 — the migration window is not a key-roll mechanism.
 *
 * #739's docs briefly said a new integrity key rolls out "the same way
 * you turned integrity on: open the window, rewrite, close it".  It
 * does not: `allowUntaggedBodies` re-admits bodies carrying NO tag, and
 * a body tagged under the old key carries `FLAG_INTEGRITY_HMAC` and
 * dies at the HMAC comparison long before the untagged branch is
 * reached.  The claim was withdrawn; this is what stops it coming back
 * as a widened `allowUntaggedBodies`.
 *
 * The matrix below overlaps deliberately with "#579 — the window still
 * verifies a body that DOES carry a tag", which asserts the same
 * refusal from the anti-downgrade side.  The intent here is the other
 * one — that widening the window is never the fix for a failed roll —
 * so neither is redundant.
 */
describe('#1354 — rolling the integrity key', () => {
  /** Writes `a` tagged under OTHER_KEY, standing in for the old key. */
  async function writeUnderOldKey(): Promise<void> {
    const writerOptions = ObjectStorageDurableStateStoreOptions.create()
      .withBackend(backend)
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: OTHER_KEY });
    await new ObjectStorageDurableStateStore(writerOptions).upsert('a', 0, { balance: 100 });
  }

  const base = () => ObjectStorageDurableStateStoreOptions.create()
    .withBackend(backend)
    .withCompression({ algorithm: 'none' });

  test('no reader configuration reads an old-key body except the old key itself', async () => {
    await writeUnderOldKey();

    const refusing = [
      ['new key, allowUntaggedBodies: true',
        base().withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY }).withAllowUntaggedBodies(true)],
      ['new key, allowUntaggedBodies: false',
        base().withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY })],
      // No key at all is refused too — the tag is on the body, so
      // dropping the config is not a way to step around the roll.
      ['no integrity at all', base()],
    ] as const;

    for (const [label, options] of refusing) {
      let err: Error | null = null;
      try { await new ObjectStorageDurableStateStore(options).load('a'); } catch (e) { err = e as Error; }
      expect(err, label).toBeInstanceOf(JournalError);
    }

    // …and the old key still reads, so the corpus is intact and the
    // refusals above are about the key, not about a damaged body.
    const oldReaderOptions = base().withIntegrity({ mode: 'hmac-sha256', integrityKey: OTHER_KEY });
    const loaded = await new ObjectStorageDurableStateStore(oldReaderOptions).load<{ balance: number }>('a');
    expect(loaded.toNullable()?.state).toEqual({ balance: 100 });
  });

  test('the per-call override rolls one persistenceId: read old, write new', async () => {
    await writeUnderOldKey();

    // The documented procedure — a store with no integrity config of its
    // own, given the old key on the read and the new one on the write.
    const roller = new ObjectStorageDurableStateStore(base());
    const loaded = await roller.load<{ balance: number }>('a', {
      integrity: { mode: 'hmac-sha256', integrityKey: OTHER_KEY },
    });
    expect(loaded.isSome()).toBe(true);
    if (loaded.isSome()) {
      await roller.upsert('a', loaded.value.revision, loaded.value.state, {
        integrity: { mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY },
      });
    }

    // Still tagged — a roll must not quietly drop the tag.
    const raw = new Uint8Array(readFileSync(bodyFileFor('a')));
    expect(raw[4]! & FLAG_INTEGRITY_HMAC).toBe(FLAG_INTEGRITY_HMAC);

    // Readable under the new key, and no longer under the old one.
    const afterOptions = base().withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const after = await new ObjectStorageDurableStateStore(afterOptions).load<{ balance: number }>('a');
    expect(after.toNullable()?.state).toEqual({ balance: 100 });

    const staleOptions = base().withIntegrity({ mode: 'hmac-sha256', integrityKey: OTHER_KEY });
    let err: Error | null = null;
    try { await new ObjectStorageDurableStateStore(staleOptions).load('a'); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(JournalError);
  });

  test('the roll bumps the revision — it is a write, not a re-seal in place', async () => {
    // Worth pinning because it is the cost an operator has to plan for:
    // a key roll is visible in the entity's revision and goes through
    // the CAS, so it races the live application.
    await writeUnderOldKey();
    const store = new ObjectStorageDurableStateStore(base());

    const before = await store.load<{ balance: number }>('a', {
      integrity: { mode: 'hmac-sha256', integrityKey: OTHER_KEY },
    });
    expect(before.toNullable()?.revision).toBe(1);
    if (before.isSome()) {
      const rolled = await store.upsert('a', before.value.revision, before.value.state, {
        integrity: { mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY },
      });
      expect(rolled.revision).toBe(2);
    }
  });
});
