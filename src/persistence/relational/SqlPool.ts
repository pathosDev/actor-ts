/**
 * The one connection shape the relational persistence bases talk to.
 *
 * Each driver has its own idea of a pool — node-postgres hands back
 * `{ rows, rowCount }` and checks out a client for a transaction, the
 * MariaDB connector returns either a row array or an OK-packet and exposes
 * `beginTransaction()` on the connection.  Rather than teach the stores both
 * dialects of *plumbing*, each client module adapts its pool to `SqlPool`
 * once, and the bases see a single uniform surface.  The interesting
 * differences — SQL text, error codes — live in `SqlDialect`.
 *
 * The public option types keep their driver-shaped `pool` fields
 * (`PgPoolLike`, `MariaDbPoolLike`), so injecting a real or fake driver pool
 * is unchanged; adaptation happens internally when the store opens.
 */

/** Normalized result of one statement. */
export type SqlResult = {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /**
   * Rows affected by an INSERT / UPDATE / DELETE, normalized to a number
   * (node-postgres reports `null` for some statements; MariaDB reports it on
   * an OK-packet).  `0` for statements that return rows.
   */
  readonly affectedRows: number;
};

/** Anything that can run a statement — a pool, or a transaction's connection. */
export type SqlExecutor = {
  query(sql: string, params?: ReadonlyArray<unknown>): Promise<SqlResult>;
};

export type SqlPool = SqlExecutor & {
  /**
   * Run `body` against a dedicated connection, committing on return and
   * rolling back on throw.  The rollback is best-effort: a driver that has
   * already aborted the transaction itself must not mask the original error.
   *
   * **Isolation is adapter-defined.** The pooled SQL adapters give a real
   * `BEGIN … COMMIT`; an HTTP-fronted store (libSQL, Cloudflare D1) may only
   * be able to offer an atomic batch. Callers must therefore not rely on
   * read-your-write isolation *across* statements for correctness — the
   * journal's duplicate-key backstop is what actually upholds the
   * append contract under a concurrent writer.
   */
  withTransaction<T>(body: (transaction: SqlExecutor) => Promise<T>): Promise<T>;
  end(): Promise<void>;
};
