import { describe, expect, test } from 'bun:test';
import {
  compressionByPrefix,
  encryptionByPrefix,
  resolveCompression,
  resolveEncryption,
} from '../../../../../src/persistence/object-storage/PluginConfig.js';

/** HKDF context — required on every client-side encryption config (#108). */
const info = 'acme/test/snapshot/v1';

describe('resolveCompression / resolveEncryption', () => {
  test('flat config is returned verbatim', () => {
    const result = resolveCompression({ algorithm: 'gzip' }, 'whatever', { algorithm: 'none' });
    expect(result).toEqual({ algorithm: 'gzip' });
  });

  test('resolver result is preferred over the fallback', () => {
    const result = resolveCompression(
      (persistenceId) => (persistenceId.startsWith('big-') ? { algorithm: 'zstd' } : undefined),
      'big-1',
      { algorithm: 'gzip' },
    );
    expect(result).toEqual({ algorithm: 'zstd' });
  });

  test('resolver returning undefined falls back', () => {
    const result = resolveCompression(
      () => undefined,
      'whatever',
      { algorithm: 'gzip' },
    );
    expect(result).toEqual({ algorithm: 'gzip' });
  });

  test('encryption resolver returning a config is honoured', () => {
    const masterKey = new Uint8Array(32);
    const result = resolveEncryption(
      (persistenceId) => (persistenceId === 'pii' ? { mode: 'client-aes256-gcm', masterKey, info } : undefined),
      'pii',
      { mode: 'none' },
    );
    expect(result.mode).toBe('client-aes256-gcm');
  });
});

describe('compressionByPrefix / encryptionByPrefix', () => {
  test('compressionByPrefix uses longest-prefix-match and falls back to default', () => {
    const result = compressionByPrefix({
      default: { algorithm: 'gzip' },
      'big/':       { algorithm: 'zstd' },
      'big/short/': { algorithm: 'none' },     // longer prefix wins
    });
    expect(result('big/short/x')).toEqual({ algorithm: 'none' });
    expect(result('big/long-thing')).toEqual({ algorithm: 'zstd' });
    expect(result('other/x')).toEqual({ algorithm: 'gzip' });
  });

  test('compressionByPrefix without a default returns undefined for misses', () => {
    const result = compressionByPrefix({ 'a/': { algorithm: 'gzip' } });
    expect(result('b/x')).toBeUndefined();
  });

  test('encryptionByPrefix supports per-tenant key dispatch', () => {
    const acme = new Uint8Array(32).fill(1);
    const big = new Uint8Array(32).fill(2);
    const result = encryptionByPrefix({
      default: { mode: 'sse-s3' },
      'tenant-acme/':    { mode: 'client-aes256-gcm', masterKey: acme, info },
      'tenant-bigcorp/': { mode: 'client-aes256-gcm', masterKey: big, info },
    });
    const acmeRes = result('tenant-acme/order-1');
    const bigRes  = result('tenant-bigcorp/x');
    const otherRes = result('public/y');
    expect(acmeRes?.mode).toBe('client-aes256-gcm');
    expect(bigRes?.mode).toBe('client-aes256-gcm');
    expect(otherRes?.mode).toBe('sse-s3');
    // Both `client-aes256-gcm` arms of `EncryptionConfig` carry the same
    // `mode` value, so `mode` never narrows to the single-key shape — only
    // probing for the property does, the same check `Encryption.ts` makes.
    // Asserting the probe instead of guarding on it keeps the key
    // comparison from being silently skipped if a ring came back instead.
    if (!acmeRes || !('masterKey' in acmeRes)) throw new Error('acme did not resolve to a single-key config');
    if (!bigRes || !('masterKey' in bigRes)) throw new Error('bigcorp did not resolve to a single-key config');
    expect(acmeRes.masterKey).toBe(acme);
    expect(bigRes.masterKey).toBe(big);
  });
});
