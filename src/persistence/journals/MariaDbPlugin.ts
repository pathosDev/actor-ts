import type { ActorSystem } from '../../ActorSystem.js';
import { Lazy } from '../../util/Lazy.js';
import { mergeOptions } from '../../util/OptionsMerge.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { mergeLeafOptions } from '../relational/RelationalPlugin.js';
import { MariaDbJournal } from './MariaDbJournal.js';
import type { MariaDbJournalOptionsType } from './MariaDbJournalOptions.js';
import { MariaDbSnapshotStore } from '../snapshot-stores/MariaDbSnapshotStore.js';
import type { MariaDbSnapshotStoreOptionsType } from '../snapshot-stores/MariaDbSnapshotStoreOptions.js';
import { MariaDbDurableStateStore } from '../durable-state-stores/MariaDbDurableStateStore.js';
import type { MariaDbDurableStateStoreOptionsType } from '../durable-state-stores/MariaDbDurableStateStoreOptions.js';
import {
  readMariaDbDurableStateStoreOptionsFromConfig,
  readMariaDbJournalOptionsFromConfig,
  readMariaDbSnapshotStoreOptionsFromConfig,
} from './MariaDbPluginOptions.js';
import type { RegisterMariaDbPluginsOptions, RegisterMariaDbPluginsOptionsType } from './MariaDbPluginOptions.js';

/** Canonical plug-in IDs for the MariaDB journal, snapshot, and durable-state stores. */
export const MARIADB_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.mariadb';
export const MARIADB_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.mariadb';
export const MARIADB_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.mariadb';

export type MariaDbPluginHandles = {
  /**
   * The DurableState store instance, for a caller that wires
   * `DurableStateOptions.store` by hand rather than selecting the store with
   * `actor-ts.persistence.durable-state.plugin`.  A getter, built on first
   * read — see `PostgresPluginHandles` for why (#872).
   */
  readonly durableStateStore: MariaDbDurableStateStore;
};

/**
 * One-shot registration of the MariaDB journal, snapshot store and
 * durable-state store against the running `PersistenceExtension`.  Mirrors
 * `registerPostgresPlugins`.
 *
 * After this call, activate the stores via:
 *   `actor-ts.persistence.journal.plugin        = "actor-ts.persistence.journal.mariadb"`
 *   `actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.mariadb"`
 *   `actor-ts.persistence.durable-state.plugin  = "actor-ts.persistence.durable-state.mariadb"`
 *
 * `url`, the table names and `auto-create-tables` all have leaves under those
 * three blocks (#872), so `registerMariaDbPlugins(ext)` with no options is a
 * complete wiring when `application.conf` fills them in.  Explicit options win
 * over the block, per field.
 */
export function registerMariaDbPlugins(
  ext: PersistenceExtension,
  options: RegisterMariaDbPluginsOptions = {},
): MariaDbPluginHandles {
  const resolvedOptions = (options as RegisterMariaDbPluginsOptionsType);
  const { pool, serializer } = resolvedOptions;
  const journal = mergeLeafOptions<Partial<MariaDbJournalOptionsType>>(resolvedOptions.journal, { pool }, { serializer });
  const snapshotStore = mergeLeafOptions<Partial<MariaDbSnapshotStoreOptionsType>>(resolvedOptions.snapshotStore, { pool }, { serializer });
  const durableState = mergeLeafOptions<Partial<MariaDbDurableStateStoreOptionsType>>(resolvedOptions.durableStateStore, { pool }, { serializer });

  ext.registerJournal(
    MARIADB_JOURNAL_PLUGIN_ID,
    (system: ActorSystem) => new MariaDbJournal(mergeOptions<MariaDbJournalOptionsType>(
      {},
      readMariaDbJournalOptionsFromConfig(system.config, MARIADB_JOURNAL_PLUGIN_ID),
      journal,
    )),
  );
  ext.registerSnapshotStore(
    MARIADB_SNAPSHOT_PLUGIN_ID,
    (system: ActorSystem) => new MariaDbSnapshotStore(mergeOptions<MariaDbSnapshotStoreOptionsType>(
      {},
      readMariaDbSnapshotStoreOptionsFromConfig(system.config, MARIADB_SNAPSHOT_PLUGIN_ID),
      snapshotStore,
    )),
  );
  const durableStateStoreLazy = Lazy.of(() => new MariaDbDurableStateStore(
    mergeOptions<MariaDbDurableStateStoreOptionsType>(
      {},
      readMariaDbDurableStateStoreOptionsFromConfig(ext.config, MARIADB_DURABLE_STATE_PLUGIN_ID),
      durableState,
    ),
  ));
  ext.registerDurableStateStore(MARIADB_DURABLE_STATE_PLUGIN_ID, () => durableStateStoreLazy.get());
  return { get durableStateStore(): MariaDbDurableStateStore { return durableStateStoreLazy.get(); } };
}
