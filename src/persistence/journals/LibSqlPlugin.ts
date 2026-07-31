import type { ActorSystem } from '../../ActorSystem.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { mergeLeafOptions } from '../relational/RelationalPlugin.js';
import { LibSqlDurableStateStore } from '../durable-state-stores/LibSqlDurableStateStore.js';
import type { LibSqlDurableStateStoreOptionsType } from '../durable-state-stores/LibSqlDurableStateStoreOptions.js';
import { LibSqlSnapshotStore } from '../snapshot-stores/LibSqlSnapshotStore.js';
import type { LibSqlSnapshotStoreOptionsType } from '../snapshot-stores/LibSqlSnapshotStoreOptions.js';
import { LibSqlJournal } from './LibSqlJournal.js';
import type { LibSqlJournalOptionsType } from './LibSqlJournalOptions.js';
import type { RegisterLibSqlPluginsOptions, RegisterLibSqlPluginsOptionsType } from './LibSqlPluginOptions.js';

/** Canonical plug-in IDs for the libSQL journal, snapshot, and durable-state stores. */
export const LIBSQL_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.libsql';
export const LIBSQL_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.libsql';
export const LIBSQL_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.libsql';

export type LibSqlPluginHandles = {
  /**
   * The DurableState store instance.  `PersistenceExtension` carries no
   * DurableState registry (same as the Postgres, MariaDB and object-storage
   * plugins), so callers who want DurableState read it from the return value
   * and pass it into their `DurableStateActor` options.
   */
  readonly durableStateStore: LibSqlDurableStateStore;
};

/**
 * One-shot registration of the libSQL journal + snapshot store against the
 * running `PersistenceExtension`, returning a ready-to-use DurableState store
 * handle.  Mirrors `registerPostgresPlugins` / `registerMariaDbPlugins`.
 *
 * After this call, activate the journal + snapshot store via:
 *   `actor-ts.persistence.journal.plugin = "actor-ts.persistence.journal.libsql"`
 *   `actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.libsql"`
 * either via HOCON or a `{ config: { … } }` override.
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
  const { client, url, authToken } = resolvedOptions;
  // A shared client overrides a leaf's own; a shared url / token only fills in
  // where the leaf is silent.
  const shared = { client };
  const connection = { url, authToken };

  const journal = mergeLeafOptions<Partial<LibSqlJournalOptionsType>>(resolvedOptions.journal, shared, connection);
  const snapshotStore = mergeLeafOptions<Partial<LibSqlSnapshotStoreOptionsType>>(resolvedOptions.snapshotStore, shared, connection);
  const durableState = mergeLeafOptions<Partial<LibSqlDurableStateStoreOptionsType>>(resolvedOptions.durableStateStore, shared, connection);

  ext.registerJournal(
    LIBSQL_JOURNAL_PLUGIN_ID,
    (_system: ActorSystem) => new LibSqlJournal(journal),
  );
  ext.registerSnapshotStore(
    LIBSQL_SNAPSHOT_PLUGIN_ID,
    (_system: ActorSystem) => new LibSqlSnapshotStore(snapshotStore),
  );
  const durableStateStore = new LibSqlDurableStateStore(durableState);
  return { durableStateStore };
}
