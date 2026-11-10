import { sqliteDialect } from '../relational/SqliteDialect.js';
import { RelationalDurableStateStore } from '../relational/RelationalDurableStateStore.js';
import { adaptSqliteDatabase, buildSqliteDatabase } from '../journals/SqliteClient.js';
import {
  SqliteDurableStateStoreOptionsValidator,
  type SqliteDurableStateStoreOptions,
  type SqliteDurableStateStoreOptionsType,
} from './SqliteDurableStateStoreOptions.js';
import type { StorageLocality } from '../StorageLocality.js';

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
  /** The one relational store on a local file — overrides the family's `'shared'` (#1356). */
  override readonly storageLocality: StorageLocality = 'node-local';

  constructor(options: SqliteDurableStateStoreOptions = {}) {
    const resolvedOptions = withoutNullDatabase(options as SqliteDurableStateStoreOptionsType);
    new SqliteDurableStateStoreOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'SqliteDurableStateStore',
      dialect: sqliteDialect,
      table: resolvedOptions.table,
      autoCreateTables: resolvedOptions.autoCreateTables,
      serializer: resolvedOptions.serializer,
      allowPlaintextRows: resolvedOptions.allowPlaintextRows,
      // A caller-supplied handle belongs to whoever opened it — closing it here
      // would pull the database out from under the code that handed it over.
      // No SQLite journal or snapshot store shares it: they open their own
      // handle (#491).
      ownsPool: resolvedOptions.database === undefined,
      openPool: async () => adaptSqliteDatabase(
        await buildSqliteDatabase(resolvedOptions),
        resolvedOptions.database === undefined,
      ),
    });
  }
}

/**
 * `options`, with an untyped `database: null` read as no handle at all
 * (#1492).
 *
 * The path rule and `buildSqliteDatabase` already count `null` — the value a
 * caller without the declared types passes for "none" — as no handle, so
 * `null` beside a path opens the path and `null` with no path is refused as a
 * store given neither.  What is left to this store is ownership: it decides
 * `ownsPool` and the adapter's close from `database === undefined`, so
 * without this a store that opened the path itself would leave that database
 * open on `close()`, as if a caller owned it.
 */
function withoutNullDatabase(options: SqliteDurableStateStoreOptionsType): SqliteDurableStateStoreOptionsType {
  if ((options.database as unknown) !== null) return options;
  return { ...options, database: undefined };
}
