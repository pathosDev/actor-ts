import { describe, expect, test } from 'bun:test';
import { encodeBody } from '../../../../src/persistence/object-storage/BodyCodec.js';
import { activeEncryptKey } from '../../../../src/persistence/object-storage/Encryption.js';
import type { EncryptionConfig, IntegrityConfig, PersistenceOptions } from '../../../../src/persistence/PersistenceOptions.js';
import {
  durableStatePayloadContext,
  openPayload,
  requestsSealing,
  sealPayload,
  SEALED_PAYLOAD_PREFIX,
  SealedPayloadError,
  snapshotPayloadContext,
} from '../../../../src/persistence/storage/SealedPayload.js';

/**
 * The text-column carrier of the per-actor persistence hooks (#1802).  Every
 * refusal here is one an attacker with write access to the table could
 * otherwise use: a plaintext row under an encrypting actor (#965), a frame
 * moved to another row (#612), a frame whose tag was dropped (#579).
 */

const KEY_A = new Uint8Array(32).fill(7);
const KEY_B = new Uint8Array(32).fill(9);
const INTEGRITY_KEY = new Uint8Array(32).fill(3);

const ENCRYPTION_A: EncryptionConfig = { mode: 'client-aes256-gcm', masterKey: KEY_A, info: 'sealed-payload-test' };
const ENCRYPTION_B: EncryptionConfig = { mode: 'client-aes256-gcm', masterKey: KEY_B, info: 'sealed-payload-test' };
const INTEGRITY: IntegrityConfig = { mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY };

const JSON_TEXT = JSON.stringify({ secret: 'the plaintext a reader of the table must not see', n: 42 });
const PID = 'account-1';
const CONTEXT = snapshotPayloadContext(PID, 5);

describe('sealPayload — what reaches the column', () => {
  test('no hook, or hooks that ask for nothing, leaves the JSON exactly as it was', async () => {
    expect(await sealPayload(JSON_TEXT, PID, CONTEXT, undefined)).toBe(JSON_TEXT);
    const nothing: PersistenceOptions = {
      encryption: { mode: 'none' }, integrity: { mode: 'none' }, compression: { algorithm: 'none' },
    };
    expect(requestsSealing(nothing)).toBe(false);
    expect(await sealPayload(JSON_TEXT, PID, CONTEXT, nothing)).toBe(JSON_TEXT);
  });

  test('encryption writes a prefixed frame that does not contain the plaintext', async () => {
    const sealed = await sealPayload(JSON_TEXT, PID, CONTEXT, { encryption: ENCRYPTION_A });
    expect(sealed.startsWith(SEALED_PAYLOAD_PREFIX)).toBe(true);
    expect(sealed).not.toContain('plaintext');
    expect(Buffer.from(sealed.slice(SEALED_PAYLOAD_PREFIX.length), 'base64').toString('latin1'))
      .not.toContain('plaintext');
  });

  test('two writes of the same state differ — a fresh IV per row', async () => {
    const first = await sealPayload(JSON_TEXT, PID, CONTEXT, { encryption: ENCRYPTION_A });
    const second = await sealPayload(JSON_TEXT, PID, CONTEXT, { encryption: ENCRYPTION_A });
    expect(first).not.toBe(second);
  });

  test('the prefix cannot begin a JSON text, so a legacy row is never read as a frame', () => {
    for (const json of ['{}', '[]', '"ats1:x"', '1', '-1', 'null', 'true', 'false']) {
      expect(json.startsWith(SEALED_PAYLOAD_PREFIX)).toBe(false);
      expect(() => JSON.parse(json)).not.toThrow();
    }
    expect(() => JSON.parse(SEALED_PAYLOAD_PREFIX)).toThrow();
  });

  test('sse-s3 and sse-kms are refused instead of written in the clear', async () => {
    for (const encryption of [{ mode: 'sse-s3' }, { mode: 'sse-kms', kmsKeyId: 'k' }] as const) {
      await expect(sealPayload(JSON_TEXT, PID, CONTEXT, { encryption })).rejects.toThrow(/server-side mode/);
      await expect(openPayload(JSON_TEXT, PID, CONTEXT, { encryption })).rejects.toThrow(/server-side mode/);
    }
  });
});

