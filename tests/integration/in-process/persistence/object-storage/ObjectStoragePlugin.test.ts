import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { PersistenceExtensionId } from '../../../../../src/persistence/PersistenceExtension.js';
import {
  OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID,
  registerObjectStoragePlugins,
} from '../../../../../src/persistence/object-storage/ObjectStoragePlugin.js';
import { ObjectStoragePluginOptions } from '../../../../../src/persistence/object-storage/ObjectStoragePluginOptions.js';
import { ObjectStorageSnapshotStore } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStore.js';
import { ObjectStorageDurableStateStore } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStore.js';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import {
  FLAG_INTEGRITY_HMAC,
  encodeBody,
} from '../../../../../src/persistence/object-storage/BodyCodec.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'actor-ts-plugin-'));
});

afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('registerObjectStoragePlugins — filesystem backend', () => {
  test('extension picks up the snapshot plugin when its id is in the config', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          persistence: {
            'snapshot-store': { plugin: OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID },
          },
        },
      });
    const sys = ActorSystem.create('obj-store-plugin', sysOptions);
    const ext = sys.extension(PersistenceExtensionId);
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withKeepN(2);
    const handles = await registerObjectStoragePlugins(ext, pluginOptions);

    expect(ext.snapshotStore).toBeInstanceOf(ObjectStorageSnapshotStore);
    expect(handles.durableStateStore).toBeInstanceOf(ObjectStorageDurableStateStore);
    expect(handles.backend).toBeInstanceOf(FilesystemObjectStorageBackend);

    // Round-trip through the extension-selected snapshot store.
    await ext.snapshotStore.save('p', 1, { x: 1 });
    const latest = await ext.snapshotStore.loadLatest<{ x: number }>('p');
    expect(latest.toNullable()?.state).toEqual({ x: 1 });

    await ext.snapshotStore.close?.();
    await sys.terminate();
  });

  test('shared backend: snapshot store and durable-state store see each others writes', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('obj-store-shared', sysOptions);
    const ext = sys.extension(PersistenceExtensionId);
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withPrefix('shared/');
    const { durableStateStore, backend } = await registerObjectStoragePlugins(ext, pluginOptions);

    await durableStateStore.upsert('account-1', 0, { balance: 100 });
    // Backend list reveals the durable-state key under the same prefix.
    const items = await backend.list({ prefix: 'shared/' });
    expect(items.map(i => i.key)).toContain('shared/account-1/state.json');
    await sys.terminate();
  });

  test('custom backend short-circuits the spec switch', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('obj-store-custom', sysOptions);
    const ext = sys.extension(PersistenceExtensionId);
    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(dir);
    const fs = new FilesystemObjectStorageBackend(backendOptions);
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'custom', backend: fs });
    const { backend } = await registerObjectStoragePlugins(ext, pluginOptions);
    expect(backend).toBe(fs);
    await sys.terminate();
  });
});

/*
 * #613 — the one-call wiring used to forward compression, encryption,
 * keepN, maxDecompressedBytes and the serializer, and drop integrity on
 * the floor for BOTH stores.  The durable-state store implemented the
 * #116 HMAC in full and there was still no way to switch it on without
 * constructing the store by hand.
 */
describe('registerObjectStoragePlugins — integrity forwarding (#613)', () => {
  const INTEGRITY_KEY = new Uint8Array(32).fill(7);
  const OTHER_KEY = new Uint8Array(32).fill(8);

  /** Body manifest: ATS1 magic at 0..3, flags at byte 4, bit4 = integrity tag. */
  function integrityFlagOf(body: Uint8Array): number {
    return body[4]! & FLAG_INTEGRITY_HMAC;
  }

  test('both registered stores sign their bodies', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          persistence: {
            'snapshot-store': { plugin: OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID },
          },
        },
      });
    const sys = ActorSystem.create('obj-store-integrity', sysOptions);
    const ext = sys.extension(PersistenceExtensionId);
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const { durableStateStore, backend } = await registerObjectStoragePlugins(ext, pluginOptions);

    await ext.snapshotStore.save('p', 1, { x: 1 });
    await durableStateStore.upsert('account-1', 0, { balance: 100 });

    const snapshotBody = await backend.get('p/00000000000000000001.json');
    const durableStateBody = await backend.get('account-1/state.json');
    expect(integrityFlagOf(snapshotBody.toNullable()!.body)).toBe(FLAG_INTEGRITY_HMAC);
    expect(integrityFlagOf(durableStateBody.toNullable()!.body)).toBe(FLAG_INTEGRITY_HMAC);

    // …and both verify on the way back in.
    expect((await ext.snapshotStore.loadLatest<{ x: number }>('p')).toNullable()?.state).toEqual({ x: 1 });
    expect((await durableStateStore.load<{ balance: number }>('account-1')).toNullable()?.revision).toBe(1);

    await sys.terminate();
  });

  test('a store built by the plugin refuses a body signed with another key', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('obj-store-integrity-mismatch', sysOptions);
    const ext = sys.extension(PersistenceExtensionId);
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const { durableStateStore, backend } = await registerObjectStoragePlugins(ext, pluginOptions);
    await durableStateStore.upsert('account-1', 0, { balance: 100 });

    const forged = await encodeBody(
      new TextEncoder().encode(JSON.stringify({ revision: 999, state: { balance: 0 }, timestamp: Date.now() })),
      { integrity: { integrityKey: OTHER_KEY } },
    );
    await backend.put('account-1/state.json', forged, { contentType: 'application/json' });

    durableStateStore.forgetEtagForTest('account-1');
    await expect(durableStateStore.load('account-1')).rejects.toThrow(/integrity/);
    await sys.terminate();
  });

  test('allowUntaggedBodies reaches both stores for the migration window', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          persistence: {
            'snapshot-store': { plugin: OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID },
          },
        },
      });
    const sys = ActorSystem.create('obj-store-integrity-window', sysOptions);
    const ext = sys.extension(PersistenceExtensionId);

    // Pre-existing untagged corpus, written before integrity was on.
    const plainOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withCompression({ algorithm: 'none' });
    const plainSystem = ActorSystem.create('obj-store-integrity-window-seed', sysOptions);
    const plainExt = plainSystem.extension(PersistenceExtensionId);
    const plain = await registerObjectStoragePlugins(plainExt, plainOptions);
    await plainExt.snapshotStore.save('p', 1, { x: 1 });
    await plain.durableStateStore.upsert('account-1', 0, { balance: 100 });
    await plainSystem.terminate();

    const migratingOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY })
      .withAllowUntaggedBodies(true);
    const { durableStateStore } = await registerObjectStoragePlugins(ext, migratingOptions);

    expect((await ext.snapshotStore.loadLatest<{ x: number }>('p')).toNullable()?.state).toEqual({ x: 1 });
    expect((await durableStateStore.load<{ balance: number }>('account-1')).toNullable()?.revision).toBe(1);
    await sys.terminate();
  });
});
