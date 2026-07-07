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
 * a clear error; legacy bodies (no `FLAG_INTEGRITY_HMAC`) still decode
 * for back-compat, unless `requireIntegrity: true` is set.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { ObjectStorageDurableStateStore } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStore.js';
import { ObjectStorageDurableStateStoreOptions } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStoreOptions.js';
import { JournalError } from '../../../../../src/persistence/JournalTypes.js';
import {
  ATS1_MAGIC,
  FLAG_INTEGRITY_HMAC,
  encodeBody,
  decodeBody,
} from '../../../../../src/persistence/object-storage/BodyCodec.js';

let dir: string;
let backend: FilesystemObjectStorageBackend;

const INTEGRITY_KEY = new Uint8Array(32).fill(7);
const OTHER_KEY     = new Uint8Array(32).fill(8);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'actor-ts-integrity-'));
  backend = new FilesystemObjectStorageBackend(FilesystemObjectStorageOptions.create().withDir(dir));
});
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

/**
 * The FS backend stores each key at `dir/<key>` 1:1, so for DurableState
 * with `pid='a'` the body lives at `dir/a/state.json`.  Lock files
 * (`<key>.lock`), etag files (`<key>.etag`), and stale tmpfiles
 * (`<key>.tmp.*`) sit alongside.
 */
function bodyFileFor(pid: string): string {
  return join(dir, pid, 'state.json');
}

describe('#116 — DurableState revision-tampering exploit (pre-fix demonstration)', () => {
  test('without integrity config a tampered revision is read as-is', async () => {
    const store = new ObjectStorageDurableStateStore(ObjectStorageDurableStateStoreOptions.create().withBackend(backend).withCompression({ algorithm: 'none' }));
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
    const store = new ObjectStorageDurableStateStore(
      ObjectStorageDurableStateStoreOptions.create()
        .withBackend(backend)
        .withCompression({ algorithm: 'none' })
        .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY }),
    );
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
    const writer = new ObjectStorageDurableStateStore(
      ObjectStorageDurableStateStoreOptions.create()
        .withBackend(backend)
        .withCompression({ algorithm: 'none' })
        .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY }),
    );
    await writer.upsert('a', 0, { balance: 100 });
    const path = bodyFileFor('a');

    // Forge: encode a body claiming `revision: 999` but signed under OTHER_KEY.
    const forged = await encodeBody(
      new TextEncoder().encode(JSON.stringify({ revision: 999, state: { balance: 100 }, timestamp: Date.now() })),
      { integrity: { integrityKey: OTHER_KEY } },
    );
    writeFileSync(path, forged);

    const reader = new ObjectStorageDurableStateStore(
      ObjectStorageDurableStateStoreOptions.create()
        .withBackend(backend)
        .withCompression({ algorithm: 'none' })
        .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY }),
    );
    let err: Error | null = null;
    try { await reader.load('a'); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(JournalError);
  });

  test('legitimate write+read cycle works under integrity', async () => {
    const store = new ObjectStorageDurableStateStore(
      ObjectStorageDurableStateStoreOptions.create()
        .withBackend(backend)
        .withCompression({ algorithm: 'none' })
        .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY }),
    );
    await store.upsert('a', 0, { balance: 100 });
    await store.upsert('a', 1, { balance: 150 });
    const loaded = await store.load<{ balance: number }>('a');
    expect(loaded.toNullable()?.revision).toBe(2);
    expect(loaded.toNullable()?.state).toEqual({ balance: 150 });
  });

  test('body carries the FLAG_INTEGRITY_HMAC bit when integrity is configured', async () => {
    const store = new ObjectStorageDurableStateStore(
      ObjectStorageDurableStateStoreOptions.create()
        .withBackend(backend)
        .withCompression({ algorithm: 'none' })
        .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY }),
    );
    await store.upsert('a', 0, { balance: 100 });
    const raw = new Uint8Array(readFileSync(bodyFileFor('a')));
    // ATS1 magic at 0..3, flags at byte 4.
    expect(raw[0]).toBe(ATS1_MAGIC[0]);
    expect(raw[4]! & FLAG_INTEGRITY_HMAC).toBe(FLAG_INTEGRITY_HMAC);
  });
});

describe('#116 — backward compatibility', () => {
  test('legacy body (no integrity flag) decodes when integrity is configured', async () => {
    // Write without integrity (simulates pre-#116 body on disk).
    const writer = new ObjectStorageDurableStateStore(ObjectStorageDurableStateStoreOptions.create().withBackend(backend).withCompression({ algorithm: 'none' }));
    await writer.upsert('a', 0, { balance: 100 });

    // Read with integrity configured — legacy body has FLAG_INTEGRITY_HMAC
    // unset, so the integrity check is skipped.  Reads cleanly.
    const reader = new ObjectStorageDurableStateStore(
      ObjectStorageDurableStateStoreOptions.create()
        .withBackend(backend)
        .withCompression({ algorithm: 'none' })
        .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY }),
    );
    const loaded = await reader.load<{ balance: number }>('a');
    expect(loaded.toNullable()?.state).toEqual({ balance: 100 });
  });

  test('requireIntegrity=true rejects a legacy body (downgrade protection)', async () => {
    const writer = new ObjectStorageDurableStateStore(ObjectStorageDurableStateStoreOptions.create().withBackend(backend).withCompression({ algorithm: 'none' }));
    await writer.upsert('a', 0, { balance: 100 });

    const reader = new ObjectStorageDurableStateStore(
      ObjectStorageDurableStateStoreOptions.create()
        .withBackend(backend)
        .withCompression({ algorithm: 'none' })
        .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY })
        .withRequireIntegrity(true),
    );
    let err: Error | null = null;
    try { await reader.load('a'); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(JournalError);
    expect(err!.message).toContain('integrity / decode failure');
  });

  test('requireIntegrity=true without an integrity config is rejected up-front', async () => {
    const store = new ObjectStorageDurableStateStore(
      ObjectStorageDurableStateStoreOptions.create()
        .withBackend(backend)
        .withCompression({ algorithm: 'none' })
        .withRequireIntegrity(true),
    );
    let err: Error | null = null;
    try { await store.upsert('a', 0, { x: 1 }); await store.load('a'); }
    catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(JournalError);
    expect(err!.message).toContain("requireIntegrity=true demands");
  });
});

describe('#116 — encrypted body is already protected by AES-GCM', () => {
  test('tampering ciphertext on an encrypted body invalidates the auth tag', async () => {
    const masterKey = new Uint8Array(32).fill(9);
    const store = new ObjectStorageDurableStateStore(
      ObjectStorageDurableStateStoreOptions.create()
        .withBackend(backend)
        .withCompression({ algorithm: 'none' })
        .withEncryption({ mode: 'client-aes256-gcm', masterKey }),
    );
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
