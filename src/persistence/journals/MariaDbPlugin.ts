import type { ActorSystem } from '../../ActorSystem.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { MariaDbJournal } from './MariaDbJournal.js';
import type { MariaDbJournalOptionsType } from './MariaDbJournalOptions.js';
import { MariaDbSnapshotStore } from '../snapshot-stores/MariaDbSnapshotStore.js';
import type { MariaDbSnapshotStoreOptionsType } from '../snapshot-stores/MariaDbSnapshotStoreOptions.js';
import { MariaDbDurableStateStore } from '../durable-state-stores/MariaDbDurableStateStore.js';
import type { MariaDbDurableStateStoreOptionsType } from '../durable-state-stores/MariaDbDurableStateStoreOptions.js';
import type { RegisterMariaDbPluginsOptions, RegisterMariaDbPluginsOptionsType } from './MariaDbPluginOptions.js';

/** Canonical plug-in IDs for the MariaDB journal, snapshot, and durable-state stores. */
export const MARIADB_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.mariadb';
export const MARIADB_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.mariadb';
export const MARIADB_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.mariadb';

export interface MariaDbPluginHandles {
  /**
   * The DurableState store instance.  `PersistenceExtension` carries no
   * DurableState registry (same as the object-storage / Postgres plugins),
   * so callers who want DurableState read this from the return value and
   * pass it into their `DurableStateActor` options.
   */
  readonly durableStateStore: MariaDbDurableStateStore;
}

/**
 * One-shot registration of the MariaDB journal + snapshot store against the
 * running `PersistenceExtension`, returning a ready-to-use DurableState
 * store handle.  Mirrors `registerPostgresPlugins`.
 *
 * After this call, activate via:
 *   `actor-ts.persistence.journal.plugin = "actor-ts.persistence.journal.mariadb"`
 *   `actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.mariadb"`
 */
export function registerMariaDbPlugins(
  ext: PersistenceExtension,
  options: RegisterMariaDbPluginsOptions,
): MariaDbPluginHandles {
  const s = (options as RegisterMariaDbPluginsOptionsType);
  // Resolve each leaf to a plain object and merge the shared pool (when set)
  // onto it.  A missing leaf falls back to an empty object so the shared
  // pool still reaches every store.
  const journal = { ...((s.journal ?? {}) as Partial<MariaDbJournalOptionsType>), ...(s.pool ? { pool: s.pool } : {}) };
  const snapshotStore = { ...((s.snapshotStore ?? {}) as Partial<MariaDbSnapshotStoreOptionsType>), ...(s.pool ? { pool: s.pool } : {}) };
  const durableState = { ...((s.durableStateStore ?? {}) as Partial<MariaDbDurableStateStoreOptionsType>), ...(s.pool ? { pool: s.pool } : {}) };
  ext.registerJournal(
    MARIADB_JOURNAL_PLUGIN_ID,
    (_system: ActorSystem) => new MariaDbJournal(journal),
  );
  ext.registerSnapshotStore(
    MARIADB_SNAPSHOT_PLUGIN_ID,
    (_system: ActorSystem) => new MariaDbSnapshotStore(snapshotStore),
  );
  const durableStateStore = new MariaDbDurableStateStore(durableState);
  return { durableStateStore };
}
