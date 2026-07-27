import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { LibSqlClientLike } from './LibSqlClient.js';
import type { LibSqlJournalOptions } from './LibSqlJournalOptions.js';
import type { LibSqlSnapshotStoreOptions } from '../snapshot-stores/LibSqlSnapshotStoreOptions.js';
import type { LibSqlDurableStateStoreOptions } from '../durable-state-stores/LibSqlDurableStateStoreOptions.js';

export interface RegisterLibSqlPluginsOptionsType {
  /**
   * Shared client injected into all three stores — the usual case, since they
   * target the same database and a libSQL client is a connection *pool* in its
   * own right.  When omitted, each store lazily builds its own client from its
   * `url` / `authToken`.
   */
  readonly client?: LibSqlClientLike;
  /**
   * Database URL applied to every store that does not set its own.  Saves
   * repeating the connection three times when no shared `client` is passed.
   */
  readonly url?: string;
  /** Auth token applied to every store that does not set its own. */
  readonly authToken?: string;
  /** Journal-specific options (table names, autoCreate). */
  readonly journal?: LibSqlJournalOptions;
  /** Snapshot-store-specific options (table name, keepN). */
  readonly snapshotStore?: LibSqlSnapshotStoreOptions;
  /** Durable-state-store-specific options (table name). */
  readonly durableStateStore?: LibSqlDurableStateStoreOptions;
}

/**
 * Fluent builder for {@link RegisterLibSqlPluginsOptionsType}:
 *
 *     const pluginOptions = RegisterLibSqlPluginsOptions.create()
 *       .withUrl('libsql://my-db.turso.io')
 *       .withAuthToken(process.env.TURSO_AUTH_TOKEN)
 *       .withSnapshotStore(LibSqlSnapshotStoreOptions.create().withKeepN(5));
 *     const handles = registerLibSqlPlugins(persistence, pluginOptions);
 *
 * The shared connection fields are merged onto each store's options by
 * `registerLibSqlPlugins`, so a leaf carries only its store-specific fields.
 * Each leaf setter accepts EITHER the leaf builder OR a plain object.
 */
export class RegisterLibSqlPluginsOptionsBuilder extends OptionsBuilder<RegisterLibSqlPluginsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RegisterLibSqlPluginsOptionsBuilder()`. */
  static create(): RegisterLibSqlPluginsOptionsBuilder {
    return new RegisterLibSqlPluginsOptionsBuilder();
  }

  /** Shared client injected into all three stores. */
  withClient(client: LibSqlClientLike): this {
    return this.set('client', client);
  }

  /** Database URL applied to every store that does not set its own. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Auth token applied to every store that does not set its own. */
  withAuthToken(authToken: string): this {
    return this.set('authToken', authToken);
  }

  /** Journal-specific options (table names, autoCreate). */
  withJournal(journal: LibSqlJournalOptions): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store-specific options (table name, keepN). */
  withSnapshotStore(snapshotStore: LibSqlSnapshotStoreOptions): this {
    return this.set('snapshotStore', snapshotStore);
  }

  /** Durable-state-store-specific options (table name). */
  withDurableStateStore(durableStateStore: LibSqlDurableStateStoreOptions): this {
    return this.set('durableStateStore', durableStateStore);
  }
}

/**
 * Accepted input for `registerLibSqlPlugins`: the fluent
 * {@link RegisterLibSqlPluginsOptionsBuilder} OR a plain
 * {@link RegisterLibSqlPluginsOptionsType} object.
 */
export type RegisterLibSqlPluginsOptions =
  | RegisterLibSqlPluginsOptionsBuilder
  | Partial<RegisterLibSqlPluginsOptionsType>;
/** Value alias so `RegisterLibSqlPluginsOptions.create()` resolves to the builder. */
export const RegisterLibSqlPluginsOptions = RegisterLibSqlPluginsOptionsBuilder;
