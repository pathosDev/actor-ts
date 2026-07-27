import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { MsSqlPoolLike } from './MsSqlClient.js';
import type { MsSqlJournalOptions } from './MsSqlJournalOptions.js';
import type { MsSqlSnapshotStoreOptions } from '../snapshot-stores/MsSqlSnapshotStoreOptions.js';
import type { MsSqlDurableStateStoreOptions } from '../durable-state-stores/MsSqlDurableStateStoreOptions.js';

export interface RegisterMsSqlPluginsOptionsType {
  /**
   * Shared connection pool injected into all three stores.  When provided, the
   * journal + snapshot + durable-state stores reuse ONE pool (the usual case —
   * they target the same database).  When omitted, each store lazily builds its
   * own pool from its `url` / `poolConfig`.
   */
  readonly pool?: MsSqlPoolLike;
  /** Connection string applied to every store that does not set its own. */
  readonly url?: string;
  /** `mssql` config object applied to every store that does not set its own. */
  readonly poolConfig?: Record<string, unknown>;
  /** Journal-specific options (table names, autoCreate). */
  readonly journal?: MsSqlJournalOptions;
  /** Snapshot-store-specific options (table name, keepN). */
  readonly snapshotStore?: MsSqlSnapshotStoreOptions;
  /** Durable-state-store-specific options (table name). */
  readonly durableStateStore?: MsSqlDurableStateStoreOptions;
}

/**
 * Fluent builder for {@link RegisterMsSqlPluginsOptionsType}:
 *
 *     const pluginOptions = RegisterMsSqlPluginsOptions.create()
 *       .withPoolConfig({ server: 'localhost', database: 'app', user: 'sa', password: '…' })
 *       .withSnapshotStore(MsSqlSnapshotStoreOptions.create().withKeepN(5));
 *     const handles = registerMsSqlPlugins(persistence, pluginOptions);
 *
 * The shared connection fields are merged onto each store's options by
 * `registerMsSqlPlugins`, so a leaf carries only its store-specific fields.
 * Each leaf setter accepts EITHER the leaf builder OR a plain object.
 */
export class RegisterMsSqlPluginsOptionsBuilder extends OptionsBuilder<RegisterMsSqlPluginsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RegisterMsSqlPluginsOptionsBuilder()`. */
  static create(): RegisterMsSqlPluginsOptionsBuilder {
    return new RegisterMsSqlPluginsOptionsBuilder();
  }

  /** Shared connection pool injected into all three stores. */
  withPool(pool: MsSqlPoolLike): this {
    return this.set('pool', pool);
  }

  /** Connection string applied to every store that does not set its own. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** `mssql` config object applied to every store that does not set its own. */
  withPoolConfig(poolConfig: Record<string, unknown>): this {
    return this.set('poolConfig', poolConfig);
  }

  /** Journal-specific options (table names, autoCreate). */
  withJournal(journal: MsSqlJournalOptions): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store-specific options (table name, keepN). */
  withSnapshotStore(snapshotStore: MsSqlSnapshotStoreOptions): this {
    return this.set('snapshotStore', snapshotStore);
  }

  /** Durable-state-store-specific options (table name). */
  withDurableStateStore(durableStateStore: MsSqlDurableStateStoreOptions): this {
    return this.set('durableStateStore', durableStateStore);
  }
}

/**
 * Accepted input for `registerMsSqlPlugins`: the fluent
 * {@link RegisterMsSqlPluginsOptionsBuilder} OR a plain
 * {@link RegisterMsSqlPluginsOptionsType} object.
 */
export type RegisterMsSqlPluginsOptions =
  | RegisterMsSqlPluginsOptionsBuilder
  | Partial<RegisterMsSqlPluginsOptionsType>;
/** Value alias so `RegisterMsSqlPluginsOptions.create()` resolves to the builder. */
export const RegisterMsSqlPluginsOptions = RegisterMsSqlPluginsOptionsBuilder;
