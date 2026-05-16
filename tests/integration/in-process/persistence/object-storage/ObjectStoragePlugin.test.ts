import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { PersistenceExtensionId } from '../../../../../src/persistence/PersistenceExtension.js';
import {
  OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID,
  registerObjectStoragePlugins,
} from '../../../../../src/persistence/object-storage/ObjectStoragePlugin.js';
import { ObjectStorageSnapshotStore } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStore.js';
import { ObjectStorageDurableStateStore } from '../../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStore.js';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'actor-ts-plugin-'));
});

afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('registerObjectStoragePlugins — filesystem backend', () => {
  test('extension picks up the snapshot plugin when its id is in the config', async () => {
    const sys = ActorSystem.create('obj-store-plugin', {
      logger: new NoopLogger(), logLevel: LogLevel.Off,
      config: {
        'actor-ts': {
          persistence: {
            'snapshot-store': { plugin: OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID },
          },
        },
      },
    });
    const ext = sys.extension(PersistenceExtensionId);
    const handles = await registerObjectStoragePlugins(ext, {
      backend: { kind: 'filesystem', dir },
      keepN: 2,
    });

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
    const sys = ActorSystem.create('obj-store-shared', {
      logger: new NoopLogger(), logLevel: LogLevel.Off,
    });
    const ext = sys.extension(PersistenceExtensionId);
    const { durableStateStore, backend } = await registerObjectStoragePlugins(ext, {
      backend: { kind: 'filesystem', dir },
      prefix: 'shared/',
    });

    await durableStateStore.upsert('account-1', 0, { balance: 100 });
    // Backend list reveals the durable-state key under the same prefix.
    const items = await backend.list({ prefix: 'shared/' });
    expect(items.map(i => i.key)).toContain('shared/account-1/state.json');
    await sys.terminate();
  });

  test('custom backend short-circuits the spec switch', async () => {
    const sys = ActorSystem.create('obj-store-custom', {
      logger: new NoopLogger(), logLevel: LogLevel.Off,
    });
    const ext = sys.extension(PersistenceExtensionId);
    const fs = new FilesystemObjectStorageBackend({ dir });
    const { backend } = await registerObjectStoragePlugins(ext, {
      backend: { kind: 'custom', backend: fs },
    });
    expect(backend).toBe(fs);
    await sys.terminate();
  });
});
