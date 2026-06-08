import type { ActorSystem } from '../../ActorSystem.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { MariaDbJournal, type MariaDbJournalOptions } from './MariaDbJournal.js';
import {
  MariaDbSnapshotStore,
  type MariaDbSnapshotStoreOptions,
} from '../snapshot-stores/MariaDbSnapshotStore.js';
import {
  MariaDbDurableStateStore,
  type MariaDbDurableStateStoreOptions,
} from '../durable-state-stores/MariaDbDurableStateStore.js';
import type { MariaDbPoolLike } from './MariaDbClient.js';

/** Canonical plug-in IDs for the MariaDB journal, snapshot, and durable-state stores. */
export const MARIADB_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.mariadb';
export const MARIADB_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.mariadb';
export const MARIADB_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.mariadb';

export interface RegisterMariaDbPluginsOptions {
  /**
   * Shared connection pool injected into all three stores.  When provided,
   * the journal + snapshot + durable-state stores reuse ONE pool.  When
   * omitted, each store lazily builds its own from its `url` / `poolConfig`.
   */
  readonly pool?: MariaDbPoolLike;
  /** Journal-specific options. */
  readonly journal: Omit<MariaDbJournalOptions, 'pool'>;
  /** Snapshot-store-specific options. */
  readonly snapshotStore: Omit<MariaDbSnapshotStoreOptions, 'pool'>;
  /** Durable-state-store-specific options.  Defaults to `{}` (uses the shared `pool`). */
  readonly durableStateStore?: Omit<MariaDbDurableStateStoreOptions, 'pool'>;
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
  options: RegisterMariaDbPluginsOptions,
): MariaDbPluginHandles {
  ext.registerJournal(
    MARIADB_JOURNAL_PLUGIN_ID,
    (_system: ActorSystem) => new MariaDbJournal({ ...options.journal, pool: options.pool }),
  );
  ext.registerSnapshotStore(
    MARIADB_SNAPSHOT_PLUGIN_ID,
    (_system: ActorSystem) => new MariaDbSnapshotStore({ ...options.snapshotStore, pool: options.pool }),
  );
  const durableStateStore = new MariaDbDurableStateStore({
    ...(options.durableStateStore ?? {}),
    pool: options.pool,
  });
  return { durableStateStore };
}