describe('openPayload — round trips', () => {
  const cases: ReadonlyArray<readonly [string, PersistenceOptions]> = [
    ['encryption', { encryption: ENCRYPTION_A }],
    ['integrity', { integrity: INTEGRITY }],
    ['compression', { compression: { algorithm: 'gzip' } }],
    ['all three', { encryption: ENCRYPTION_A, integrity: INTEGRITY, compression: { algorithm: 'gzip' } }],
  ];
  for (const [label, options] of cases) {
    test(`${label}: the JSON comes back byte for byte`, async () => {
      const sealed = await sealPayload(JSON_TEXT, PID, CONTEXT, options);
      expect(sealed.startsWith(SEALED_PAYLOAD_PREFIX)).toBe(true);
      expect(await openPayload(sealed, PID, CONTEXT, options)).toBe(JSON_TEXT);
    });
  }

  test('a compressed-only frame opens without any options — compression needs no key', async () => {
    const sealed = await sealPayload(JSON_TEXT, PID, CONTEXT, { compression: { algorithm: 'gzip' } });
    expect(await openPayload(sealed, PID, CONTEXT, undefined)).toBe(JSON_TEXT);
  });

  test('a keyring decrypts a frame written under a retired version', async () => {
    const before: EncryptionConfig = {
      mode: 'client-aes256-gcm', info: 'ring', masterKeys: { active: { version: 1, key: KEY_A } },
    };
    const after: EncryptionConfig = {
      mode: 'client-aes256-gcm',
      info: 'ring',
      masterKeys: { active: { version: 2, key: KEY_B }, retired: [{ version: 1, key: KEY_A }] },
    };
    const sealed = await sealPayload(JSON_TEXT, PID, CONTEXT, { encryption: before });
    expect(await openPayload(sealed, PID, CONTEXT, { encryption: after })).toBe(JSON_TEXT);
  });
});

