import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { MariaDbPoolLike } from './MariaDbClient.js';
import type { MariaDbJournalOptions } from './MariaDbJournalOptions.js';
import type { MariaDbSnapshotStoreOptions } from '../snapshot-stores/MariaDbSnapshotStoreOptions.js';
import type { MariaDbDurableStateStoreOptions } from '../durable-state-stores/MariaDbDurableStateStoreOptions.js';

export interface RegisterMariaDbPluginsOptionsType {
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
 * Fluent builder for {@link RegisterMariaDbPluginsOptionsType}:
 *
 *     registerMariaDbPlugins(ext, RegisterMariaDbPluginsOptions.create()
 *       .withPool(sharedPool)
 *       .withJournal(MariaDbJournalOptions.create().withEventsTable('journal')))
 *
 * Each per-store field is the store's own leaf builder (or a plain object
 * of its settings); the shared `pool` (when set via `withPool`) is merged
 * onto every store's resolved settings at registration time, so a leaf
 * need not repeat the connection.
 */
export class RegisterMariaDbPluginsOptionsBuilder extends OptionsBuilder<RegisterMariaDbPluginsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RegisterMariaDbPluginsOptionsBuilder()`. */
  static create(): RegisterMariaDbPluginsOptionsBuilder {
    return new RegisterMariaDbPluginsOptionsBuilder();
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

/**
 * Accepted input for {@link registerMariaDbPlugins}: the fluent
 * {@link RegisterMariaDbPluginsOptionsBuilder} OR a plain
 * {@link RegisterMariaDbPluginsOptionsType} object.
 */
export type RegisterMariaDbPluginsOptions =
  | RegisterMariaDbPluginsOptionsBuilder
  | Partial<RegisterMariaDbPluginsOptionsType>;
/** Value alias so `RegisterMariaDbPluginsOptions.create()` / `new RegisterMariaDbPluginsOptions()` resolve to the builder. */
export const RegisterMariaDbPluginsOptions = RegisterMariaDbPluginsOptionsBuilder;
