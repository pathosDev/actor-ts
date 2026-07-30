import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { MsSqlConnection, MsSqlPoolLike } from './MsSqlClient.js';

export type MsSqlJournalOptionsType = MsSqlConnection & {
  /** Events table name.  Default: `events`. */
  readonly eventsTable?: string;
  /** Tags join table name.  Default: `${eventsTable}_tags`. */
  readonly tagsTable?: string;
  /** Run the guarded `CREATE TABLE` statements on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
};

/**
 * Fluent builder for {@link MsSqlJournalOptionsType}:
 *
 *     new MsSqlJournal(MsSqlJournalOptions.create()
 *       .withPoolConfig({ server: 'localhost', database: 'app', user: 'sa', password: '…' }))
 *
 * Pass a pre-built `withPool(...)` to share ONE pool across the journal,
 * snapshot and durable-state stores.
 */
export class MsSqlJournalOptionsBuilder extends OptionsBuilder<MsSqlJournalOptionsType> {
  /** Start a fresh builder.  Equivalent to `new MsSqlJournalOptionsBuilder()`. */
  static create(): MsSqlJournalOptionsBuilder {
    return new MsSqlJournalOptionsBuilder();
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

  /** Events table name.  Default: `events`. */
  withEventsTable(eventsTable: string): this {
    return this.set('eventsTable', eventsTable);
  }

  /** Tags join table name.  Default: `${eventsTable}_tags`. */
  withTagsTable(tagsTable: string): this {
    return this.set('tagsTable', tagsTable);
  }

  /** Run the guarded `CREATE TABLE` statements on first use.  Default: true. */
  withAutoCreateTables(autoCreateTables: boolean): this {
    return this.set('autoCreateTables', autoCreateTables);
  }
}

/**
 * Accepted input for any SQL Server journal constructor: the fluent
 * {@link MsSqlJournalOptionsBuilder} OR a plain {@link MsSqlJournalOptionsType} object.
 */
export type MsSqlJournalOptions = MsSqlJournalOptionsBuilder | Partial<MsSqlJournalOptionsType>;
/** Value alias so `MsSqlJournalOptions.create()` resolves to the builder. */
export const MsSqlJournalOptions = MsSqlJournalOptionsBuilder;

/**
 * Rejects empty strings where a name is expected.
 *
 * Deliberately no URL rule: SQL Server's native connection string
 * (`Server=host,1433;Database=…`) is not a URL, so parsing it as one would
 * reject the form most users actually paste in.
 */
export class MsSqlJournalOptionsValidator extends OptionsValidator<MsSqlJournalOptionsType> {
  constructor() { super('MsSqlJournalOptions'); }

  protected rules(_s: Partial<MsSqlJournalOptionsType>): void {
    this.nonEmptyString('url');
    this.nonEmptyString('eventsTable');
    this.nonEmptyString('tagsTable');
  }
}
