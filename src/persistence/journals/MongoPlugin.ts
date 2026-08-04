import type { ActorSystem } from '../../ActorSystem.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { mergeLeafOptions } from '../relational/RelationalPlugin.js';
import { MongoDurableStateStore } from '../durable-state-stores/MongoDurableStateStore.js';
import type { MongoDurableStateStoreOptionsType } from '../durable-state-stores/MongoDurableStateStoreOptions.js';
import { MongoSnapshotStore } from '../snapshot-stores/MongoSnapshotStore.js';
import type { MongoSnapshotStoreOptionsType } from '../snapshot-stores/MongoSnapshotStoreOptions.js';
import { MongoJournal } from './MongoJournal.js';
import type { MongoJournalOptionsType } from './MongoJournalOptions.js';
import type { RegisterMongoPluginsOptions, RegisterMongoPluginsOptionsType } from './MongoPluginOptions.js';

/** Canonical plug-in IDs for the MongoDB journal, snapshot, and durable-state stores. */
export const MONGO_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.mongodb';
export const MONGO_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.mongodb';
export const MONGO_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.mongodb';

export type MongoPluginHandles = {
  /**
   * The DurableState store instance.  `PersistenceExtension` carries no
   * DurableState registry (same as every other plugin), so callers who want
   * DurableState read it from the return value and pass it into their
   * `DurableStateActor` options.
   */
  readonly durableStateStore: MongoDurableStateStore;
};

/**
 * One-shot registration of the MongoDB journal + snapshot store against the
 * running `PersistenceExtension`, returning a ready-to-use DurableState store
 * handle.  Mirrors `registerPostgresPlugins` / `registerLibSqlPlugins`.
 *
 * After this call, activate the journal + snapshot store via:
 *   `actor-ts.persistence.journal.plugin = "actor-ts.persistence.journal.mongodb"`
 *   `actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.mongodb"`
 * either via HOCON or a `{ config: { … } }` override.
 *
 * Pass `client` to share one `MongoClient` across all three stores — it is
 * itself a connection pool, so sharing is the normal case.  With a shared client
 * no store owns it, so none closes it: close it yourself when the system shuts
 * down.  Passing `url` instead lets each store build its own client and close it
 * on `close()`.
 */
export function registerMongoPlugins(
  ext: PersistenceExtension,
  options: RegisterMongoPluginsOptions = {},
): MongoPluginHandles {
  const resolvedOptions = (options as RegisterMongoPluginsOptionsType);
  const { client, url, databaseName, clientOptions, serializer } = resolvedOptions;
  // A shared client overrides a leaf's own; shared connection details and the
  // serializer only fill in where the leaf is silent.
  const shared = { client };
  const connection = { url, databaseName, clientOptions, serializer };

  const journal = mergeLeafOptions<Partial<MongoJournalOptionsType>>(resolvedOptions.journal, shared, connection);
  const snapshotStore = mergeLeafOptions<Partial<MongoSnapshotStoreOptionsType>>(resolvedOptions.snapshotStore, shared, connection);
  const durableState = mergeLeafOptions<Partial<MongoDurableStateStoreOptionsType>>(resolvedOptions.durableStateStore, shared, connection);

  ext.registerJournal(
    MONGO_JOURNAL_PLUGIN_ID,
    (_system: ActorSystem) => new MongoJournal(journal),
  );
  ext.registerSnapshotStore(
    MONGO_SNAPSHOT_PLUGIN_ID,
    (_system: ActorSystem) => new MongoSnapshotStore(snapshotStore),
  );
  const durableStateStore = new MongoDurableStateStore(durableState);
  return { durableStateStore };
}
