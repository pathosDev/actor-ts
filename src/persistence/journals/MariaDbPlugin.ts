import type { ActorSystem } from '../../ActorSystem.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { MariaDbJournal, MariaDbJournalOptions } from './MariaDbJournal.js';
import {
  MariaDbSnapshotStore,
  MariaDbSnapshotStoreOptions,
} from '../snapshot-stores/MariaDbSnapshotStore.js';
import {
  MariaDbDurableStateStore,
  MariaDbDurableStateStoreOptions,
} from '../durable-state-stores/MariaDbDurableStateStore.js';
import type { MariaDbPoolLike } from './MariaDbClient.js';

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
  readonly journal?: MariaDbJournalOptions;
  /** Snapshot-store builder — its `pool` is overridden by the shared `pool` when set. */
  readonly snapshotStore?: MariaDbSnapshotStoreOptions;
  /** Durable-state-store builder — its `pool` is overridden by the shared `pool` when set. */
  readonly durableStateStore?: MariaDbDurableStateStoreOptions;
}

/**
 * Fluent builder for {@link RegisterMariaDbPluginsSettings}:
 *
 *     registerMariaDbPlugins(ext, RegisterMariaDbPluginsOptions.create()
 *       .withPool(sharedPool)
 *       .withJournal(MariaDbJournalOptions.create().withEventsTable('journal')))
 *
 * Each per-store field is the store's own leaf builder; the shared `pool`
 * (when set via `withPool`) is threaded onto every store at registration
 * time, so a leaf builder need not repeat the connection.
 */
export class RegisterMariaDbPluginsOptions extends OptionsBuilder<RegisterMariaDbPluginsSettings> {
  /** Start a fresh builder.  Equivalent to `new RegisterMariaDbPluginsOptions()`. */
  static create(): RegisterMariaDbPluginsOptions {
    return new RegisterMariaDbPluginsOptions();
  }

  /** Shared connection pool reused by all three stores (overrides each leaf's own pool). */
  withPool(pool: MariaDbPoolLike): this {
    return this.set('pool', pool);
  }

  /** Journal builder — table names / autoCreate (connection filled from the shared pool). */
  withJournal(journal: MariaDbJournalOptions): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store builder — table name / keepN (connection filled from the shared pool). */
  withSnapshotStore(snapshotStore: MariaDbSnapshotStoreOptions): this {
    return this.set('snapshotStore', snapshotStore);
  }

  /** Durable-state-store builder — table name (connection filled from the shared pool). */
  withDurableStateStore(durableStateStore: MariaDbDurableStateStoreOptions): this {
    return this.set('durableStateStore', durableStateStore);
  }
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
  const s = options.build();
  // Thread the shared pool (when set) onto each leaf builder — builders are
  // mutable, so mutate-then-construct is fine.  A missing leaf builder falls
  // back to a fresh one so the shared pool still reaches every store.
  const journalBuilder = s.journal ?? MariaDbJournalOptions.create();
  const snapshotBuilder = s.snapshotStore ?? MariaDbSnapshotStoreOptions.create();
  const durableBuilder = s.durableStateStore ?? MariaDbDurableStateStoreOptions.create();
  if (s.pool) {
    journalBuilder.withPool(s.pool);
    snapshotBuilder.withPool(s.pool);
    durableBuilder.withPool(s.pool);
  }
  ext.registerJournal(
    MARIADB_JOURNAL_PLUGIN_ID,
    (_system: ActorSystem) => new MariaDbJournal(journalBuilder),
  );
  ext.registerSnapshotStore(
    MARIADB_SNAPSHOT_PLUGIN_ID,
    (_system: ActorSystem) => new MariaDbSnapshotStore(snapshotBuilder),
  );
  const durableStateStore = new MariaDbDurableStateStore(durableBuilder);
  return { durableStateStore };
}
