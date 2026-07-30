import {
  D1OptionsBuilderBase,
  D1OptionsValidatorBase,
  type D1OptionsBaseType,
} from './D1OptionsBase.js';
import { assertSafeIdentifier } from '../storage/SqlIdentifier.js';

export type D1JournalOptionsType = D1OptionsBaseType & {
  /** Events table name.  Default: `events`. */
  readonly eventsTable?: string;
  /** Tags join table name.  Default: `${eventsTable}_tags`. */
  readonly tagsTable?: string;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
};

/**
 * Fluent builder for {@link D1JournalOptionsType}:
 *
 *     new D1Journal(D1JournalOptions.create()
 *       .withAccountId(process.env.CLOUDFLARE_ACCOUNT_ID)
 *       .withDatabaseId(process.env.D1_DATABASE_ID)
 *       .withApiToken(process.env.CLOUDFLARE_API_TOKEN))
 *
 * The connection setters come from {@link D1OptionsBuilderBase}; pass a pre-built
 * `withClient(...)` to share ONE transport across the three stores.
 */
export class D1JournalOptionsBuilder extends D1OptionsBuilderBase<D1JournalOptionsType> {
  /** Start a fresh builder.  Equivalent to `new D1JournalOptionsBuilder()`. */
  static create(): D1JournalOptionsBuilder {
    return new D1JournalOptionsBuilder();
  }

  /** Events table name.  Default: `events`. */
  withEventsTable(eventsTable: string): this {
    return this.set('eventsTable', eventsTable);
  }

  /** Tags join table name.  Default: `${eventsTable}_tags`. */
  withTagsTable(tagsTable: string): this {
    return this.set('tagsTable', tagsTable);
  }

  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  withAutoCreateTables(autoCreateTables: boolean): this {
    return this.set('autoCreateTables', autoCreateTables);
  }
}

/**
 * Accepted input for any D1 journal constructor: the fluent
 * {@link D1JournalOptionsBuilder} OR a plain {@link D1JournalOptionsType} object.
 */
export type D1JournalOptions = D1JournalOptionsBuilder | Partial<D1JournalOptionsType>;
/** Value alias so `D1JournalOptions.create()` resolves to the builder. */
export const D1JournalOptions = D1JournalOptionsBuilder;

/** Connection rules plus the table names, which are interpolated into SQL. */
export class D1JournalOptionsValidator extends D1OptionsValidatorBase<D1JournalOptionsType> {
  constructor() { super('D1JournalOptions'); }

  protected rules(s: Partial<D1JournalOptionsType>): void {
    this.checkConnection(s);
    // Interpolated into DDL/DML, so guarded against injection (#6) here as well
    // as in the store — a bad name fails at wiring time either way.
    if (s.eventsTable !== undefined) assertSafeIdentifier(s.eventsTable, 'events table');
    if (s.tagsTable !== undefined) assertSafeIdentifier(s.tagsTable, 'tags table');
  }
}
