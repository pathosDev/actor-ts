import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import { assertRemoteLibSqlUrl } from '../journals/LibSqlJournalOptions.js';
import type { LibSqlClientLike, LibSqlConnection } from '../journals/LibSqlClient.js';

export type LibSqlDurableStateStoreOptionsType = LibSqlConnection & {
  /** Durable-state table name.  Default: `durable_state`. */
  readonly table?: string;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
};

/**
 * Fluent builder for {@link LibSqlDurableStateStoreOptionsType}:
 *
 *     new LibSqlDurableStateStore(LibSqlDurableStateStoreOptions.create()
 *       .withUrl('libsql://my-db.turso.io')
 *       .withAuthToken(process.env.TURSO_AUTH_TOKEN))
 */
export class LibSqlDurableStateStoreOptionsBuilder extends OptionsBuilder<LibSqlDurableStateStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new LibSqlDurableStateStoreOptionsBuilder()`. */
  static create(): LibSqlDurableStateStoreOptionsBuilder {
    return new LibSqlDurableStateStoreOptionsBuilder();
  }

  /** Database URL — `libsql://…` (Turso) or `http(s)://` / `ws(s)://` (self-hosted `sqld`). */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Turso auth token.  Omit for an unauthenticated local `sqld`. */
  withAuthToken(authToken: string): this {
    return this.set('authToken', authToken);
  }

  /** Pre-built client — bypasses the lazy `@libsql/client` import; share it across stores. */
  withClient(client: LibSqlClientLike): this {
    return this.set('client', client);
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
 * Accepted input for any libSQL-durable-state constructor: the fluent
 * {@link LibSqlDurableStateStoreOptionsBuilder} OR a plain
 * {@link LibSqlDurableStateStoreOptionsType} object.
 */
export type LibSqlDurableStateStoreOptions =
  | LibSqlDurableStateStoreOptionsBuilder
  | Partial<LibSqlDurableStateStoreOptionsType>;
/** Value alias so `LibSqlDurableStateStoreOptions.create()` resolves to the builder. */
export const LibSqlDurableStateStoreOptions = LibSqlDurableStateStoreOptionsBuilder;

/** Same URL rule as the journal — remote schemes only. */
export class LibSqlDurableStateStoreOptionsValidator
  extends OptionsValidator<LibSqlDurableStateStoreOptionsType> {
  constructor() { super('LibSqlDurableStateStoreOptions'); }

  protected rules(s: Partial<LibSqlDurableStateStoreOptionsType>): void {
    assertRemoteLibSqlUrl('LibSqlDurableStateStoreOptions', s.url);
    this.nonEmptyString('authToken');
    this.nonEmptyString('table');
  }
}
