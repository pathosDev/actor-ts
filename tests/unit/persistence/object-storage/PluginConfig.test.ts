import { describe, expect, test } from 'bun:test';
import {
  compressionByPrefix,
  encryptionByPrefix,
  resolveCompression,
  resolveEncryption,
} from '../../../../src/persistence/object-storage/PluginConfig.js';

describe('resolveCompression / resolveEncryption', () => {
  test('flat config is returned verbatim', () => {
    const r = resolveCompression({ algorithm: 'gzip' }, 'whatever', { algorithm: 'none' });
    expect(r).toEqual({ algorithm: 'gzip' });
  });

  test('resolver result is preferred over the fallback', () => {
    const r = resolveCompression(
      (pid) => (pid.startsWith('big-') ? { algorithm: 'zstd' } : undefined),
      'big-1',
      { algorithm: 'gzip' },
    );
    expect(r).toEqual({ algorithm: 'zstd' });
  });

  test('resolver returning undefined falls back', () => {
    const r = resolveCompression(
      () => undefined,
      'whatever',
      { algorithm: 'gzip' },
    );
    expect(r).toEqual({ algorithm: 'gzip' });
  });

  test('encryption resolver returning a config is honoured', () => {
    const masterKey = new Uint8Array(32);
    const r = resolveEncryption(
      (pid) => (pid === 'pii' ? { mode: 'client-aes256-gcm', masterKey } : undefined),
      'pii',
      { mode: 'none' },
    );
    expect(r.mode).toBe('client-aes256-gcm');
  });
});

describe('compressionByPrefix / encryptionByPrefix', () => {
  test('compressionByPrefix uses longest-prefix-match and falls back to default', () => {
    const r = compressionByPrefix({
      default: { algorithm: 'gzip' },
      'big/':       { algorithm: 'zstd' },
      'big/short/': { algorithm: 'none' },     // longer prefix wins
    });
    expect(r('big/short/x')).toEqual({ algorithm: 'none' });
    expect(r('big/long-thing')).toEqual({ algorithm: 'zstd' });
    expect(r('other/x')).toEqual({ algorithm: 'gzip' });
  });

  test('compressionByPrefix without a default returns undefined for misses', () => {
    const r = compressionByPrefix({ 'a/': { algorithm: 'gzip' } });
    expect(r('b/x')).toBeUndefined();
  });

  test('encryptionByPrefix supports per-tenant key dispatch', () => {
    const acme = new Uint8Array(32).fill(1);
    const big = new Uint8Array(32).fill(2);
    const r = encryptionByPrefix({
      default: { mode: 'sse-s3' },
      'tenant-acme/':    { mode: 'client-aes256-gcm', masterKey: acme },
      'tenant-bigcorp/': { mode: 'client-aes256-gcm', masterKey: big },
    });
    const acmeRes = r('tenant-acme/order-1');
    const bigRes  = r('tenant-bigcorp/x');
    const otherRes = r('public/y');
    expect(acmeRes?.mode).toBe('client-aes256-gcm');
    expect(bigRes?.mode).toBe('client-aes256-gcm');
    expect(otherRes?.mode).toBe('sse-s3');
    if (acmeRes?.mode === 'client-aes256-gcm') expect(acmeRes.masterKey).toBe(acme);
    if (bigRes?.mode === 'client-aes256-gcm') expect(bigRes.masterKey).toBe(big);
  });
});
