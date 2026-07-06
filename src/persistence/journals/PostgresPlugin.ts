import type { ActorSystem } from '../../ActorSystem.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { PostgresJournal, PostgresJournalOptions } from './PostgresJournal.js';
import {
  PostgresSnapshotStore,
  PostgresSnapshotStoreOptions,
} from '../snapshot-stores/PostgresSnapshotStore.js';
import {
  PostgresDurableStateStore,
  PostgresDurableStateStoreOptions,
} from '../durable-state-stores/PostgresDurableStateStore.js';
import type { PgPoolLike } from './PostgresClient.js';

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
  readonly journal?: PostgresJournalOptions;
  /** Snapshot-store-specific options. */
  readonly snapshotStore?: PostgresSnapshotStoreOptions;
  /** Durable-state-store-specific options.  Defaults to a fresh builder (uses the shared `pool`). */
  readonly durableStateStore?: PostgresDurableStateStoreOptions;
}

/**
 * Fluent builder for {@link RegisterPostgresPluginsSettings}:
 *
 *     registerPostgresPlugins(ext, RegisterPostgresPluginsOptions.create()
 *       .withPool(pool)
 *       .withJournal(PostgresJournalOptions.create().withEventsTable('journal'))
 *       .withSnapshotStore(PostgresSnapshotStoreOptions.create().withKeepN(5)))
 *
 * The shared `withPool(...)` is threaded onto each store's builder by
 * {@link registerPostgresPlugins}, so leaf builders carry only their
 * store-specific fields.
 */
export class RegisterPostgresPluginsOptions extends OptionsBuilder<RegisterPostgresPluginsSettings> {
  /** Start a fresh builder.  Equivalent to `new RegisterPostgresPluginsOptions()`. */
  static create(): RegisterPostgresPluginsOptions {
    return new RegisterPostgresPluginsOptions();
  }

  /** Shared connection pool injected into all three stores. */
  withPool(pool: PgPoolLike): this {
    return this.set('pool', pool);
  }

  /** Journal-specific options (table names, autoCreate, and connection if no shared pool). */
  withJournal(journal: PostgresJournalOptions): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store-specific options. */
  withSnapshotStore(snapshotStore: PostgresSnapshotStoreOptions): this {
    return this.set('snapshotStore', snapshotStore);
  }

  /** Durable-state-store-specific options.  Defaults to a fresh builder (uses the shared pool). */
  withDurableStateStore(durableStateStore: PostgresDurableStateStoreOptions): this {
    return this.set('durableStateStore', durableStateStore);
  }
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
  options: RegisterPostgresPluginsOptions = RegisterPostgresPluginsOptions.create(),
): PostgresPluginHandles {
  const s = options.build();

  // Thread the shared pool onto each store's builder (fresh if the caller
  // didn't supply one).  Builders are mutable, so mutate-then-construct.
  const journal = s.journal ?? PostgresJournalOptions.create();
  const snapshotStore = s.snapshotStore ?? PostgresSnapshotStoreOptions.create();
  const durableState = s.durableStateStore ?? PostgresDurableStateStoreOptions.create();
  if (s.pool) {
    journal.withPool(s.pool);
    snapshotStore.withPool(s.pool);
    durableState.withPool(s.pool);
  }

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
