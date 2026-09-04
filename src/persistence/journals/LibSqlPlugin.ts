import type { ActorSystem } from '../../ActorSystem.js';
import { Lazy } from '../../util/Lazy.js';
import { mergeOptions } from '../../util/OptionsMerge.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { mergeLeafOptions } from '../relational/RelationalPlugin.js';
import { LibSqlDurableStateStore } from '../durable-state-stores/LibSqlDurableStateStore.js';
import type { LibSqlDurableStateStoreOptionsType } from '../durable-state-stores/LibSqlDurableStateStoreOptions.js';
import { LibSqlSnapshotStore } from '../snapshot-stores/LibSqlSnapshotStore.js';
import type { LibSqlSnapshotStoreOptionsType } from '../snapshot-stores/LibSqlSnapshotStoreOptions.js';
import { LibSqlJournal } from './LibSqlJournal.js';
import type { LibSqlJournalOptionsType } from './LibSqlJournalOptions.js';
import {
  readLibSqlDurableStateStoreOptionsFromConfig,
  readLibSqlJournalOptionsFromConfig,
  readLibSqlSnapshotStoreOptionsFromConfig,
} from './LibSqlPluginOptions.js';
import type { RegisterLibSqlPluginsOptions, RegisterLibSqlPluginsOptionsType } from './LibSqlPluginOptions.js';

/** Canonical plug-in IDs for the libSQL journal, snapshot, and durable-state stores. */
export const LIBSQL_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.libsql';
export const LIBSQL_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.libsql';
export const LIBSQL_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.libsql';

export type LibSqlPluginHandles = {
  /**
   * The DurableState store instance, for a caller that wires
   * `DurableStateOptions.store` by hand rather than selecting the store with
   * `actor-ts.persistence.durable-state.plugin`.  A getter, built on first
   * read — see `PostgresPluginHandles` for why (#872).
   */
  readonly durableStateStore: LibSqlDurableStateStore;
};

/**
 * One-shot registration of the libSQL journal, snapshot store and durable-state
 * store against the running `PersistenceExtension`.  Mirrors
 * `registerPostgresPlugins` / `registerMariaDbPlugins`.
 *
 * After this call, activate the stores via:
 *   `actor-ts.persistence.journal.plugin        = "actor-ts.persistence.journal.libsql"`
 *   `actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.libsql"`
 *   `actor-ts.persistence.durable-state.plugin  = "actor-ts.persistence.durable-state.libsql"`
 * either via HOCON or a `{ config: { … } }` override.
 *
 * `url`, `auth-token`, the table names and `auto-create-tables` all have leaves
 * under those three blocks (#872), so `registerLibSqlPlugins(ext)` with no
 * options is a complete wiring when `application.conf` fills them in — put the
 * token in the environment and substitute it (`auth-token = ${?TURSO_AUTH_TOKEN}`).
 *
 * Pass `client` to share one libSQL client across all three stores — a libSQL
 * client is itself a connection pool, so sharing it is the normal case.  With a
 * shared client no store owns it, so none closes it: close it yourself when the
 * system shuts down.  Passing `url` / `authToken` instead lets each store build
 * its own client and close it on `close()`.
 */
export function registerLibSqlPlugins(
  ext: PersistenceExtension,
  options: RegisterLibSqlPluginsOptions = {},
): LibSqlPluginHandles {
  const resolvedOptions = (options as RegisterLibSqlPluginsOptionsType);
  const { client, url, authToken, serializer } = resolvedOptions;
  // A shared client overrides a leaf's own; a shared url / token / serializer
  // only fills in where the leaf is silent.
  const shared = { client };
  const connection = { url, authToken, serializer };

  const journal = mergeLeafOptions<Partial<LibSqlJournalOptionsType>>(resolvedOptions.journal, shared, connection);
  const snapshotStore = mergeLeafOptions<Partial<LibSqlSnapshotStoreOptionsType>>(resolvedOptions.snapshotStore, shared, connection);
  const durableState = mergeLeafOptions<Partial<LibSqlDurableStateStoreOptionsType>>(resolvedOptions.durableStateStore, shared, connection);

  ext.registerJournal(
    LIBSQL_JOURNAL_PLUGIN_ID,
    (system: ActorSystem) => new LibSqlJournal(mergeOptions<LibSqlJournalOptionsType>(
      {},
      readLibSqlJournalOptionsFromConfig(system.config, LIBSQL_JOURNAL_PLUGIN_ID),
      journal,
    )),
  );
  ext.registerSnapshotStore(
    LIBSQL_SNAPSHOT_PLUGIN_ID,
    (system: ActorSystem) => new LibSqlSnapshotStore(mergeOptions<LibSqlSnapshotStoreOptionsType>(
      {},
      readLibSqlSnapshotStoreOptionsFromConfig(system.config, LIBSQL_SNAPSHOT_PLUGIN_ID),
      snapshotStore,
    )),
  );
  const durableStateStoreLazy = Lazy.of(() => new LibSqlDurableStateStore(
    mergeOptions<LibSqlDurableStateStoreOptionsType>(
      {},
      readLibSqlDurableStateStoreOptionsFromConfig(ext.config, LIBSQL_DURABLE_STATE_PLUGIN_ID),
      durableState,
    ),
  ));
  ext.registerDurableStateStore(LIBSQL_DURABLE_STATE_PLUGIN_ID, () => durableStateStoreLazy.get());
  return { get durableStateStore(): LibSqlDurableStateStore { return durableStateStoreLazy.get(); } };
}
