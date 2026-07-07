import type { ActorSystem } from '../../ActorSystem.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { MariaDbJournal } from './MariaDbJournal.js';
import type { MariaDbJournalOptions } from './MariaDbJournalOptions.js';
import type { MariaDbJournalSettings } from './MariaDbJournal.js';
import { MariaDbSnapshotStore } from '../snapshot-stores/MariaDbSnapshotStore.js';
import type { MariaDbSnapshotStoreOptions } from '../snapshot-stores/MariaDbSnapshotStoreOptions.js';
import type { MariaDbSnapshotStoreSettings } from '../snapshot-stores/MariaDbSnapshotStore.js';
import { MariaDbDurableStateStore } from '../durable-state-stores/MariaDbDurableStateStore.js';
import type { MariaDbDurableStateStoreOptions } from '../durable-state-stores/MariaDbDurableStateStoreOptions.js';
import type { MariaDbDurableStateStoreSettings } from '../durable-state-stores/MariaDbDurableStateStore.js';
import type { MariaDbPoolLike } from './MariaDbClient.js';
import type { RegisterMariaDbPluginsOptions } from './MariaDbPluginOptions.js';

/** Canonical plug-in IDs for the MariaDB journal, snapshot, and durable-state stores. */
export const MARIADB_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.mariadb';
export const MARIADB_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.mariadb';
export const MARIADB_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.mariadb';

export interface RegisterMariaDbPluginsSettings {
  /**
   * Shared connection pool injected into all three stores.  When provided,
   * the journal + snapshot + durable-state stores reuse ONE pool.  When
   * omitted, each store lazily builds its own from its `url` / `poolConfig`.
   */
  readonly pool?: MariaDbPoolLike;
  /** Journal builder — its `pool` is overridden by the shared `pool` when set. */
  readonly journal?: MariaDbJournalOptions | Partial<MariaDbJournalSettings>;
  /** Snapshot-store builder — its `pool` is overridden by the shared `pool` when set. */
  readonly snapshotStore?: MariaDbSnapshotStoreOptions | Partial<MariaDbSnapshotStoreSettings>;
  /** Durable-state-store builder — its `pool` is overridden by the shared `pool` when set. */
  readonly durableStateStore?: MariaDbDurableStateStoreOptions | Partial<MariaDbDurableStateStoreSettings>;
}

export interface MariaDbPluginHandles {
  /**
   * The DurableState store instance.  `PersistenceExtension` carries no
   * DurableState registry (same as the object-storage / Postgres plugins),
   * so callers who want DurableState read this from the return value and
   * pass it into their `DurableStateActor` settings.
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
  options: RegisterMariaDbPluginsOptions | Partial<RegisterMariaDbPluginsSettings>,
): MariaDbPluginHandles {
  const s = (options as Partial<RegisterMariaDbPluginsSettings>);
  // Resolve each leaf to a plain object and merge the shared pool (when set)
  // onto it.  A missing leaf falls back to an empty object so the shared
  // pool still reaches every store.
  const journal = { ...((s.journal ?? {}) as Partial<MariaDbJournalSettings>), ...(s.pool ? { pool: s.pool } : {}) };
  const snapshotStore = { ...((s.snapshotStore ?? {}) as Partial<MariaDbSnapshotStoreSettings>), ...(s.pool ? { pool: s.pool } : {}) };
  const durableState = { ...((s.durableStateStore ?? {}) as Partial<MariaDbDurableStateStoreSettings>), ...(s.pool ? { pool: s.pool } : {}) };
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
