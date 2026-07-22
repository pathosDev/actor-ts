import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  MariaDbDurableStateStore,
  MariaDbDurableStateStoreOptions,
  MariaDbJournal,
  MariaDbJournalOptions,
  MariaDbSnapshotStore,
  MariaDbSnapshotStoreOptions,
  ObjectStorageDurableStateStore,
  ObjectStorageDurableStateStoreOptions,
  ObjectStoragePluginOptions,
  ObjectStorageSnapshotStore,
  ObjectStorageSnapshotStoreOptions,
  PersistenceExtensionId,
  PostgresDurableStateStore,
  PostgresDurableStateStoreOptions,
  PostgresJournal,
  PostgresJournalOptions,
  PostgresSnapshotStore,
  PostgresSnapshotStoreOptions,
  registerObjectStoragePlugins,
} from '../../../../src/persistence/index.js';
import type { ObjectStorageBackend, ObjectFetched, ObjectInfo, PutOptions } from '../../../../src/persistence/index.js';
import { none, type Option } from '../../../../src/util/Option.js';
import { FakePgPool } from './FakePgPool.js';
import { FakeMariaDbPool } from './FakeMariaDbPool.js';

/** Backend that records how many times close() was called; other ops are unused here. */
class CountingBackend implements ObjectStorageBackend {
  closeCount = 0;
  async put(): Promise<{ etag: string }> { return { etag: 'e' }; }
  async get(): Promise<Option<ObjectFetched>> { return none; }
  async delete(): Promise<void> {}
  async list(): Promise<ObjectInfo[]> { return []; }
  async close(): Promise<void> { this.closeCount++; }
}

describe('close() ownership — injected pools are not ended by an individual store', () => {
  test('Postgres journal / snapshot / durable-state leave an injected pool open', async () => {
    const pgJournalPool = new FakePgPool();
    const pgSnapshotPool = new FakePgPool();
    const pgStatePool = new FakePgPool();

    const journal = new PostgresJournal(PostgresJournalOptions.create().withPool(pgJournalPool));
    const snapshots = new PostgresSnapshotStore(PostgresSnapshotStoreOptions.create().withPool(pgSnapshotPool));
    const state = new PostgresDurableStateStore(PostgresDurableStateStoreOptions.create().withPool(pgStatePool));

    await journal.close();
    await snapshots.close();
    await state.close();

    expect(pgJournalPool.ended).toBe(false);
    expect(pgSnapshotPool.ended).toBe(false);
    expect(pgStatePool.ended).toBe(false);
  });

  test('MariaDB journal / snapshot / durable-state leave an injected pool open', async () => {
    const mariaJournalPool = new FakeMariaDbPool();
    const mariaSnapshotPool = new FakeMariaDbPool();
    const mariaStatePool = new FakeMariaDbPool();

    const journal = new MariaDbJournal(MariaDbJournalOptions.create().withPool(mariaJournalPool));
    const snapshots = new MariaDbSnapshotStore(MariaDbSnapshotStoreOptions.create().withPool(mariaSnapshotPool));
    const state = new MariaDbDurableStateStore(MariaDbDurableStateStoreOptions.create().withPool(mariaStatePool));

    await journal.close();
    await snapshots.close();
    await state.close();

    expect(mariaJournalPool.ended).toBe(false);
    expect(mariaSnapshotPool.ended).toBe(false);
    expect(mariaStatePool.ended).toBe(false);
  });
});

describe('close() ownership — object-storage backend', () => {
  test('a standalone store closes the backend it was given', async () => {
    const backend = new CountingBackend();
    const store = new ObjectStorageSnapshotStore(
      ObjectStorageSnapshotStoreOptions.create().withBackend(backend),
    );
    await store.close();
    expect(backend.closeCount).toBe(1);
  });

  test('a store told it does not own the backend leaves it open', async () => {
    const backend = new CountingBackend();
    const snapshots = new ObjectStorageSnapshotStore(
      ObjectStorageSnapshotStoreOptions.create().withBackend(backend).withOwnsBackend(false),
    );
    const state = new ObjectStorageDurableStateStore(
      ObjectStorageDurableStateStoreOptions.create().withBackend(backend).withOwnsBackend(false),
    );
    await snapshots.close();
    await state.close();
    expect(backend.closeCount).toBe(0);
  });

  test('registerObjectStoragePlugins shares one backend and closes it once via handles.close()', async () => {
    const backend = new CountingBackend();
    const system = ActorSystem.create(
      'os-close',
      ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
    );
    const ext = system.extension(PersistenceExtensionId);
    const handles = await registerObjectStoragePlugins(
      ext,
      ObjectStoragePluginOptions.create().withBackend({ kind: 'custom', backend }),
    );

    // Closing an individual store must NOT close the shared backend.
    await handles.durableStateStore.close();
    expect(backend.closeCount).toBe(0);

    // The plugin owns the backend and closes it exactly once (idempotent).
    await handles.close();
    await handles.close();
    expect(backend.closeCount).toBe(1);
  });
});
