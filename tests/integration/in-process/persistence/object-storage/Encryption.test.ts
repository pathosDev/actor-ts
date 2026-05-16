import { describe, expect, test } from 'bun:test';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveSubkey,
  IV_LENGTH,
  KEY_LENGTH,
  randomIv,
} from '../../../../../src/persistence/object-storage/Encryption.js';

const masterKey = new Uint8Array(KEY_LENGTH).fill(1);

describe('Encryption — deriveSubkey', () => {
  test('produces a 32-byte subkey', async () => {
    const sub = await deriveSubkey(masterKey, 'pid-1');
    expect(sub.byteLength).toBe(32);
  });

  test('different persistence ids produce different subkeys', async () => {
    const a = await deriveSubkey(masterKey, 'tenant-acme/pid-1');
    const b = await deriveSubkey(masterKey, 'tenant-bigcorp/pid-1');
    expect(equalBytes(a, b)).toBe(false);
  });

  test('same persistence id + same master key + same info → same subkey', async () => {
    const a = await deriveSubkey(masterKey, 'pid-1', 'actor-ts/snapshot/v1');
    const b = await deriveSubkey(masterKey, 'pid-1', 'actor-ts/snapshot/v1');
    expect(equalBytes(a, b)).toBe(true);
  });

  test('different info strings produce different subkeys', async () => {
    const a = await deriveSubkey(masterKey, 'pid-1', 'info-A');
    const b = await deriveSubkey(masterKey, 'pid-1', 'info-B');
    expect(equalBytes(a, b)).toBe(false);
  });

  test('rejects a non-32-byte master key', async () => {
    await expect(deriveSubkey(new Uint8Array(16), 'pid')).rejects.toThrow(/32 bytes/);
  });
});

describe('Encryption — AES-256-GCM round-trip', () => {
  test('decrypt yields the original plaintext', async () => {
    const subkey = await deriveSubkey(masterKey, 'pid');
    const iv = randomIv();
    expect(iv.byteLength).toBe(IV_LENGTH);
    const plain = new TextEncoder().encode('hello there, friend');
    const ct = await aesGcmEncrypt(subkey, iv, plain);
    const back = await aesGcmDecrypt(subkey, iv, ct);
    expect(new TextDecoder().decode(back)).toBe('hello there, friend');
  });

  test('decrypt fails when the ciphertext is tampered (auth tag rejects)', async () => {
    const subkey = await deriveSubkey(masterKey, 'pid');
    const iv = randomIv();
    const ct = await aesGcmEncrypt(subkey, iv, new Uint8Array([1, 2, 3, 4]));
    ct[0] ^= 0xff;
    await expect(aesGcmDecrypt(subkey, iv, ct)).rejects.toThrow();
  });

  test('decrypt fails with the wrong subkey', async () => {
    const a = await deriveSubkey(masterKey, 'pid-a');
    const b = await deriveSubkey(masterKey, 'pid-b');
    const iv = randomIv();
    const ct = await aesGcmEncrypt(a, iv, new Uint8Array([9, 9, 9]));
    await expect(aesGcmDecrypt(b, iv, ct)).rejects.toThrow();
  });
});

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
