import { sqliteDialect } from '../relational/SqliteDialect.js';
import { RelationalDurableStateStore } from '../relational/RelationalDurableStateStore.js';
import { adaptSqliteDatabase, buildSqliteDatabase } from '../journals/SqliteClient.js';
import {
  SqliteDurableStateStoreOptionsValidator,
  type SqliteDurableStateStoreOptions,
  type SqliteDurableStateStoreOptionsType,
} from './SqliteDurableStateStoreOptions.js';

/**
 * DurableStateStore backed by a local SQLite file.
 *
 * Closes the last gap in the backend matrix: SQLite shipped a journal and a
 * snapshot store but no durable state, so it was the only family where the
 * three-component set was incomplete.  `LibSqlDurableStateStore` covered the
 * remote case and said as much in its own JSDoc.
 *
 * Behaviour lives in `RelationalDurableStateStore`; this class supplies the
 * SQLite dialect — the same one libSQL and Cloudflare D1 use, so the schema is
 * identical and a database can move between a local file, Turso and D1 without
 * a migration.
 *
 * Worth knowing about the isolation: because this talks to a local file rather
 * than over HTTP, `withTransaction` is a real `BEGIN IMMEDIATE … COMMIT`.
 * `SqlPool` specifies isolation as adapter-defined precisely so the
 * HTTP-fronted stores can offer less; this one offers more than the contract
 * requires.
 */
export class SqliteDurableStateStore extends RelationalDurableStateStore {
  constructor(options: SqliteDurableStateStoreOptions = {}) {
    const resolvedOptions = (options as SqliteDurableStateStoreOptionsType);
    new SqliteDurableStateStoreOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'SqliteDurableStateStore',
      dialect: sqliteDialect,
      table: resolvedOptions.table,
      autoCreateTables: resolvedOptions.autoCreateTables,
      // A caller-supplied handle is a shared handle — closing it here would
      // pull the database out from under the journal and snapshot store using
      // the same one.
      ownsPool: resolvedOptions.database === undefined,
      openPool: async () => adaptSqliteDatabase(
        await buildSqliteDatabase(resolvedOptions),
        resolvedOptions.database === undefined,
      ),
    });
  }
}
