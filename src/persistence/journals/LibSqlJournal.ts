import { sqliteDialect } from '../relational/SqliteDialect.js';
import { RelationalJournal } from '../relational/RelationalJournal.js';
import { adaptLibSqlClient, buildLibSqlClient } from './LibSqlClient.js';
import {
  LibSqlJournalOptionsValidator,
  type LibSqlJournalOptions,
  type LibSqlJournalOptionsType,
} from './LibSqlJournalOptions.js';

/**
 * Journal backed by libSQL / Turso — SQLite over HTTP or WebSocket.
 *
 * Behaviour lives in `RelationalJournal`; this class supplies the SQLite
 * dialect and the client.  The schema and statements match `SqliteJournal`'s,
 * so a local database can be pushed to Turso (or a Turso one pulled down and
 * opened locally) without a migration.
 *
 * **Why this is not just `SqliteJournal` with another driver.** `SqliteDriver`
 * is synchronous, which a local file affords and a network service does not.
 * Running on the relational base instead also means libSQL gets a
 * durable-state store, which the local SQLite backend still lacks.
 *
 * Being a remote, cross-process store, it exposes no in-process event bus, so
 * the query layer polls — same as Postgres and Cassandra.
 *
 * For a local file or `:memory:`, use `SqliteJournal`: the `@libsql/client/web`
 * entry point cannot open them, and the options validator says so rather than
 * letting the driver fail obscurely on the first append.
 */
export class LibSqlJournal extends RelationalJournal {
  constructor(options: LibSqlJournalOptions = {}) {
    const resolvedOptions = (options as LibSqlJournalOptionsType);
    new LibSqlJournalOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'LibSqlJournal',
      dialect: sqliteDialect,
      eventsTable: resolvedOptions.eventsTable,
      tagsTable: resolvedOptions.tagsTable,
      autoCreateTables: resolvedOptions.autoCreateTables,
      serializer: resolvedOptions.serializer,
      // An injected client is shared with the sibling stores and closed by the
      // caller; one we build ourselves is ours to close.
      ownsPool: resolvedOptions.client === undefined,
      openPool: async () => adaptLibSqlClient(await buildLibSqlClient(resolvedOptions)),
    });
  }
}
