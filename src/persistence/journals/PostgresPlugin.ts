import type { ActorSystem } from '../../ActorSystem.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { PostgresJournal, type PostgresJournalOptions } from './PostgresJournal.js';
import {
  PostgresSnapshotStore,
  type PostgresSnapshotStoreOptions,
} from '../snapshot-stores/PostgresSnapshotStore.js';
import {
  PostgresDurableStateStore,
  type PostgresDurableStateStoreOptions,
} from '../durable-state-stores/PostgresDurableStateStore.js';
import type { PgPoolLike } from './PostgresClient.js';

/** Canonical plug-in IDs for the Postgres journal, snapshot, and durable-state stores. */
export const POSTGRES_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.postgres';
export const POSTGRES_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.postgres';
export const POSTGRES_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.postgres';

export interface RegisterPostgresPluginsOptions {
  /**
   * Shared connection pool injected into all three stores.  When provided,
   * the journal + snapshot + durable-state stores reuse ONE pool (the
   * usual case — they target the same database).  When omitted, each store
   * lazily builds its own pool from its `url` / `poolConfig`.
   */
  readonly pool?: PgPoolLike;
  /** Journal-specific options (table names, autoCreate, and connection if no shared `pool`). */
  readonly journal: Omit<PostgresJournalOptions, 'pool'>;
  /** Snapshot-store-specific options. */
  readonly snapshotStore: Omit<PostgresSnapshotStoreOptions, 'pool'>;
  /** Durable-state-store-specific options.  Defaults to `{}` (uses the shared `pool`). */
  readonly durableStateStore?: Omit<PostgresDurableStateStoreOptions, 'pool'>;
}

export interface PostgresPluginHandles {
  /**
   * The DurableState store instance.  `PersistenceExtension` carries no
   * DurableState registry (same as the object-storage plugin), so callers
   * who want DurableState read this from the return value and pass it into
   * their `DurableStateActor` settings.
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
  options: RegisterPostgresPluginsOptions,
): PostgresPluginHandles {
  ext.registerJournal(
    POSTGRES_JOURNAL_PLUGIN_ID,
    (_system: ActorSystem) => new PostgresJournal({ ...options.journal, pool: options.pool }),
  );
  ext.registerSnapshotStore(
    POSTGRES_SNAPSHOT_PLUGIN_ID,
    (_system: ActorSystem) => new PostgresSnapshotStore({ ...options.snapshotStore, pool: options.pool }),
  );
  const durableStateStore = new PostgresDurableStateStore({
    ...(options.durableStateStore ?? {}),
    pool: options.pool,
  });
  return { durableStateStore };
}
