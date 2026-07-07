import type { ActorSystem } from '../../ActorSystem.js';
import { resolveSettings } from '../../util/OptionsBuilder.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { PostgresJournal } from './PostgresJournal.js';
import type { PostgresJournalOptions } from './PostgresJournalOptions.js';
import type { PostgresJournalSettings } from './PostgresJournal.js';
import { PostgresSnapshotStore } from '../snapshot-stores/PostgresSnapshotStore.js';
import type { PostgresSnapshotStoreOptions } from '../snapshot-stores/PostgresSnapshotStoreOptions.js';
import type { PostgresSnapshotStoreSettings } from '../snapshot-stores/PostgresSnapshotStore.js';
import { PostgresDurableStateStore } from '../durable-state-stores/PostgresDurableStateStore.js';
import type { PostgresDurableStateStoreOptions } from '../durable-state-stores/PostgresDurableStateStoreOptions.js';
import type { PostgresDurableStateStoreSettings } from '../durable-state-stores/PostgresDurableStateStore.js';
import type { PgPoolLike } from './PostgresClient.js';
import type { RegisterPostgresPluginsOptions } from './PostgresPluginOptions.js';

/** Canonical plug-in IDs for the Postgres journal, snapshot, and durable-state stores. */
export const POSTGRES_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.postgres';
export const POSTGRES_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.postgres';
export const POSTGRES_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.postgres';

export interface RegisterPostgresPluginsSettings {
  /**
   * Shared connection pool injected into all three stores.  When provided,
   * the journal + snapshot + durable-state stores reuse ONE pool (the
   * usual case — they target the same database).  When omitted, each store
   * lazily builds its own pool from its `url` / `poolConfig`.
   */
  readonly pool?: PgPoolLike;
  /** Journal-specific options (table names, autoCreate, and connection if no shared `pool`). */
  readonly journal?: PostgresJournalOptions | Partial<PostgresJournalSettings>;
  /** Snapshot-store-specific options. */
  readonly snapshotStore?: PostgresSnapshotStoreOptions | Partial<PostgresSnapshotStoreSettings>;
  /** Durable-state-store-specific options.  Defaults to a fresh builder (uses the shared `pool`). */
  readonly durableStateStore?: PostgresDurableStateStoreOptions | Partial<PostgresDurableStateStoreSettings>;
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
  options: RegisterPostgresPluginsOptions | Partial<RegisterPostgresPluginsSettings> = {},
): PostgresPluginHandles {
  const s = resolveSettings(options);

  // Resolve each leaf to a plain object and merge the shared pool (when
  // set) onto it — no more mutating nested builders.  A missing leaf falls
  // back to an empty object so the shared pool still reaches every store.
  const journal = { ...resolveSettings(s.journal ?? {}), ...(s.pool ? { pool: s.pool } : {}) };
  const snapshotStore = { ...resolveSettings(s.snapshotStore ?? {}), ...(s.pool ? { pool: s.pool } : {}) };
  const durableState = { ...resolveSettings(s.durableStateStore ?? {}), ...(s.pool ? { pool: s.pool } : {}) };

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
