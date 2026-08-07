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
const info = 'acme/test/snapshot/v1';

describe('Encryption — deriveSubkey', () => {
  test('produces a 32-byte subkey', async () => {
    const sub = await deriveSubkey(masterKey, 'pid-1', info);
    expect(sub.byteLength).toBe(32);
  });

  test('different persistence ids produce different subkeys', async () => {
    const first = await deriveSubkey(masterKey, 'tenant-acme/pid-1', info);
    const second = await deriveSubkey(masterKey, 'tenant-bigcorp/pid-1', info);
    expect(equalBytes(first, second)).toBe(false);
  });

  test('same persistence id + same master key + same info → same subkey', async () => {
    const first = await deriveSubkey(masterKey, 'pid-1', info);
    const second = await deriveSubkey(masterKey, 'pid-1', info);
    expect(equalBytes(first, second)).toBe(true);
  });

  test('different info strings produce different subkeys', async () => {
    const first = await deriveSubkey(masterKey, 'pid-1', 'info-A');
    const second = await deriveSubkey(masterKey, 'pid-1', 'info-B');
    expect(equalBytes(first, second)).toBe(false);
  });

  test('rejects a non-32-byte master key', async () => {
    await expect(deriveSubkey(new Uint8Array(16), 'pid', info)).rejects.toThrow(/32 bytes/);
  });

  /*
   * #108 — the type makes `info` required, but the config crosses into
   * JavaScript consumers and `as any` call sites.  Without the runtime
   * guard a missing `info` derives from the literal string "undefined",
   * i.e. the same subkey in every deployment sharing a master key: the
   * exact defect this issue removed, only invisible.
   */
  test('rejects a missing info (the JavaScript-caller path)', async () => {
    const untyped = deriveSubkey as unknown as (
      key: Uint8Array, pid: string, info?: string,
    ) => Promise<Uint8Array>;
    await expect(untyped(masterKey, 'pid')).rejects.toThrow(/info must be a non-empty string/);
  });

  test('rejects an empty info', async () => {
    await expect(deriveSubkey(masterKey, 'pid', '')).rejects.toThrow(/info must be a non-empty string/);
  });

  test('a missing info does not silently derive the same subkey as the string "undefined"', async () => {
    // Belt-and-braces: were the guard ever removed, this is what the
    // corpus would quietly be encrypted under.
    const untyped = deriveSubkey as unknown as (
      key: Uint8Array, pid: string, info?: string,
    ) => Promise<Uint8Array>;
    await expect(untyped(masterKey, 'pid')).rejects.toThrow();
    const literal = await deriveSubkey(masterKey, 'pid', 'undefined');
    expect(literal.byteLength).toBe(32);
  });
});

describe('Encryption — AES-256-GCM round-trip', () => {
  test('decrypt yields the original plaintext', async () => {
    const subkey = await deriveSubkey(masterKey, 'pid', info);
    const iv = randomIv();
    expect(iv.byteLength).toBe(IV_LENGTH);
    const plain = new TextEncoder().encode('hello there, friend');
    const ct = await aesGcmEncrypt(subkey, iv, plain);
    const back = await aesGcmDecrypt(subkey, iv, ct);
    expect(new TextDecoder().decode(back)).toBe('hello there, friend');
  });

  test('decrypt fails when the ciphertext is tampered (auth tag rejects)', async () => {
    const subkey = await deriveSubkey(masterKey, 'pid', info);
    const iv = randomIv();
    const ct = await aesGcmEncrypt(subkey, iv, new Uint8Array([1, 2, 3, 4]));
    ct[0] ^= 0xff;
    await expect(aesGcmDecrypt(subkey, iv, ct)).rejects.toThrow();
  });

  test('decrypt fails with the wrong subkey', async () => {
    const first = await deriveSubkey(masterKey, 'pid-a', info);
    const second = await deriveSubkey(masterKey, 'pid-b', info);
    const iv = randomIv();
    const ct = await aesGcmEncrypt(first, iv, new Uint8Array([9, 9, 9]));
    await expect(aesGcmDecrypt(second, iv, ct)).rejects.toThrow();
  });

  test('a subkey derived under a different info cannot decrypt — contexts are separated', async () => {
    // The property #108 exists to give operators: two deployments on the
    // same master key and the same pid still cannot read each other.
    const production = await deriveSubkey(masterKey, 'pid', 'acme/prod/snapshot/v1');
    const staging = await deriveSubkey(masterKey, 'pid', 'acme/staging/snapshot/v1');
    expect(equalBytes(production, staging)).toBe(false);
    const iv = randomIv();
    const ct = await aesGcmEncrypt(production, iv, new Uint8Array([4, 2]));
    await expect(aesGcmDecrypt(staging, iv, ct)).rejects.toThrow();
  });
});

function equalBytes(first: Uint8Array, second: Uint8Array): boolean {
  if (first.length !== second.length) return false;
  for (let i = 0; i < first.length; i++) if (first[i] !== second[i]) return false;
  return true;
}
