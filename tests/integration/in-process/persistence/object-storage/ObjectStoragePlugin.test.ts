import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions, ActorSystemOptionsBuilder } from '../../../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../../../src/config/HoconParser.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { DurableStateStore } from '../../../../../src/persistence/DurableStateStore.js';
import { PersistenceExtensionId, type PersistencePlugin } from '../../../../../src/persistence/PersistenceExtension.js';
import type { SnapshotStore } from '../../../../../src/persistence/SnapshotStore.js';
import {
  OBJECT_STORAGE_DURABLE_STATE_PLUGIN_ID,
  OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID,
  registerObjectStoragePlugins,
  type ObjectStoragePluginHandles,
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
import {
  OBJECT_STORAGE_DURABLE_STATE_NAMESPACE,
  OBJECT_STORAGE_SNAPSHOT_NAMESPACE,
} from '../../../../../src/persistence/Constants.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'actor-ts-plugin-'));
});

afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

/** Quiet, and selecting nothing — what every system here starts from. */
function quietOptions(): ActorSystemOptionsBuilder {
  return ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
}

/** {@link quietOptions} with the object-storage snapshot store selected. */
function selectingSnapshotStore(): ActorSystemOptionsBuilder {
  return quietOptions().withConfig({
    'actor-ts': {
      persistence: {
        'snapshot-store': { plugin: OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID },
      },
    },
  });
}

/**
 * Create a system from `systemOptions` with the object-storage plug-ins
 * registered through its `plugins` slot (#1473), and wait for its startup —
 * which is where the registration's peer-dependency probes are awaited.
 * Answers with the handles the registration returned.
 */
async function readySystem(
  name: string,
  systemOptions: ActorSystemOptionsBuilder,
  pluginOptions?: ObjectStoragePluginOptions,
): Promise<{ readonly sys: ActorSystem; readonly handles: ObjectStoragePluginHandles }> {
  const registrations: Array<Promise<ObjectStoragePluginHandles>> = [];
  const plugin: PersistencePlugin = (persistence) => {
    const registration = registerObjectStoragePlugins(persistence, pluginOptions);
    registrations.push(registration);
    return registration;
  };
  const withPlugin = systemOptions.withPersistence({ plugins: [plugin] });
  const sys = ActorSystem.create(name, withPlugin);
  await sys.whenReady();
  return { sys, handles: await registrations[0]! };
}

/**
 * What the startup of a system registering the object-storage plug-ins from
 * `systemOptions` alone failed with — `null` when it did not fail — once the
 * system that failure takes down has terminated.
 */
async function startupFailureOf(name: string, systemOptions: ActorSystemOptionsBuilder): Promise<Error | null> {
  const withPlugin = systemOptions.withPersistence({
    plugins: [(persistence) => registerObjectStoragePlugins(persistence)],
  });
  const sys = ActorSystem.create(name, withPlugin);
  try {
    return await sys.whenReady().then(() => null, (e: unknown) => e as Error);
  } finally {
    await sys.terminate();
    await sys.whenTerminated();
  }
}

