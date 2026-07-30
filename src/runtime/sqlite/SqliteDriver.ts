/**
 * Runtime-neutral SQLite driver abstraction consumed by `SqliteJournal`
 * and `SqliteSnapshotStore`.
 *
 * The implementations — `bun:sqlite`, `better-sqlite3`, and the built-in
 * `node:sqlite` — share almost the entire surface: constructor, `exec`,
 * `prepare` with `.run` / `.get` / `.all`, `close`.  The interface below
 * captures exactly that subset, and `node:sqlite` covers all three runtimes
 * including Deno (≥ 2.2).
 *
 * The surface is deliberately **synchronous**, which is what a local SQLite
 * file affords.  A remote SQLite-compatible service is async by nature and
 * therefore does not belong here — those backends (libSQL/Turso, Cloudflare D1)
 * run on the relational base with a SQLite `SqlDialect` instead.
 */

export type SqliteStatement = {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = unknown>(...params: unknown[]): T | undefined;
  all<T = unknown>(...params: unknown[]): T[];
};

export type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /**
   * Wrap the supplied function in a SQLite transaction.  Matches the
   * signature of both `bun:sqlite` and `better-sqlite3`: calling the
   * returned function with the same arguments commits on successful
   * return and rolls back on thrown exceptions.  `node:sqlite` has no such
   * helper, so `NodeSqliteDriver` synthesizes one — non-re-entrant, which is
   * all the stores need.
   */
  transaction<F extends (...args: never[]) => unknown>(fn: F): F;
  close(): void;
};

export type SqliteDriver = {
  open(path: string): SqliteDb;
};
