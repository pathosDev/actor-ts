import { describe, expect, test } from 'bun:test';
import {
  compressionByPrefix,
  encryptionByPrefix,
  resolveCompression,
  resolveEncryption,
} from '../../../../../src/persistence/object-storage/PluginConfig.js';

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
      (persistenceId) => (persistenceId === 'pii' ? { mode: 'client-aes256-gcm', masterKey } : undefined),
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
      'tenant-acme/':    { mode: 'client-aes256-gcm', masterKey: acme },
      'tenant-bigcorp/': { mode: 'client-aes256-gcm', masterKey: big },
    });
    const acmeRes = result('tenant-acme/order-1');
    const bigRes  = result('tenant-bigcorp/x');
    const otherRes = result('public/y');
    expect(acmeRes?.mode).toBe('client-aes256-gcm');
    expect(bigRes?.mode).toBe('client-aes256-gcm');
    expect(otherRes?.mode).toBe('sse-s3');
    if (acmeRes?.mode === 'client-aes256-gcm') expect(acmeRes.masterKey).toBe(acme);
    if (bigRes?.mode === 'client-aes256-gcm') expect(bigRes.masterKey).toBe(big);
  });
});
