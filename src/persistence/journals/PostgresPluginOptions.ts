import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { PgPoolLike } from './PostgresClient.js';
import type { PostgresJournalOptions } from './PostgresJournalOptions.js';
import type { PostgresSnapshotStoreOptions } from '../snapshot-stores/PostgresSnapshotStoreOptions.js';
import type { PostgresDurableStateStoreOptions } from '../durable-state-stores/PostgresDurableStateStoreOptions.js';

export interface RegisterPostgresPluginsOptionsType {
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
 * Fluent builder for {@link RegisterPostgresPluginsOptionsType}:
 *
 *     registerPostgresPlugins(ext, RegisterPostgresPluginsOptions.create()
 *       .withPool(pool)
 *       .withJournal(PostgresJournalOptions.create().withEventsTable('journal'))
 *       .withSnapshotStore(PostgresSnapshotStoreOptions.create().withKeepN(5)))
 *
 * The shared `withPool(...)` is merged onto each store's resolved options
 * by {@link registerPostgresPlugins}, so a leaf builder carries only its
 * store-specific fields.  Each leaf setter accepts EITHER the leaf builder
 * OR a plain object of the leaf's options.
 */
export class RegisterPostgresPluginsOptionsBuilder extends OptionsBuilder<RegisterPostgresPluginsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RegisterPostgresPluginsOptionsBuilder()`. */
  static create(): RegisterPostgresPluginsOptionsBuilder {
    return new RegisterPostgresPluginsOptionsBuilder();
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

/**
 * Accepted input for {@link registerPostgresPlugins}: the fluent
 * {@link RegisterPostgresPluginsOptionsBuilder} OR a plain
 * {@link RegisterPostgresPluginsOptionsType} object.
 */
export type RegisterPostgresPluginsOptions =
  | RegisterPostgresPluginsOptionsBuilder
  | Partial<RegisterPostgresPluginsOptionsType>;
/** Value alias so `RegisterPostgresPluginsOptions.create()` / `new RegisterPostgresPluginsOptions()` resolve to the builder. */
export const RegisterPostgresPluginsOptions = RegisterPostgresPluginsOptionsBuilder;
