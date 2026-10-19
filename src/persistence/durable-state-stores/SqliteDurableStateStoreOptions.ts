import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import { assertLocalSqlitePath, type SqliteConnection } from '../journals/SqliteClient.js';
import type { SqliteDb } from '../../runtime/sqlite/index.js';

export interface SqliteDurableStateStoreOptionsType extends SqliteConnection, StoreSerializerOptionsBase {
  /** Durable-state table name.  Default: `durable_state`. */
  readonly table?: string;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
}

/**
 * Fluent builder for {@link SqliteDurableStateStoreOptionsType}:
 *
 *     new SqliteDurableStateStore(SqliteDurableStateStoreOptions.create()
 *       .withPath('./state.db'))
 */
export class SqliteDurableStateStoreOptionsBuilder extends StoreSerializerOptionsBuilder<SqliteDurableStateStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new SqliteDurableStateStoreOptionsBuilder()`. */
  static create(): SqliteDurableStateStoreOptionsBuilder {
    return new SqliteDurableStateStoreOptionsBuilder();
  }

  /** Database file, or `':memory:'`. */
  withPath(path: string): this {
    return this.set('path', path);
  }

  /**
   * Pre-opened database, used in place of `path` — share a connection the
   * caller owns, or inject a fake.  This store is the only SQLite store that
   * takes one: the journal and the snapshot store open their own (#491).
   */
  withDatabase(database: SqliteDb): this {
    return this.set('database', database);
  }

  /**
   * Lock-wait budget for a blocked writer, in milliseconds; `0` fails fast.
   * Default: `DEFAULT_SQLITE_BUSY_TIMEOUT_MS`.  Ignored when a pre-opened
   * `database` is supplied — that handle's pragma belongs to its opener.
   */
  withBusyTimeoutMs(busyTimeoutMs: number): this {
    return this.set('busyTimeoutMs', busyTimeoutMs);
  }

  /** Durable-state table name.  Default: `durable_state`. */
  withTable(table: string): this {
    return this.set('table', table);
  }

  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  withAutoCreateTables(autoCreateTables: boolean): this {
    return this.set('autoCreateTables', autoCreateTables);
  }
}

/**
 * Accepted input for any SQLite-durable-state constructor: the fluent
 * {@link SqliteDurableStateStoreOptionsBuilder} OR a plain
 * {@link SqliteDurableStateStoreOptionsType} object.
 */
export type SqliteDurableStateStoreOptions =
  | SqliteDurableStateStoreOptionsBuilder
  | Partial<SqliteDurableStateStoreOptionsType>;
/** Value alias so `SqliteDurableStateStoreOptions.create()` resolves to the builder. */
export const SqliteDurableStateStoreOptions = SqliteDurableStateStoreOptionsBuilder;

export class SqliteDurableStateStoreOptionsValidator
  extends OptionsValidator<SqliteDurableStateStoreOptionsType> {
  constructor() { super('SqliteDurableStateStoreOptions'); }

  protected rules(s: Partial<SqliteDurableStateStoreOptionsType>): void {
    // The rule all three SQLite stores share (#1492), with the one difference
    // this store has: a pre-opened `database` stands in for the path.
    assertLocalSqlitePath('SqliteDurableStateStoreOptions', s, { acceptsDatabase: true });
    this.nonEmptyString('table');
    // Negative is SQLite's "retry forever", and the driver is synchronous —
    // that is an unbounded event-loop freeze, not a long wait.  `0` is legal
    // and means "fail fast instead of waiting".
    this.nonNegativeInt('busyTimeoutMs');
  }
}
