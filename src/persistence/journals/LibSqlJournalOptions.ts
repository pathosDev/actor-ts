import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsError, OptionsValidator } from '../../util/OptionsValidator.js';
import type { LibSqlClientLike, LibSqlConnection } from './LibSqlClient.js';

/** URL schemes a remote libSQL database can be reached on. */
export const LIBSQL_URL_PROTOCOLS = ['libsql', 'http', 'https', 'ws', 'wss'] as const;

export interface LibSqlJournalOptionsType extends LibSqlConnection {
  /** Events table name.  Default: `events`. */
  readonly eventsTable?: string;
  /** Tags join table name.  Default: `${eventsTable}_tags`. */
  readonly tagsTable?: string;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
}

/**
 * Fluent builder for {@link LibSqlJournalOptionsType}:
 *
 *     new LibSqlJournal(LibSqlJournalOptions.create()
 *       .withUrl('libsql://my-db.turso.io')
 *       .withAuthToken(process.env.TURSO_AUTH_TOKEN))
 *
 * Pass a pre-built `withClient(...)` to share ONE client across the journal,
 * snapshot and durable-state stores.
 */
export class LibSqlJournalOptionsBuilder extends OptionsBuilder<LibSqlJournalOptionsType> {
  /** Start a fresh builder.  Equivalent to `new LibSqlJournalOptionsBuilder()`. */
  static create(): LibSqlJournalOptionsBuilder {
    return new LibSqlJournalOptionsBuilder();
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
 * Accepted input for any libSQL-journal constructor: the fluent
 * {@link LibSqlJournalOptionsBuilder} OR a plain {@link LibSqlJournalOptionsType} object.
 */
export type LibSqlJournalOptions = LibSqlJournalOptionsBuilder | Partial<LibSqlJournalOptionsType>;
/** Value alias so `LibSqlJournalOptions.create()` / `new LibSqlJournalOptions()` resolve to the builder. */
export const LibSqlJournalOptions = LibSqlJournalOptionsBuilder;

/**
 * Validates the connection fields, which is where the misconfigurations that
 * are worth catching early live.
 *
 * The important rule is the URL scheme.  `@libsql/client/web` — the entry point
 * these backends import, chosen because it loads nothing native — cannot open
 * `file:` or `:memory:` databases at all, so a local path would fail deep
 * inside the driver on the first append with an opaque message.  Rejecting it
 * up front lets the error say the useful thing instead: for a local database,
 * use `SqliteJournal`.
 */
export class LibSqlJournalOptionsValidator extends OptionsValidator<LibSqlJournalOptionsType> {
  constructor() { super('LibSqlJournalOptions'); }

  protected rules(s: Partial<LibSqlJournalOptionsType>): void {
    assertRemoteLibSqlUrl('LibSqlJournalOptions', s.url);
    this.nonEmptyString('authToken');
    this.nonEmptyString('eventsTable');
    this.nonEmptyString('tagsTable');
  }
}

/**
 * Shared URL rule for the three libSQL option families — a standalone function
 * rather than a validator helper, because the three validators are separate
 * classes over separate option types and this rule is identical for all of
 * them.  It raises the same `OptionsError` shape the base class's `fail` does.
 */
export function assertRemoteLibSqlUrl(optionsName: string, url: string | undefined): void {
  if (url === undefined) return;
  const fail = (reason: string): never => {
    throw new OptionsError(`${optionsName}: url ${reason} (got ${JSON.stringify(url)})`, optionsName, 'url', url);
  };
  if (url === ':memory:' || url.startsWith('file:')) {
    fail(
      'must be a remote libSQL URL — a local file or :memory: database is not reachable over HTTP; '
      + 'use SqliteJournal / SqliteSnapshotStore for those',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail('must be a valid URL');
  }
  const protocol = parsed.protocol.replace(/:$/, '');
  if (!LIBSQL_URL_PROTOCOLS.includes(protocol as (typeof LIBSQL_URL_PROTOCOLS)[number])) {
    fail(`must use protocol ${LIBSQL_URL_PROTOCOLS.join(', ')}`);
  }
}
