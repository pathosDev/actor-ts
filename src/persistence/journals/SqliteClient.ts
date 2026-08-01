import { getSqliteDriver, type SqliteDb } from '../../runtime/sqlite/index.js';
import type { SqlPool, SqlResult } from '../relational/SqlPool.js';

/**
 * Adapt a local SQLite database to the uniform `SqlPool` the relational
 * persistence bases talk to.
 *
 * Local SQLite was the one family without such an adapter.  `SqliteJournal`
 * predates the relational base layer and drives `SqliteDb` directly, which is
 * why every other backend has an `XClient.ts` and this one did not — see #491
 * for collapsing that journal onto `RelationalJournal` now that this exists.
 *
 * Two things make this adapter more than a wrapper.
 *
 * **The driver is synchronous, and split.**  `SqlPool.query` has to report both
 * `rows` and `affectedRows`, but the driver surfaces those through different
 * calls: `.all()` returns rows and `.run()` returns `{ changes }`, and asking
 * for the wrong one throws on `better-sqlite3`.  So each statement is
 * classified before it runs (see `returnsRows`).
 *
 * **Transactions are real, and therefore need serializing.**  Unlike the
 * HTTP-fronted SQLite backends (libSQL, Cloudflare D1), a local database can
 * honour a genuine `BEGIN … COMMIT`, so `withTransaction` here gives true
 * isolation rather than the atomic-batch approximation `SqlPool` documents as
 * the weaker permitted option.  But one `SqliteDb` is one connection, and the
 * callback is async — so without a lock a second `withTransaction` could issue
 * its `BEGIN` while the first was still awaiting, and the two would collapse
 * into one transaction whose `COMMIT` fires early.  Transactions are queued.
 */

/**
 * Whether a statement yields rows, and so must go through `.all()`.
 *
 * Deliberately keyword-based rather than "try `.all()`, fall back to `.run()`":
 * on `better-sqlite3` the wrong call throws, and a thrown-and-retried write
 * would be a write attempted twice.  Comments and leading whitespace are
 * stripped first because the dialect builds some statements across lines.
 *
 * `RETURNING` is matched anywhere in the text.  The SQLite dialect does not use
 * it today, so that arm is unreachable — but a future statement that did would
 * otherwise silently lose its rows, which is a much worse failure than an
 * unnecessary check.
 */
function returnsRows(sql: string): boolean {
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
  if (/\bRETURNING\b/i.test(stripped)) return true;
  return /^(SELECT|WITH|PRAGMA|EXPLAIN|VALUES)\b/i.test(stripped);
}

/**
 * Run one statement, choosing `.all()` or `.run()` by classification.
 *
 * SQLite hands back `INTEGER` columns as `number` and `bigint` values as
 * `bigint`; the relational stores already accept `string | number | bigint`
 * for the revision, so rows are passed through untouched rather than coerced
 * here — coercion belongs to whoever knows the column's meaning.
 */
function runStatement(db: SqliteDb, sql: string, params: ReadonlyArray<unknown>): SqlResult {
  const statement = db.prepare(sql);
  if (returnsRows(sql)) {
    const rows = statement.all<Record<string, unknown>>(...(params as unknown[]));
    return { rows, affectedRows: 0 };
  }
  const info = statement.run(...(params as unknown[]));
  return { rows: [], affectedRows: Number(info.changes) };
}

/**
 * Wrap `db` as a `SqlPool`.
 *
 * `ownsDatabase` decides whether `end()` closes the handle: a caller that
 * injected its own `SqliteDb` (to share one across the journal, snapshot and
 * durable-state stores, or to hand in a fake) keeps responsibility for it.
 */
export function adaptSqliteDatabase(db: SqliteDb, ownsDatabase: boolean = true): SqlPool {
  // Promise chain as a mutex.  Every transaction waits for the previous one to
  // settle, so `BEGIN`/`COMMIT` pairs cannot interleave on the shared
  // connection.  Plain `query` calls are not queued: they are single
  // statements, and SQLite serializes them itself.
  let transactionQueue: Promise<unknown> = Promise.resolve();

  return {
    async query(sql, params) {
      return runStatement(db, sql, params ?? []);
    },

    async withTransaction(body) {
      const run = async (): Promise<unknown> => {
        // IMMEDIATE, not the default DEFERRED: a deferred transaction takes
        // the write lock only at its first write, so a reader-then-writer
        // sequence — which is exactly what an append or a CAS does — can fail
        // to upgrade and surface as SQLITE_BUSY partway through.  Taking the
        // lock up front turns that into a wait at the boundary instead.
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = await body({
            query: async (sql, params) => runStatement(db, sql, params ?? []),
          });
          db.exec('COMMIT');
          return result;
        } catch (e) {
          // Best-effort: SQLite may have rolled back already (e.g. on a
          // constraint failure with ON CONFLICT ROLLBACK), and that must not
          // mask the original error.
          try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
          throw e;
        }
      };
      const settled = transactionQueue.then(run, run);
      // Keep the chain alive regardless of outcome, without an unhandled
      // rejection from the queue itself.
      transactionQueue = settled.catch(() => undefined);
      return await settled as never;
    },

    async end() {
      if (ownsDatabase) db.close();
    },
  };
}

/** Connection options shared by the local-SQLite relational stores. */
export type SqliteConnection = {
  /**
   * Database file, or `':memory:'`.  Required unless `database` is supplied.
   */
  readonly path?: string;
  /**
   * Pre-opened database — bypasses `getSqliteDriver()` entirely.  Use to share
   * ONE handle across stores, or to inject a fake in tests.
   */
  readonly database?: SqliteDb;
};

/** Open (or pass through) the database for a store. */
export async function buildSqliteDatabase(connection: SqliteConnection): Promise<SqliteDb> {
  if (connection.database) return connection.database;
  if (connection.path === undefined) {
    throw new Error('SQLite persistence requires either `path` or a pre-opened `database`.');
  }
  const driver = await getSqliteDriver();
  return driver.open(connection.path);
}