describe('openPayload — refusals', () => {
  test('the wrong key is refused', async () => {
    const sealed = await sealPayload(JSON_TEXT, PID, CONTEXT, { encryption: ENCRYPTION_A });
    await expect(openPayload(sealed, PID, CONTEXT, { encryption: ENCRYPTION_B })).rejects.toBeInstanceOf(SealedPayloadError);
  });

  test('an encrypted frame read with no key is refused, not handed back as ciphertext', async () => {
    const sealed = await sealPayload(JSON_TEXT, PID, CONTEXT, { encryption: ENCRYPTION_A });
    await expect(openPayload(sealed, PID, CONTEXT, undefined)).rejects.toThrow(/encrypted/);
  });

  test('a frame moved to another sequence number or revision is refused (#612)', async () => {
    for (const options of [{ encryption: ENCRYPTION_A }, { integrity: INTEGRITY }] satisfies PersistenceOptions[]) {
      const sealed = await sealPayload(JSON_TEXT, PID, snapshotPayloadContext(PID, 5), options);
      await expect(openPayload(sealed, PID, snapshotPayloadContext(PID, 6), options)).rejects.toBeInstanceOf(SealedPayloadError);
      const state = await sealPayload(JSON_TEXT, PID, durableStatePayloadContext(PID, 3), options);
      await expect(openPayload(state, PID, durableStatePayloadContext(PID, 2), options)).rejects.toBeInstanceOf(SealedPayloadError);
    }
  });

  test('an integrity-only frame moved to another persistence id is refused — its key is flat', async () => {
    const sealed = await sealPayload(JSON_TEXT, PID, snapshotPayloadContext(PID, 5), { integrity: INTEGRITY });
    await expect(openPayload(sealed, 'account-2', snapshotPayloadContext('account-2', 5), { integrity: INTEGRITY }))
      .rejects.toThrow(/integrity/);
  });

  test('a plaintext row is refused under encryption() and under integrity() (#965)', async () => {
    await expect(openPayload(JSON_TEXT, PID, CONTEXT, { encryption: ENCRYPTION_A })).rejects.toThrow(/plaintext JSON.*encryption\(\)/);
    await expect(openPayload(JSON_TEXT, PID, CONTEXT, { integrity: INTEGRITY })).rejects.toThrow(/plaintext JSON.*integrity\(\)/);
  });

  test('a frame without encryption is refused when the actor asks for encryption', async () => {
    // Signed but not encrypted — authentic bytes, just not the control asked for.
    const unencrypted = await sealPayload(JSON_TEXT, PID, CONTEXT, { compression: { algorithm: 'gzip' } });
    await expect(openPayload(unencrypted, PID, CONTEXT, { encryption: ENCRYPTION_A })).rejects.toThrow(/without encryption/);
  });

  test('a frame without a tag is refused when the actor asks for integrity (#579)', async () => {
    const untagged = await sealPayload(JSON_TEXT, PID, CONTEXT, { encryption: ENCRYPTION_A });
    await expect(openPayload(untagged, PID, CONTEXT, { encryption: ENCRYPTION_A, integrity: INTEGRITY }))
      .rejects.toThrow(/without an integrity tag/);
  });

  /**
   * Authentic bytes, written by someone holding the key, but with no binding:
   * what a pre-#612 object-storage body copied into the table looks like.
   * Its GCM tag verifies, so only the demanded binding refuses it — at any
   * row it is pasted into.
   */
  test('an authentic but unbound frame is refused — the binding is demanded, not just checked', async () => {
    const active = await activeEncryptKey(ENCRYPTION_A, PID);
    const unbound = await encodeBody(new TextEncoder().encode(JSON_TEXT), { encryption: { subKey: active!.subKey } });
    const pasted = SEALED_PAYLOAD_PREFIX + Buffer.from(unbound).toString('base64');
    await expect(openPayload(pasted, PID, CONTEXT, { encryption: ENCRYPTION_A })).rejects.toThrow(/not context-bound/);
    // The migration window admits it, like any row that predates the hooks.
    expect(await openPayload(pasted, PID, CONTEXT, { encryption: ENCRYPTION_A }, { allowPlaintextRows: true }))
      .toBe(JSON_TEXT);
  });

  test('a corrupted frame is refused', async () => {
    const sealed = await sealPayload(JSON_TEXT, PID, CONTEXT, { encryption: ENCRYPTION_A });
    const body = Buffer.from(sealed.slice(SEALED_PAYLOAD_PREFIX.length), 'base64');
    body[body.length - 1] = body[body.length - 1]! ^ 0xff;
    const tampered = SEALED_PAYLOAD_PREFIX + body.toString('base64');
    await expect(openPayload(tampered, PID, CONTEXT, { encryption: ENCRYPTION_A })).rejects.toBeInstanceOf(SealedPayloadError);
  });
});

describe('openPayload — the migration window', () => {
  test('allowPlaintextRows re-admits a plaintext row and an unencrypted frame', async () => {
    const policy = { allowPlaintextRows: true };
    expect(await openPayload(JSON_TEXT, PID, CONTEXT, { encryption: ENCRYPTION_A }, policy)).toBe(JSON_TEXT);
    expect(await openPayload(JSON_TEXT, PID, CONTEXT, { integrity: INTEGRITY }, policy)).toBe(JSON_TEXT);
    const unencrypted = await sealPayload(JSON_TEXT, PID, CONTEXT, { compression: { algorithm: 'gzip' } });
    expect(await openPayload(unencrypted, PID, CONTEXT, { encryption: ENCRYPTION_A }, policy)).toBe(JSON_TEXT);
  });

  test('the window does not admit a wrong key or a moved frame', async () => {
    const policy = { allowPlaintextRows: true };
    const sealed = await sealPayload(JSON_TEXT, PID, CONTEXT, { encryption: ENCRYPTION_A });
    await expect(openPayload(sealed, PID, CONTEXT, { encryption: ENCRYPTION_B }, policy)).rejects.toBeInstanceOf(SealedPayloadError);
    await expect(openPayload(sealed, PID, snapshotPayloadContext(PID, 6), { encryption: ENCRYPTION_A }, policy))
      .rejects.toBeInstanceOf(SealedPayloadError);
  });

  test('a plaintext row needs no window when the actor asks for no control', async () => {
    expect(await openPayload(JSON_TEXT, PID, CONTEXT, undefined)).toBe(JSON_TEXT);
    expect(await openPayload(JSON_TEXT, PID, CONTEXT, { compression: { algorithm: 'gzip' } })).toBe(JSON_TEXT);
  });
});
