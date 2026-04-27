/**
 * Runtime-neutral SQLite driver abstraction consumed by `SqliteJournal`
 * and `SqliteSnapshotStore`.
 *
 * The two supported implementations (`bun:sqlite` and `better-sqlite3`)
 * happen to share almost the entire surface — constructor, `exec`,
 * `prepare` with `.run` / `.get` / `.all`, `transaction`, `close`.  The
 * interface below captures exactly that subset.  A Deno backend is
 * intentionally deferred — Deno users run `InMemoryJournal` or
 * `CassandraJournal` in the meantime.
 */

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = unknown>(...params: unknown[]): T | undefined;
  all<T = unknown>(...params: unknown[]): T[];
}

export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /**
   * Wrap the supplied function in a SQLite transaction.  Matches the
   * signature of both `bun:sqlite` and `better-sqlite3`: calling the
   * returned function with the same arguments commits on successful
   * return and rolls back on thrown exceptions.
   */
  transaction<F extends (...args: never[]) => unknown>(fn: F): F;
  close(): void;
}

export interface SqliteDriver {
  open(path: string): SqliteDb;
}
