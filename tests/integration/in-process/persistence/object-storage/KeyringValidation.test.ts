/**
 * #111 — master-key ring validation.
 *
 * The body manifest records a key *version*, never the key itself, so a
 * ring that maps one version to two keys is unresolvable by
 * construction.  `resolveDecryptSubkey` used to resolve it anyway —
 * silently, by checking `active` before `retired` — which turned an
 * operator typo into "half the corpus fails to authenticate" with no
 * error naming the cause.
 *
 * The original report framed this as a >256-rotation overflow.  That
 * framing is too narrow: the same collision is reachable at rotation #2
 * by promoting a key without renumbering it, and these tests exercise it
 * there.
 *
 * What this file pins:
 *   - duplicate / out-of-range / wrong-length entries are refused, and
 *     the message names the offending entry;
 *   - the refusal happens at every entry point a ring can arrive
 *     through — plugin registration, the per-call store config, and the
 *     re-encryption sweep;
 *   - a full key-version space warns before it is spent, and says what
 *     to do about it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { PersistenceExtensionId } from '../../../../../src/persistence/PersistenceExtension.js';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { ObjectStorageSnapshotStore } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStore.js';
import { ObjectStorageSnapshotStoreOptions } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
import { registerObjectStoragePlugins } from '../../../../../src/persistence/object-storage/ObjectStoragePlugin.js';
import { ObjectStoragePluginOptions } from '../../../../../src/persistence/object-storage/ObjectStoragePluginOptions.js';
import { encryptionByPrefix } from '../../../../../src/persistence/object-storage/PluginConfig.js';
import { reEncryptObjectStorage } from '../../../../../src/persistence/object-storage/ReEncryptionSweep.js';
import {
  KEY_VERSION_EXHAUSTION_THRESHOLD,
  MAX_KEY_VERSION,
  keyVersionExhaustionWarning,
  validateMasterKeyRing,
} from '../../../../../src/persistence/object-storage/Encryption.js';
import type { MasterKeyRing } from '../../../../../src/persistence/PersistenceOptions.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'actor-ts-keyring-validation-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const v0 = new Uint8Array(32).fill(0xa0);
const v1 = new Uint8Array(32).fill(0xa1);
const v2 = new Uint8Array(32).fill(0xa2);
const info = 'acme/test/snapshot/v1';

/** The typo the report needs 256 rotations to reach — available at rotation #2. */
const duplicateRing: MasterKeyRing = {
  active: { version: 1, key: v2 },
  retired: [{ version: 1, key: v1 }],
};

function silencedSystem(name: string): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, systemOptions);
}

describe('validateMasterKeyRing (#111)', () => {
  test('accepts a well-formed ring', () => {
    const ring: MasterKeyRing = {
      active: { version: 2, key: v2 },
      retired: [{ version: 1, key: v1 }, { version: 0, key: v0 }],
    };
    expect(() => validateMasterKeyRing(ring)).not.toThrow();
  });

  test('accepts a ring with no retired entries', () => {
    expect(() => validateMasterKeyRing({ active: { version: 0, key: v0 } })).not.toThrow();
  });

  test('rejects a version shared by active and a retired entry', () => {
    expect(() => validateMasterKeyRing(duplicateRing))
      .toThrow(/version 1 appears twice \(active and retired\[0\]\)/);
  });

  test('rejects a version shared by two retired entries', () => {
    const ring: MasterKeyRing = {
      active: { version: 2, key: v2 },
      retired: [{ version: 0, key: v0 }, { version: 0, key: v1 }],
    };
    expect(() => validateMasterKeyRing(ring))
      .toThrow(/version 0 appears twice \(retired\[0\] and retired\[1\]\)/);
  });

  test('rejects a version past the single manifest byte', () => {
    expect(() => validateMasterKeyRing({ active: { version: 256, key: v0 } }))
      .toThrow(/keyring active version must be an integer in \[0, 255\], got 256/);
  });

  test('rejects a negative or fractional version, naming the retired slot', () => {
    const negative: MasterKeyRing = {
      active: { version: 1, key: v1 },
      retired: [{ version: -1, key: v0 }],
    };
    expect(() => validateMasterKeyRing(negative)).toThrow(/keyring retired\[0\] version/);
    const fractional: MasterKeyRing = {
      active: { version: 1, key: v1 },
      retired: [{ version: 1.5, key: v0 }],
    };
    expect(() => validateMasterKeyRing(fractional)).toThrow(/keyring retired\[0\] version/);
  });

  /**
   * A short retired key is otherwise invisible until a body at that
   * version is read — which can be months after the config shipped.
   */
  test('rejects a key that is not 32 bytes', () => {
    const ring: MasterKeyRing = {
      active: { version: 1, key: v1 },
      retired: [{ version: 0, key: new Uint8Array(16) }],
    };
    expect(() => validateMasterKeyRing(ring))
      .toThrow(/keyring retired\[0\] key must be 32 bytes \(AES-256\), got 16/);
  });

  test('rejects malformed input that only a JavaScript caller can produce', () => {
    const noActive = { retired: [{ version: 0, key: v0 }] } as unknown as MasterKeyRing;
    expect(() => validateMasterKeyRing(noActive)).toThrow(/keyring active is not a \{ version, key \} entry/);
    expect(() => validateMasterKeyRing(undefined as unknown as MasterKeyRing))
      .toThrow(/keyring must be an object/);
  });

  test('the error prefix names the caller', () => {
    expect(() => validateMasterKeyRing(duplicateRing, 'registerObjectStoragePlugins'))
      .toThrow(/^registerObjectStoragePlugins: /);
  });
});

