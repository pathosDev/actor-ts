import type { ActorSystem } from '../../ActorSystem.js';
import { Lazy } from '../../util/Lazy.js';
import { mergeOptions } from '../../util/OptionsMerge.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { mergeLeafOptions } from '../relational/RelationalPlugin.js';
import { MongoDurableStateStore } from '../durable-state-stores/MongoDurableStateStore.js';
import type { MongoDurableStateStoreOptionsType } from '../durable-state-stores/MongoDurableStateStoreOptions.js';
import { MongoSnapshotStore } from '../snapshot-stores/MongoSnapshotStore.js';
import type { MongoSnapshotStoreOptionsType } from '../snapshot-stores/MongoSnapshotStoreOptions.js';
import { MongoJournal } from './MongoJournal.js';
import type { MongoJournalOptionsType } from './MongoJournalOptions.js';
import {
  readMongoDurableStateStoreOptionsFromConfig,
  readMongoJournalOptionsFromConfig,
  readMongoSnapshotStoreOptionsFromConfig,
} from './MongoPluginOptions.js';
import type { RegisterMongoPluginsOptions, RegisterMongoPluginsOptionsType } from './MongoPluginOptions.js';

/** Canonical plug-in IDs for the MongoDB journal, snapshot, and durable-state stores. */
export const MONGO_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.mongodb';
export const MONGO_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.mongodb';
export const MONGO_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.mongodb';

export type MongoPluginHandles = {
  /**
   * The DurableState store instance, for a caller that wires
   * `DurableStateOptions.store` by hand rather than selecting the store with
   * `actor-ts.persistence.durable-state.plugin`.
   *
   * A **getter**, and built on first read rather than at registration (#872).
   * The store is a registered factory like the other two now, so it has a
   * block of its own to read — and reading it means waiting until somebody
   * actually asks for a store, which is also when the same instance is handed
   * to `ext.durableStateStore`.  Either route yields the one object; a caller
   * that never touches durable state builds none.
   */
  readonly durableStateStore: MongoDurableStateStore;
};

/**
 * One-shot registration of the MongoDB journal, snapshot store and
 * durable-state store against the running `PersistenceExtension`.  Mirrors
 * `registerPostgresPlugins` / `registerLibSqlPlugins`.
 *
 * After this call, activate the stores via:
 *   `actor-ts.persistence.journal.plugin        = "actor-ts.persistence.journal.mongodb"`
 *   `actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.mongodb"`
 *   `actor-ts.persistence.durable-state.plugin  = "actor-ts.persistence.durable-state.mongodb"`
 * either via HOCON or a `{ config: { … } }` override.
 *
 * **Everything except the live objects can come from configuration** (#872).
 * `url`, the database name, the collection names and `auto-create-indexes` all
 * have leaves under the three blocks named above, so `registerMongoPlugins(ext)`
 * with no options at all is a complete wiring when `application.conf` fills
 * them in.  Precedence is the project-wide one — explicit options > HOCON >
 * built-in defaults, per field, with an unset field falling through rather than
 * shadowing.  The merge happens **inside each registered factory**, because a
 * factory is handed the `ActorSystem` and that is the only route to
 * `system.config`.
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
    (system: ActorSystem) => new MongoJournal(mergeOptions<MongoJournalOptionsType>(
      {},
      readMongoJournalOptionsFromConfig(system.config, MONGO_JOURNAL_PLUGIN_ID),
      journal,
    )),
  );
  ext.registerSnapshotStore(
    MONGO_SNAPSHOT_PLUGIN_ID,
    (system: ActorSystem) => new MongoSnapshotStore(mergeOptions<MongoSnapshotStoreOptionsType>(
      {},
      readMongoSnapshotStoreOptionsFromConfig(system.config, MONGO_SNAPSHOT_PLUGIN_ID),
      snapshotStore,
    )),
  );
  // One instance, whichever way it is reached: the registry's factory and the
  // returned handle both resolve this lazy.  `ext.config` is the same resolved
  // configuration the factory's `system.config` is.
  const durableStateStoreLazy = Lazy.of(() => new MongoDurableStateStore(
    mergeOptions<MongoDurableStateStoreOptionsType>(
      {},
      readMongoDurableStateStoreOptionsFromConfig(ext.config, MONGO_DURABLE_STATE_PLUGIN_ID),
      durableState,
    ),
  ));
  ext.registerDurableStateStore(MONGO_DURABLE_STATE_PLUGIN_ID, () => durableStateStoreLazy.get());
  return { get durableStateStore(): MongoDurableStateStore { return durableStateStoreLazy.get(); } };
}
