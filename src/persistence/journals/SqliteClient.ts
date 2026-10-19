import { DEFAULT_SQLITE_BUSY_TIMEOUT_MS } from '../Constants.js';
import { getSqliteDriver, type SqliteDb } from '../../runtime/sqlite/index.js';
import { OptionsError } from '../../util/OptionsValidator.js';
import { redactUrlCredentials } from '../../util/RedactUrlCredentials.js';
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
 * injected its own `SqliteDb` (a connection it also uses elsewhere, or a
 * fake) keeps responsibility for it.
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

/**
 * Apply the busy timeout to a freshly opened handle.
 *
 * A `PRAGMA` value cannot be bound as a parameter, so the number is
 * interpolated.  That is injection-safe by construction: `Math.trunc` yields
 * a number or `NaN`, never arbitrary text.  Negative values — SQLite reads
 * those as "retry forever", i.e. an unbounded event-loop freeze on a
 * synchronous driver — are rejected by the option validators long before they
 * reach here.
 */
export function applySqliteBusyTimeout(db: SqliteDb, busyTimeoutMs?: number): void {
  const timeout = Math.trunc(busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
  db.exec(`PRAGMA busy_timeout = ${timeout};`);
}

/** Connection options shared by the local-SQLite relational stores. */
export type SqliteConnection = {
  /**
   * Database file, or `':memory:'`.  Required unless `database` is supplied.
   */
  readonly path?: string;
  /**
   * Pre-opened database — bypasses `getSqliteDriver()` entirely.  Use to share
   * a connection the caller owns, or to inject a fake in tests.  Of the SQLite
   * stores only the durable-state store takes one: the journal and the
   * snapshot store open their own handle (#491).
   */
  readonly database?: SqliteDb;
  /**
   * How long a blocked writer waits for the database lock before failing with
   * `SQLITE_BUSY`, in milliseconds.  `0` disables the wait — a contended write
   * fails immediately.  Default: {@link DEFAULT_SQLITE_BUSY_TIMEOUT_MS}.
   *
   * Ignored when `database` is supplied: the pragma is per connection, and a
   * handle someone else opened is theirs to tune.
   */
  readonly busyTimeoutMs?: number;
};

/**
 * The one rule for what a local SQLite store's `path` may be (#1492), held by
 * the journal's, the snapshot store's and the durable-state store's option
 * validators and by {@link buildSqliteDatabase}.  Before it the three stores
 * disagreed, so one configuration could give two stores quietly running in
 * memory beside a third that refused to start.
 *
 * A present path must name a database the local driver can open: a non-empty
 * string that is not a remote URL.  `''` is refused rather than handed to
 * SQLite, which would open an anonymous temporary database — and `""` is the
 * "not set" placeholder `reference.conf` publishes, so the two would read the
 * same.  A `libsql:`, `http(s):` or `ws(s):` path is refused because the local
 * driver would create a *file* of that name instead of reaching the service:
 * the mirror image of `assertRemoteLibSqlUrl`, and the message points at the
 * libSQL stores that do reach one.  The value is reported with any
 * credentials masked, because a refusal that fails a startup is logged.
 *
 * An absent path is refused unless the store takes a pre-opened handle and is
 * given one, and only the durable-state store takes one: the journal and the
 * snapshot store open their own handle (#491), so a `database` handed to them
 * stands in for nothing.  There is no default to fall back on.  An in-memory
 * database is the explicit `':memory:'`, because a store that quietly runs in
 * memory looks exactly like one that persists until the process restarts.
 *
 * A standalone function rather than a validator helper, for the reason
 * `assertRemoteLibSqlUrl` gives: three validators over three option types
 * share it, and `buildSqliteDatabase` has no validator at all.  It raises the
 * `OptionsError` shape `OptionsValidator.fail` raises, on field `path`.
 */
export function assertLocalSqlitePath(
  optionsName: string,
  connection: Pick<SqliteConnection, 'path' | 'database'>,
  { acceptsDatabase }: { readonly acceptsDatabase: boolean },
): void {
  const { path } = connection;
  const names = 'a database file, or ":memory:" for an in-memory database';
  if (path === undefined) {
    if (acceptsDatabase && connection.database !== undefined) return;
    const required = acceptsDatabase ? 'is required unless `database` is supplied' : 'is required';
    throw sqlitePathError(optionsName, `${required}: ${names}`);
  }
  if (typeof path !== 'string' || path.length === 0) {
    throw sqlitePathError(optionsName, `must be a non-empty string: ${names}`, path);
  }
  if (/^(libsql|https?|wss?):/i.test(path)) {
    throw sqlitePathError(
      optionsName,
      'must be a local file path or ":memory:" — for a remote SQLite service use the libSQL stores '
        + '(LibSqlJournal, LibSqlSnapshotStore, LibSqlDurableStateStore)',
      redactUrlCredentials(path),
    );
  }
}

/** The `OptionsError` `OptionsValidator.fail` raises, for field `path` — with a `(got …)` tail only when a value is given. */
function sqlitePathError(optionsName: string, reason: string, ...value: [] | [unknown]): OptionsError {
  const got = value.length > 0 ? ` (got ${OptionsError.renderValue(value[0])})` : '';
  return new OptionsError(`${optionsName}: path ${reason}${got}`, optionsName, 'path', value[0]);
}

/** Open (or pass through) the database for a store. */
export async function buildSqliteDatabase(connection: SqliteConnection): Promise<SqliteDb> {
  // The rule every SQLite store's validator holds, so a direct caller gets the
  // same answer rather than a weaker one of its own — and a present path is
  // checked even beside a handle, as the validator checks it.
  assertLocalSqlitePath('SqliteConnection', connection, { acceptsDatabase: true });
  // An injected handle is left exactly as it arrived.  It belongs to whoever
  // opened it — application code using the same connection, or a test fake —
  // so re-tuning it here would reach into a connection this store does not own.
  if (connection.database !== undefined) return connection.database;
  const driver = await getSqliteDriver();
  // With no handle given, the rule has left a usable path.
  const db = driver.open(connection.path as string);
  applySqliteBusyTimeout(db, connection.busyTimeoutMs);
  return db;
}
