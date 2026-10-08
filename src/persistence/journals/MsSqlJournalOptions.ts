import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import { MsSqlOptionsValidatorBase, type MsSqlConnection, type MsSqlPoolLike } from './MsSqlClient.js';

export interface MsSqlJournalOptionsType extends MsSqlConnection, StoreSerializerOptionsBase {
  /** Events table name.  Default: `events`. */
  readonly eventsTable?: string;
  /** Tags join table name.  Default: `${eventsTable}_tags`. */
  readonly tagsTable?: string;
  /** Run the guarded `CREATE TABLE` statements on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
}

/**
 * Fluent builder for {@link MsSqlJournalOptionsType}:
 *
 *     new MsSqlJournal(MsSqlJournalOptions.create()
 *       .withPoolConfig({ server: 'localhost', database: 'app', user: 'sa', password: '…' }))
 *
 * Pass a pre-built `withPool(...)` to share ONE pool across the journal,
 * snapshot and durable-state stores.
 */
export class MsSqlJournalOptionsBuilder extends StoreSerializerOptionsBuilder<MsSqlJournalOptionsType> {
  /** Start a fresh builder.  Equivalent to `new MsSqlJournalOptionsBuilder()`. */
  static create(): MsSqlJournalOptionsBuilder {
    return new MsSqlJournalOptionsBuilder();
  }

  /** Connection string in the `Server=…;Database=…` form — an `mssql://` URL is refused. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /**
   * `mssql` config object (server/port/user/password/database/options/pool)
   * — e.g. `{ server, database, user, password,
   * options: { encrypt: true, cryptoCredentialsDetails: { ca: fs.readFileSync('rds-ca.pem') } } }`.
   *
   * Supply the signing CA rather than telling the driver to trust the server
   * certificate, which switches verification off: encryption without
   * verification authenticates nobody, and this link carries the journal.  See
   * https://actor-ts.dev/operations/security/tls-everywhere/.
   */
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
 * Rejects empty strings where a name is expected; the connection rules every
 * SQL Server store shares are `MsSqlOptionsValidatorBase`'s.
 */
export class MsSqlJournalOptionsValidator extends MsSqlOptionsValidatorBase<MsSqlJournalOptionsType> {
  constructor() { super('MsSqlJournalOptions'); }

  protected rules(s: Partial<MsSqlJournalOptionsType>): void {
    this.checkConnection(s);
    this.nonEmptyString('eventsTable');
    this.nonEmptyString('tagsTable');
  }
}