describe('keyring validation at the entry points (#111)', () => {
  test('registerObjectStoragePlugins refuses a duplicate-version ring', async () => {
    const system = silencedSystem('keyring-registration');
    const extension = system.extension(PersistenceExtensionId);
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withEncryption({ mode: 'client-aes256-gcm', masterKeys: duplicateRing, info });
    await expect(registerObjectStoragePlugins(extension, pluginOptions))
      .rejects.toThrow(/registerObjectStoragePlugins: keyring version 1 appears twice/);
    await system.terminate();
  });

  /** Resolver-provided configs are reachable via `__knownConfigs`, same as the peer-dep probe. */
  test('registerObjectStoragePlugins looks inside an encryptionByPrefix resolver', async () => {
    const system = silencedSystem('keyring-registration-resolver');
    const extension = system.extension(PersistenceExtensionId);
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withEncryption(encryptionByPrefix({
        default: { mode: 'sse-s3' },
        'secret-': { mode: 'client-aes256-gcm', masterKeys: duplicateRing, info },
      }));
    await expect(registerObjectStoragePlugins(extension, pluginOptions))
      .rejects.toThrow(/keyring version 1 appears twice/);
    await system.terminate();
  });

  test('a well-formed ring still registers', async () => {
    const system = silencedSystem('keyring-registration-ok');
    const extension = system.extension(PersistenceExtensionId);
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withEncryption({
        mode: 'client-aes256-gcm',
        masterKeys: { active: { version: 1, key: v1 }, retired: [{ version: 0, key: v0 }] },
        info,
      });
    await expect(registerObjectStoragePlugins(extension, pluginOptions)).resolves.toBeDefined();
    await system.terminate();
  });

  /**
   * A store configured directly never passes through registration, so the
   * ring's own entry points have to carry the guard as well.
   */
  test('a store configured with a duplicate-version ring fails on write and on read', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);

    // Lay down one readable body under a sound ring, so the read below
    // reaches the resolver instead of returning "nothing stored".
    const soundStoreOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption({
        mode: 'client-aes256-gcm',
        masterKeys: { active: { version: 1, key: v1 } },
        info,
      });
    await new ObjectStorageSnapshotStore(soundStoreOptions).save('user-1', 1, { balance: 100 });

    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption({ mode: 'client-aes256-gcm', masterKeys: duplicateRing, info });
    const store = new ObjectStorageSnapshotStore(storeOptions);
    await expect(store.save('user-1', 2, { balance: 200 }))
      .rejects.toThrow(/keyring version 1 appears twice/);
    // Without the guard this read would decrypt under `active` (v2's key)
    // and fail with an opaque authentication-tag error instead.
    await expect(store.loadLatest('user-1'))
      .rejects.toThrow(/keyring version 1 appears twice/);
  });

  test('reEncryptObjectStorage refuses a duplicate-version ring before touching the corpus', async () => {
    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(dir);
    const backend = new FilesystemObjectStorageBackend(backendOptions);
    await expect(reEncryptObjectStorage(backend, {
      keyPrefix: '',
      keyring: duplicateRing,
      info,
    })).rejects.toThrow(/reEncryptObjectStorage: keyring version 1 appears twice/);
  });
});