describe('registerObjectStoragePlugins — filesystem backend', () => {
  test('extension picks up the snapshot plugin when its id is in the config', async () => {
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withKeepN(2);
    const { sys, handles } = await readySystem('obj-store-plugin', selectingSnapshotStore(), pluginOptions);
    const ext = sys.extension(PersistenceExtensionId);

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

  /*
   * #716 — this used to assert only that the durable-state key appeared
   * under the shared prefix, and it never saved a snapshot for the same
   * persistenceId.  The shared *prefix* is deliberate; the shared key
   * namespace was not, and the collision it created was untested: since
   * `'state.json'` collates after every zero-padded sequence key, the
   * snapshot store's `loadLatest` returned the durable-state record, whose
   * body has no `sequenceNr`, and recovery died with an integrity error.
   *
   * So the assertion is now the disjointness itself, with both stores
   * writing the same id under one prefix — which is exactly the shape the
   * old test avoided.
   */
  test('shared backend, disjoint namespaces: one id written both ways does not collide', async () => {
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withPrefix('shared/');
    const { sys, handles } = await readySystem('obj-store-shared', selectingSnapshotStore(), pluginOptions);
    const ext = sys.extension(PersistenceExtensionId);
    const { durableStateStore, backend } = handles;

    await durableStateStore.upsert('account-1', 0, { balance: 100 });
    await ext.snapshotStore.save('account-1', 7, { balance: 42 });

    // Both stores still see each other's writes — one backend, one prefix —
    // but each corpus has a namespace segment of its own.
    const items = (await backend.list({ prefix: 'shared/' })).map(i => i.key);
    expect(items).toContain(`shared/${OBJECT_STORAGE_DURABLE_STATE_NAMESPACE}account-1/state.json`);
    expect(items).toContain(
      `shared/${OBJECT_STORAGE_SNAPSHOT_NAMESPACE}account-1/00000000000000000007.json`,
    );

    // And the snapshot load returns the snapshot, not the durable-state
    // record that used to sort after it.
    const latest = await ext.snapshotStore.loadLatest<{ balance: number }>('account-1');
    expect(latest.toNullable()?.sequenceNr).toBe(7);
    expect(latest.toNullable()?.state).toEqual({ balance: 42 });
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
 * #873 — every field of the plugin used to be constructor-only, so a bucket,
 * a prefix or a retention count could not be changed without a code change.
 * These cover the whole path: HOCON → reader → merge → validator → a built
 * backend that actually stores something, plus the precedence rule and the
 * one mode the block deliberately refuses.
 */
describe('registerObjectStoragePlugins — from configuration (#873)', () => {
  /** The plugin block, nested — never the dotted-key form, which HOCON keeps literal. */
  function systemOptions(objectStorage: ConfigObject): ActorSystemOptionsBuilder {
    return quietOptions().withConfig({
      'actor-ts': {
        persistence: {
          'snapshot-store': {
            plugin: OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID,
            'object-storage': objectStorage,
          },
        },
      },
    });
  }

  test('a snapshot store built purely from HOCON round-trips, prefix and keep-n honoured', async () => {
    // No options at all — the acceptance criterion of #873.
    const { sys, handles: { backend } } = await readySystem('obj-store-from-config', systemOptions({
      backend: 'filesystem',
      prefix: 'cfg/',
      'keep-n': 1,
      filesystem: { dir },
    }));
    const ext = sys.extension(PersistenceExtensionId);

    expect(ext.snapshotStore).toBeInstanceOf(ObjectStorageSnapshotStore);
    expect(backend).toBeInstanceOf(FilesystemObjectStorageBackend);

    await ext.snapshotStore.save('p', 1, { x: 1 });
    await ext.snapshotStore.save('p', 2, { x: 2 });
    expect((await ext.snapshotStore.loadLatest<{ x: number }>('p')).toNullable()?.state).toEqual({ x: 2 });

    // The configured prefix reached the store, and the configured retention
    // pruned the older snapshot rather than the built-in keepN = 3.  Listed
    // under the configured prefix rather than under a full key: the segments
    // the store puts between the prefix and the entity are its own layout.
    const stored = await backend.list({ prefix: 'cfg/' });
    expect(stored.length).toBe(1);
    expect(stored[0]!.key.startsWith('cfg/')).toBe(true);
    expect(stored[0]!.key).toContain('/p/');

    await ext.snapshotStore.close?.();
    await sys.terminate();
  });

  test('explicit options beat HOCON, field by field', async () => {
    // Only `prefix` is set in code; `backend`, `keep-n` and the rest still
    // come from HOCON, which is what "per field" has to mean.
    const pluginOptions = ObjectStoragePluginOptions.create().withPrefix('from-code/');
    const { sys, handles: { backend } } = await readySystem('obj-store-config-precedence', systemOptions({
      backend: 'filesystem',
      prefix: 'from-config/',
      'keep-n': 1,
      filesystem: { dir },
    }), pluginOptions);
    const ext = sys.extension(PersistenceExtensionId);

    await ext.snapshotStore.save('p', 1, { x: 1 });

    expect((await backend.list({ prefix: 'from-code/' })).length).toBe(1);
    expect((await backend.list({ prefix: 'from-config/' })).length).toBe(0);
    expect(backend).toBeInstanceOf(FilesystemObjectStorageBackend);

    await ext.snapshotStore.close?.();
    await sys.terminate();
  });

  test('a config naming s3 without a bucket fails the startup at registration, naming the field', async () => {
    const failure = await startupFailureOf('obj-store-config-invalid', systemOptions({ backend: 's3' }));

    // Not "backend is required": the operator did supply one, and the message
    // has to point at the leaf that is actually missing.
    expect(failure).toBeInstanceOf(Error);
    expect((failure!.cause as Error).message).toMatch(/backend\.bucket/);
  });

  test('client-side encryption cannot be switched on from a config file', async () => {
    const failure = await startupFailureOf('obj-store-config-client-encryption', systemOptions({
      backend: 'filesystem',
      filesystem: { dir },
      encryption: { mode: 'client-aes256-gcm' },
    }));

    expect(failure).toBeInstanceOf(Error);
    expect((failure!.cause as Error).message).toMatch(/withEncryption/);
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
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY });
    const { sys, handles } = await readySystem('obj-store-integrity', selectingSnapshotStore(), pluginOptions);
    const ext = sys.extension(PersistenceExtensionId);
    const { durableStateStore, backend } = handles;

    await ext.snapshotStore.save('p', 1, { x: 1 });
    await durableStateStore.upsert('account-1', 0, { balance: 100 });

    const snapshotBody = await backend.get(
      `${OBJECT_STORAGE_SNAPSHOT_NAMESPACE}p/00000000000000000001.json`,
    );
    const durableStateBody = await backend.get(
      `${OBJECT_STORAGE_DURABLE_STATE_NAMESPACE}account-1/state.json`,
    );
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
    await backend.put(
      `${OBJECT_STORAGE_DURABLE_STATE_NAMESPACE}account-1/state.json`,
      forged,
      { contentType: 'application/json' },
    );

    durableStateStore.forgetEtagForTest('account-1');
    await expect(durableStateStore.load('account-1')).rejects.toThrow(/integrity/);
    await sys.terminate();
  });

  test('allowUntaggedBodies reaches both stores for the migration window', async () => {
    // Pre-existing untagged corpus, written before integrity was on.
    const plainOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withCompression({ algorithm: 'none' });
    const plainSystem = await readySystem('obj-store-integrity-window-seed', selectingSnapshotStore(), plainOptions);
    const plainExt = plainSystem.sys.extension(PersistenceExtensionId);
    await plainExt.snapshotStore.save('p', 1, { x: 1 });
    await plainSystem.handles.durableStateStore.upsert('account-1', 0, { balance: 100 });
    await plainSystem.sys.terminate();

    const migratingOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir })
      .withCompression({ algorithm: 'none' })
      .withIntegrity({ mode: 'hmac-sha256', integrityKey: INTEGRITY_KEY })
      .withAllowUntaggedBodies(true);
    const { sys, handles: { durableStateStore } } = await readySystem(
      'obj-store-integrity-window', selectingSnapshotStore(), migratingOptions,
    );
    const ext = sys.extension(PersistenceExtensionId);

    expect((await ext.snapshotStore.loadLatest<{ x: number }>('p')).toNullable()?.state).toEqual({ x: 1 });
    expect((await durableStateStore.load<{ balance: number }>('account-1')).toNullable()?.revision).toBe(1);
    await sys.terminate();
  });
});

/*
 * #1473 — the two factories are registered before the peer-dependency probes
 * run, not after.  A plug-in passed to `withPersistence({ plugins })` runs
 * inside `ActorSystem.create` and only its synchronous part is over when
 * `create` returns; registering after the probe's `await` left both stores
 * unregistered until a microtask turn later, so a selected object-storage
 * store did not resolve on the line after `create`.  The probe's verdict
 * still settles the promise.
 */
describe('registerObjectStoragePlugins — registered before the probes run (#1473)', () => {
  /**
   * Run `body` with `globalThis.crypto.subtle` absent — the filesystem
   * backend's ETag probe then fails.  The stand-in forwards the two CSPRNG
   * calls a registration also makes, as `PeerDepValidation.test.ts` explains.
   */
  async function withoutSubtleCrypto<Result>(body: () => Promise<Result>): Promise<Result> {
    const realCrypto = globalThis.crypto;
    const withoutSubtle = {
      getRandomValues: <View extends ArrayBufferView | null>(array: View): View =>
        realCrypto.getRandomValues(array),
      randomUUID: () => realCrypto.randomUUID(),
      subtle: undefined,
    } as unknown as Crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: withoutSubtle, configurable: true, writable: true,
    });
    try {
      return await body();
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: realCrypto, configurable: true, writable: true,
      });
    }
  }

  function selectingBothStores(): ActorSystemOptionsBuilder {
    return quietOptions().withConfig({
      'actor-ts': {
        persistence: {
          'snapshot-store': { plugin: OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID },
          'durable-state': { plugin: OBJECT_STORAGE_DURABLE_STATE_PLUGIN_ID },
        },
      },
    });
  }

  test('both factories are registered before the promise settles, and build the handles\' store', async () => {
    // The helper called on its own, so nothing is selected: a selected plug-in
    // belongs in the `plugins` slot.  What it registers is recorded on the
    // extension instance instead.
    const sys = ActorSystem.create('obj-store-registered-first', quietOptions());
    const ext = sys.extension(PersistenceExtensionId);
    const snapshotFactories = new Map<string, (system: ActorSystem) => SnapshotStore>();
    const durableStateFactories = new Map<string, (system: ActorSystem) => DurableStateStore>();
    const registerSnapshotStore = ext.registerSnapshotStore.bind(ext);
    const registerDurableStateStore = ext.registerDurableStateStore.bind(ext);
    ext.registerSnapshotStore = (pluginId, factory) => {
      snapshotFactories.set(pluginId, factory);
      registerSnapshotStore(pluginId, factory);
    };
    ext.registerDurableStateStore = (pluginId, factory) => {
      durableStateFactories.set(pluginId, factory);
      registerDurableStateStore(pluginId, factory);
    };
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir });
    const registration = registerObjectStoragePlugins(ext, pluginOptions);

    // Not awaited yet: what the synchronous part of the call left behind.
    expect([...snapshotFactories.keys()]).toEqual([OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID]);
    expect([...durableStateFactories.keys()]).toEqual([OBJECT_STORAGE_DURABLE_STATE_PLUGIN_ID]);

    const handles = await registration;
    expect(snapshotFactories.get(OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID)!(sys)).toBeInstanceOf(ObjectStorageSnapshotStore);
    expect(durableStateFactories.get(OBJECT_STORAGE_DURABLE_STATE_PLUGIN_ID)!(sys)).toBe(handles.durableStateStore);
    await sys.terminate();
  });

  test('a failed probe still rejects the registration', async () => {
    const sys = ActorSystem.create('obj-store-registered-probe-fails', quietOptions());
    const ext = sys.extension(PersistenceExtensionId);
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir });
    const error = await withoutSubtleCrypto(() =>
      registerObjectStoragePlugins(ext, pluginOptions).then(() => null, (e: unknown) => e));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/SubtleCrypto is not available/);
    await sys.terminate();
  });

  test('as a plug-in: the stores resolve on the line after create, and a failed probe fails the startup', async () => {
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'filesystem', dir });
    const systemOptions = selectingBothStores()
      .withPersistence({ plugins: [(persistence) => registerObjectStoragePlugins(persistence, pluginOptions)] });
    const failure = await withoutSubtleCrypto(async () => {
      const sys = ActorSystem.create('obj-store-plugin-probe-fails', systemOptions);
      try {
        const ext = sys.extension(PersistenceExtensionId);
        expect(ext.snapshotStore).toBeInstanceOf(ObjectStorageSnapshotStore);
        expect(ext.durableStateStore).toBeInstanceOf(ObjectStorageDurableStateStore);
        return await sys.whenReady().then(() => null, (e: unknown) => e);
      } finally {
        // After a failed startup the system is already going down and this
        // only waits for it; after one that wrongly succeeded it stops it.
        await sys.terminate();
        await sys.whenTerminated();
      }
    });

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('"persistence-start"');
    expect(((failure as Error).cause as Error).message).toMatch(/SubtleCrypto is not available/);
  });
});
