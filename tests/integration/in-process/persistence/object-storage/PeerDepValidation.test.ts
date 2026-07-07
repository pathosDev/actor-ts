/**
 * #18 / #59 — eager peer-dep validation at plugin-init.
 *
 * The historical failure mode: user picks `compression: 'zstd'` (or
 * `encryption: 'client-aes256-gcm'`), registration succeeds, the app
 * runs for hours, and the very first persist call surfaces a peer-dep
 * error.  Fix: probe the runtime / peer-dep at registration time and
 * fail loudly there.
 *
 * What this file verifies:
 *   - `registerObjectStoragePlugins` is now async and awaits the probe.
 *   - For algorithms that work on this runtime (always-`gzip`, plus
 *     `zstd` on Bun where it's native), registration succeeds.
 *   - `compressionByPrefix` / `encryptionByPrefix` attach the
 *     `__knownConfigs` introspection metadata that the validator
 *     uses — opaque user resolvers fall back to first-use.
 *   - The encryption probe surfaces a clear "WebCrypto not available"
 *     error when SubtleCrypto is missing.  We simulate that by
 *     temporarily wiping `globalThis.crypto.subtle`.
 *   - `validateObjectStoragePeerDeps` is callable as a stand-alone
 *     pre-flight check.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { PersistenceExtensionId } from '../../../../../src/persistence/PersistenceExtension.js';
import {
  registerObjectStoragePlugins,
  validateObjectStoragePeerDeps,
} from '../../../../../src/persistence/object-storage/ObjectStoragePlugin.js';
import { ObjectStoragePluginOptions } from '../../../../../src/persistence/object-storage/ObjectStoragePluginOptions.js';
import {
  compressionByPrefix,
  encryptionByPrefix,
  knownConfigsOf,
} from '../../../../../src/persistence/object-storage/PluginConfig.js';
import { probeEncryptionAvailability } from '../../../../../src/persistence/object-storage/Encryption.js';

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'actor-ts-peerdep-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('eager peer-dep validation (#18, #59)', () => {
  test('registration is now async and awaits the probe', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('peerdep-async', sysOptions);
    const ext = sys.extension(PersistenceExtensionId);
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir });
    const result = registerObjectStoragePlugins(ext, pluginOptions);
    // Should be a Promise — the new contract.
    expect(result).toBeInstanceOf(Promise);
    await result;
    await sys.terminate();
  });

  test('gzip + none always probe-succeed (no peer-deps)', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('peerdep-gzip-none', sysOptions);
    const ext = sys.extension(PersistenceExtensionId);
    const gzipPluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withCompression({ algorithm: 'gzip' });
    await expect(registerObjectStoragePlugins(ext, gzipPluginOptions)).resolves.toBeDefined();
    const nonePluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withCompression({ algorithm: 'none' });
    await expect(registerObjectStoragePlugins(ext, nonePluginOptions)).resolves.toBeDefined();
    await sys.terminate();
  });

  test('zstd probe-succeeds on Bun (which ships native zstd)', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('peerdep-zstd', sysOptions);
    const ext = sys.extension(PersistenceExtensionId);
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withCompression({ algorithm: 'zstd' });
    await expect(registerObjectStoragePlugins(ext, pluginOptions)).resolves.toBeDefined();
    await sys.terminate();
  });

  test('compressionByPrefix attaches __knownConfigs introspection metadata', () => {
    const r = compressionByPrefix({
      default: { algorithm: 'gzip' },
      'large/': { algorithm: 'zstd' },
      'tiny/':  { algorithm: 'none' },
    });
    const known = knownConfigsOf(r);
    expect(known).toBeDefined();
    const algos = new Set(known!.map((c) => c.algorithm));
    expect(algos).toEqual(new Set(['gzip', 'zstd', 'none']));
  });

  test('encryptionByPrefix attaches __knownConfigs introspection metadata', () => {
    const r = encryptionByPrefix({
      default: { mode: 'sse-s3' },
      'secrets/': { mode: 'sse-kms', kmsKeyId: 'k1' },
    });
    const known = knownConfigsOf(r);
    expect(known).toBeDefined();
    const modes = new Set(known!.map((c) => c.mode));
    expect(modes).toEqual(new Set(['sse-s3', 'sse-kms']));
  });

  test('opaque user resolver has no introspection metadata — validator skips it', async () => {
    const opaque = (pid: string) => pid.startsWith('big-')
      ? { algorithm: 'gzip' as const }
      : undefined;
    expect(knownConfigsOf(opaque)).toBeUndefined();

    // Should still register cleanly (the probe simply skips opaque
    // resolvers; first-use checks remain).
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('peerdep-opaque', sysOptions);
    const ext = sys.extension(PersistenceExtensionId);
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withCompression(opaque);
    await expect(registerObjectStoragePlugins(ext, pluginOptions)).resolves.toBeDefined();
    await sys.terminate();
  });

  test('compressionByPrefix-built resolver: every algo it could return is probed at registration', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('peerdep-prefix', sysOptions);
    const ext = sys.extension(PersistenceExtensionId);
    // Multiple algos in the spec — the probe should accept all of them
    // (gzip, zstd, none all available on Bun).
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withCompression(compressionByPrefix({
        default: { algorithm: 'gzip' },
        'big/':   { algorithm: 'zstd' },
        'tiny/':  { algorithm: 'none' },
      }));
    await expect(registerObjectStoragePlugins(ext, pluginOptions)).resolves.toBeDefined();
    await sys.terminate();
  });

  test('validateObjectStoragePeerDeps is exported as a stand-alone pre-flight', async () => {
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withCompression({ algorithm: 'gzip' });
    await expect(validateObjectStoragePeerDeps(pluginOptions)).resolves.toBeUndefined();
  });

  test('encryption probe: throws clear "WebCrypto not available" when SubtleCrypto missing', async () => {
    const realCrypto = globalThis.crypto;
    // Wipe `crypto.subtle` for the duration of this test.  Use a
    // shallow stand-in where `subtle` is undefined; restore in finally.
    Object.defineProperty(globalThis, 'crypto', {
      value: { ...realCrypto, subtle: undefined },
      configurable: true,
      writable: true,
    });
    try {
      await expect(probeEncryptionAvailability())
        .rejects.toThrow(/SubtleCrypto is not available/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: realCrypto,
        configurable: true,
        writable: true,
      });
    }
  });

  test('encryption probe: only fires when client-aes256-gcm is configured', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('peerdep-enc-server-side', sysOptions);
    const ext = sys.extension(PersistenceExtensionId);
    // sse-s3 / sse-kms are header-pass-throughs — they don't need
    // SubtleCrypto.  Even if we were running in a hypothetical no-
    // WebCrypto runtime, registration with sse-s3 should still succeed.
    // We can't easily simulate "no SubtleCrypto" while keeping the rest
    // of the system alive, so we just check the happy path: server-side
    // modes register cleanly.
    const sseS3PluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withEncryption({ mode: 'sse-s3' });
    await expect(registerObjectStoragePlugins(ext, sseS3PluginOptions)).resolves.toBeDefined();
    const sseKmsPluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withEncryption({ mode: 'sse-kms', kmsKeyId: 'k1' });
    await expect(registerObjectStoragePlugins(ext, sseKmsPluginOptions)).resolves.toBeDefined();
    await sys.terminate();
  });
});
