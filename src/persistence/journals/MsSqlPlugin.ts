import type { ActorSystem } from '../../ActorSystem.js';
import { Lazy } from '../../util/Lazy.js';
import { mergeOptions } from '../../util/OptionsMerge.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { mergeLeafOptions } from '../relational/RelationalPlugin.js';
import { MsSqlDurableStateStore } from '../durable-state-stores/MsSqlDurableStateStore.js';
import type { MsSqlDurableStateStoreOptionsType } from '../durable-state-stores/MsSqlDurableStateStoreOptions.js';
import { MsSqlSnapshotStore } from '../snapshot-stores/MsSqlSnapshotStore.js';
import type { MsSqlSnapshotStoreOptionsType } from '../snapshot-stores/MsSqlSnapshotStoreOptions.js';
import { MsSqlJournal } from './MsSqlJournal.js';
import type { MsSqlJournalOptionsType } from './MsSqlJournalOptions.js';
import {
  readMsSqlDurableStateStoreOptionsFromConfig,
  readMsSqlJournalOptionsFromConfig,
  readMsSqlSnapshotStoreOptionsFromConfig,
} from './MsSqlPluginOptions.js';
import type { RegisterMsSqlPluginsOptions, RegisterMsSqlPluginsOptionsType } from './MsSqlPluginOptions.js';

/** Canonical plug-in IDs for the SQL Server journal, snapshot, and durable-state stores. */
export const MSSQL_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.mssql';
export const MSSQL_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.mssql';
export const MSSQL_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.mssql';

export type MsSqlPluginHandles = {
  /**
   * The DurableState store instance, for a caller that wires
   * `DurableStateOptions.store` by hand rather than selecting the store with
   * `actor-ts.persistence.durable-state.plugin`.  A getter, built on first
   * read — see `PostgresPluginHandles` for why (#872).
   */
  readonly durableStateStore: MsSqlDurableStateStore;
};

/**
 * One-shot registration of the SQL Server journal, snapshot store and
 * durable-state store against the running `PersistenceExtension`.  Mirrors
 * `registerPostgresPlugins` / `registerMariaDbPlugins`.
 *
 * After this call, activate the stores via:
 *   `actor-ts.persistence.journal.plugin        = "actor-ts.persistence.journal.mssql"`
 *   `actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.mssql"`
 *   `actor-ts.persistence.durable-state.plugin  = "actor-ts.persistence.durable-state.mssql"`
 * either via HOCON or a `{ config: { … } }` override.
 *
 * `url`, the table names and `auto-create-tables` all have leaves under those
 * three blocks (#872).  `poolConfig` deliberately does not — it is a free-form
 * driver config with no enumerable leaf set — so a purely config-driven SQL
 * Server store is reached through `url`, in either the `Server=…;Database=…`
 * or the `mssql://` form.
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
  const { pool, url, poolConfig, serializer } = resolvedOptions;
  // A shared pool overrides a leaf's own; a shared url / poolConfig /
  // serializer only fills in where the leaf is silent.
  const shared = { pool };
  const connection = { url, poolConfig, serializer };

  const journal = mergeLeafOptions<Partial<MsSqlJournalOptionsType>>(resolvedOptions.journal, shared, connection);
  const snapshotStore = mergeLeafOptions<Partial<MsSqlSnapshotStoreOptionsType>>(resolvedOptions.snapshotStore, shared, connection);
  const durableState = mergeLeafOptions<Partial<MsSqlDurableStateStoreOptionsType>>(resolvedOptions.durableStateStore, shared, connection);

  ext.registerJournal(
    MSSQL_JOURNAL_PLUGIN_ID,
    (system: ActorSystem) => new MsSqlJournal(mergeOptions<MsSqlJournalOptionsType>(
      {},
      readMsSqlJournalOptionsFromConfig(system.config, MSSQL_JOURNAL_PLUGIN_ID),
      journal,
    )),
  );
  ext.registerSnapshotStore(
    MSSQL_SNAPSHOT_PLUGIN_ID,
    (system: ActorSystem) => new MsSqlSnapshotStore(mergeOptions<MsSqlSnapshotStoreOptionsType>(
      {},
      readMsSqlSnapshotStoreOptionsFromConfig(system.config, MSSQL_SNAPSHOT_PLUGIN_ID),
      snapshotStore,
    )),
  );
  const durableStateStoreLazy = Lazy.of(() => new MsSqlDurableStateStore(
    mergeOptions<MsSqlDurableStateStoreOptionsType>(
      {},
      readMsSqlDurableStateStoreOptionsFromConfig(ext.config, MSSQL_DURABLE_STATE_PLUGIN_ID),
      durableState,
    ),
  ));
  ext.registerDurableStateStore(MSSQL_DURABLE_STATE_PLUGIN_ID, () => durableStateStoreLazy.get());
  return { get durableStateStore(): MsSqlDurableStateStore { return durableStateStoreLazy.get(); } };
}