describe('key-version exhaustion warning (#111)', () => {
  test('stays quiet while there is headroom', () => {
    const belowThreshold = KEY_VERSION_EXHAUSTION_THRESHOLD - 1;
    expect(keyVersionExhaustionWarning({ active: { version: belowThreshold, key: v0 } }))
      .toBeUndefined();
  });

  test('fires from the threshold on and reports the remaining headroom', () => {
    const atThreshold = keyVersionExhaustionWarning({
      active: { version: KEY_VERSION_EXHAUSTION_THRESHOLD, key: v0 },
    });
    expect(atThreshold).toContain(`${MAX_KEY_VERSION - KEY_VERSION_EXHAUSTION_THRESHOLD} version number(s) remain`);
    // The remedy matters more than the number — an operator who reads
    // only the first line should still know the space is reusable.
    expect(atThreshold).toContain('reEncryptObjectStorage');
    expect(keyVersionExhaustionWarning({ active: { version: MAX_KEY_VERSION, key: v0 } }))
      .toContain('0 version number(s) remain');
  });

  test('registration emits the warning', async () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]): void => { warnings.push(args.map(String).join(' ')); };
    try {
      const system = silencedSystem('keyring-exhaustion-warning');
      const extension = system.extension(PersistenceExtensionId);
      const pluginOptions = ObjectStoragePluginOptions.create()
        .withBackend({ kind: 'filesystem', dir })
        .withEncryption({
          mode: 'client-aes256-gcm',
          masterKeys: { active: { version: 250, key: v2 }, retired: [{ version: 249, key: v1 }] },
          info,
        });
      await registerObjectStoragePlugins(extension, pluginOptions);
      await system.terminate();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes('the active master-key version is 250'))).toBe(true);
  });

  test('registration of a low-numbered ring warns about nothing', async () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]): void => { warnings.push(args.map(String).join(' ')); };
    try {
      const system = silencedSystem('keyring-no-warning');
      const extension = system.extension(PersistenceExtensionId);
      const pluginOptions = ObjectStoragePluginOptions.create()
        .withBackend({ kind: 'filesystem', dir })
        .withEncryption({
          mode: 'client-aes256-gcm',
          masterKeys: { active: { version: 2, key: v2 } },
          info,
        });
      await registerObjectStoragePlugins(extension, pluginOptions);
      await system.terminate();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toEqual([]);
  });
});

/* ===== #1050 — a reused version once the retired entry has been deleted ===== */

/**
 * The duplicate check above catches a reused version only while both entries
 * are in the ring.  Its message used to end "Give every entry in the ring its
 * own version", which deleting the retired entry also satisfies — and that
 * ring passes every check while every body written under the old key stops
 * authenticating.  Nothing can detect the reuse once the old key is gone, so
 * the two things left are the message that sends the operator down the right
 * path, and a read failure that names the likely cause instead of a bare
 * `OperationError`.
 */
describe('a reused key version after the retired entry is gone (#1050)', () => {
  test('the duplicate-version message rules out deleting the retired entry', () => {
    let caught: unknown = null;
    try { validateMasterKeyRing(duplicateRing); } catch (error) { caught = error; }
    expect((caught as Error).message).toMatch(/give the promoted key the next free version number/i);
    expect((caught as Error).message).toMatch(/do not remove the retired entry/i);
  });

  test('a body that fails to authenticate names its key version and the probable cause', async () => {
    const backend = new FilesystemObjectStorageBackend(FilesystemObjectStorageOptions.create().withDir(dir));
    const writerOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption({ mode: 'client-aes256-gcm', masterKeys: { active: { version: 1, key: v1 } }, info });
    await new ObjectStorageSnapshotStore(writerOptions).save('user-1', 1, { balance: 100 });

    // The issue's reproduction: version 1 now maps to another key, and the
    // ring that says so is valid — there is no duplicate left to refuse.
    const reused: MasterKeyRing = { active: { version: 1, key: v2 } };
    expect(() => validateMasterKeyRing(reused)).not.toThrow();
    const readerOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(backend)
      .withEncryption({ mode: 'client-aes256-gcm', masterKeys: reused, info });
    const reader = new ObjectStorageSnapshotStore(readerOptions);
    await expect(reader.loadLatest('user-1'))
      .rejects.toThrow(/key version 1 failed to authenticate.*probably not the key it was written with/s);
  });
});
