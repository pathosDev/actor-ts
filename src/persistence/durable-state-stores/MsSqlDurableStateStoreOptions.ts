import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { MsSqlConnection, MsSqlPoolLike } from '../journals/MsSqlClient.js';

export type MsSqlDurableStateStoreOptionsType = MsSqlConnection & {
  /** Durable-state table name.  Default: `durable_state`. */
  readonly table?: string;
  /** Run the guarded `CREATE TABLE` statement on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
};

/**
 * Fluent builder for {@link MsSqlDurableStateStoreOptionsType}:
 *
 *     new MsSqlDurableStateStore(MsSqlDurableStateStoreOptions.create()
 *       .withPoolConfig(config))
 */
export class MsSqlDurableStateStoreOptionsBuilder extends OptionsBuilder<MsSqlDurableStateStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new MsSqlDurableStateStoreOptionsBuilder()`. */
  static create(): MsSqlDurableStateStoreOptionsBuilder {
    return new MsSqlDurableStateStoreOptionsBuilder();
  }

  /** Connection string — either the `Server=…;Database=…` or `mssql://` form. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** `mssql` config object (server/port/user/password/database/options/pool). */
  withPoolConfig(poolConfig: Record<string, unknown>): this {
    return this.set('poolConfig', poolConfig);
  }

  /** Pre-built pool — bypasses the lazy `mssql` import; share it across stores. */
  withPool(pool: MsSqlPoolLike): this {
    return this.set('pool', pool);
  }

  /** Durable-state table name.  Default: `durable_state`. */
  withTable(table: string): this {
    return this.set('table', table);
  }

  /** Run the guarded `CREATE TABLE` statement on first use.  Default: true. */
  withAutoCreateTables(autoCreateTables: boolean): this {
    return this.set('autoCreateTables', autoCreateTables);
  }
}

/**
 * Accepted input for any SQL Server durable-state constructor: the fluent
 * {@link MsSqlDurableStateStoreOptionsBuilder} OR a plain
 * {@link MsSqlDurableStateStoreOptionsType} object.
 */
export type MsSqlDurableStateStoreOptions =
  | MsSqlDurableStateStoreOptionsBuilder
  | Partial<MsSqlDurableStateStoreOptionsType>;
/** Value alias so `MsSqlDurableStateStoreOptions.create()` resolves to the builder. */
export const MsSqlDurableStateStoreOptions = MsSqlDurableStateStoreOptionsBuilder;

/** Rejects empty strings where a name is expected. */
export class MsSqlDurableStateStoreOptionsValidator
  extends OptionsValidator<MsSqlDurableStateStoreOptionsType> {
  constructor() { super('MsSqlDurableStateStoreOptions'); }

  protected rules(_s: Partial<MsSqlDurableStateStoreOptionsType>): void {
    this.nonEmptyString('url');
    this.nonEmptyString('table');
  }
}
