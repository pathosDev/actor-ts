import type { ActorSystem } from '../../ActorSystem.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { mergeLeafOptions } from '../relational/RelationalPlugin.js';
import { MsSqlDurableStateStore } from '../durable-state-stores/MsSqlDurableStateStore.js';
import type { MsSqlDurableStateStoreOptionsType } from '../durable-state-stores/MsSqlDurableStateStoreOptions.js';
import { MsSqlSnapshotStore } from '../snapshot-stores/MsSqlSnapshotStore.js';
import type { MsSqlSnapshotStoreOptionsType } from '../snapshot-stores/MsSqlSnapshotStoreOptions.js';
import { MsSqlJournal } from './MsSqlJournal.js';
import type { MsSqlJournalOptionsType } from './MsSqlJournalOptions.js';
import type { RegisterMsSqlPluginsOptions, RegisterMsSqlPluginsOptionsType } from './MsSqlPluginOptions.js';

/** Canonical plug-in IDs for the SQL Server journal, snapshot, and durable-state stores. */
export const MSSQL_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.mssql';
export const MSSQL_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.mssql';
export const MSSQL_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.mssql';

export type MsSqlPluginHandles = {
  /**
   * The DurableState store instance.  `PersistenceExtension` carries no
   * DurableState registry (same as the Postgres, MariaDB, libSQL and
   * object-storage plugins), so callers who want DurableState read it from the
   * return value and pass it into their `DurableStateActor` options.
   */
  readonly durableStateStore: MsSqlDurableStateStore;
};

/**
 * One-shot registration of the SQL Server journal + snapshot store against the
 * running `PersistenceExtension`, returning a ready-to-use DurableState store
 * handle.  Mirrors `registerPostgresPlugins` / `registerMariaDbPlugins`.
 *
 * After this call, activate the journal + snapshot store via:
 *   `actor-ts.persistence.journal.plugin = "actor-ts.persistence.journal.mssql"`
 *   `actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.mssql"`
 * either via HOCON or a `{ config: { … } }` override.
 *
 * Pass `pool` to share a single connection pool across all three stores
 * (recommended when they target the same database).  A shared pool is
 * caller-owned: no store ends it, so close it yourself at shutdown.
 */
export function registerMsSqlPlugins(
  ext: PersistenceExtension,
  options: RegisterMsSqlPluginsOptions = {},
): MsSqlPluginHandles {
  const resolvedOptions = (options as RegisterMsSqlPluginsOptionsType);
  const { pool, url, poolConfig } = resolvedOptions;
  // A shared pool overrides a leaf's own; a shared url / poolConfig only fills
  // in where the leaf is silent.
  const shared = { pool };
  const connection = { url, poolConfig };

  const journal = mergeLeafOptions<Partial<MsSqlJournalOptionsType>>(resolvedOptions.journal, shared, connection);
  const snapshotStore = mergeLeafOptions<Partial<MsSqlSnapshotStoreOptionsType>>(resolvedOptions.snapshotStore, shared, connection);
  const durableState = mergeLeafOptions<Partial<MsSqlDurableStateStoreOptionsType>>(resolvedOptions.durableStateStore, shared, connection);

  ext.registerJournal(
    MSSQL_JOURNAL_PLUGIN_ID,
    (_system: ActorSystem) => new MsSqlJournal(journal),
  );
  ext.registerSnapshotStore(
    MSSQL_SNAPSHOT_PLUGIN_ID,
    (_system: ActorSystem) => new MsSqlSnapshotStore(snapshotStore),
  );
  const durableStateStore = new MsSqlDurableStateStore(durableState);
  return { durableStateStore };
}
