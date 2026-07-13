import type { ActorSystem } from '../../ActorSystem.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { PostgresJournal } from './PostgresJournal.js';
import type { PostgresJournalOptionsType } from './PostgresJournalOptions.js';
import { PostgresSnapshotStore } from '../snapshot-stores/PostgresSnapshotStore.js';
import type { PostgresSnapshotStoreOptionsType } from '../snapshot-stores/PostgresSnapshotStoreOptions.js';
import { PostgresDurableStateStore } from '../durable-state-stores/PostgresDurableStateStore.js';
import type { PostgresDurableStateStoreOptionsType } from '../durable-state-stores/PostgresDurableStateStoreOptions.js';
import type { RegisterPostgresPluginsOptions, RegisterPostgresPluginsOptionsType } from './PostgresPluginOptions.js';

/** Canonical plug-in IDs for the Postgres journal, snapshot, and durable-state stores. */
export const POSTGRES_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.postgres';
export const POSTGRES_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.postgres';
export const POSTGRES_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.postgres';

export interface PostgresPluginHandles {
  /**
   * The DurableState store instance.  `PersistenceExtension` carries no
   * DurableState registry (same as the object-storage plugin), so callers
   * who want DurableState read this from the return value and pass it into
   * their `DurableStateActor` options.
   */
  readonly durableStateStore: PostgresDurableStateStore;
}

/**
 * One-shot registration of the Postgres journal + snapshot store against
 * the running `PersistenceExtension`, returning a ready-to-use
 * DurableState store handle.  Mirrors `registerCassandraPlugins` /
 * `registerObjectStoragePlugins`.
 *
 * After this call, activate the journal + snapshot store via:
 *   `actor-ts.persistence.journal.plugin = "actor-ts.persistence.journal.postgres"`
 *   `actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.postgres"`
 * either via HOCON or a `{ config: { ... } }` override.
 *
 * Pass `pool` to share a single connection pool across all three stores
 * (recommended when they target the same DB).
 */
export function registerPostgresPlugins(
  ext: PersistenceExtension,
  options: RegisterPostgresPluginsOptions = {},
): PostgresPluginHandles {
  const resolvedOptions = (options as RegisterPostgresPluginsOptionsType);

  // Resolve each leaf to a plain object and merge the shared pool (when
  // set) onto it — no more mutating nested builders.  A missing leaf falls
  // back to an empty object so the shared pool still reaches every store.
  const journal = { ...((resolvedOptions.journal ?? {}) as Partial<PostgresJournalOptionsType>), ...(resolvedOptions.pool ? { pool: resolvedOptions.pool } : {}) };
  const snapshotStore = { ...((resolvedOptions.snapshotStore ?? {}) as Partial<PostgresSnapshotStoreOptionsType>), ...(resolvedOptions.pool ? { pool: resolvedOptions.pool } : {}) };
  const durableState = { ...((resolvedOptions.durableStateStore ?? {}) as Partial<PostgresDurableStateStoreOptionsType>), ...(resolvedOptions.pool ? { pool: resolvedOptions.pool } : {}) };

  ext.registerJournal(
    POSTGRES_JOURNAL_PLUGIN_ID,
    (_system: ActorSystem) => new PostgresJournal(journal),
  );
  ext.registerSnapshotStore(
    POSTGRES_SNAPSHOT_PLUGIN_ID,
    (_system: ActorSystem) => new PostgresSnapshotStore(snapshotStore),
  );
  const durableStateStore = new PostgresDurableStateStore(durableState);
  return { durableStateStore };
}
