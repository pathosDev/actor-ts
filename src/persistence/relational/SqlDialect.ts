/**
 * What actually differs between two SQL databases, once the plumbing is
 * behind `SqlPool` (#389).
 *
 * `PostgresJournal` and `MariaDbJournal` were ~73 % line-identical, so every
 * fix had to be applied two to four times — and did not always get applied
 * everywhere.  A dialect isolates the genuine divergences:
 *
 *   - **placeholder syntax** — `$1` / `?` / `@p1`;
 *   - **conflict clauses** — `ON CONFLICT DO NOTHING` vs `INSERT IGNORE`,
 *     `ON CONFLICT … DO UPDATE` vs `ON DUPLICATE KEY UPDATE`;
 *   - **statements that differ structurally**, not just in punctuation (the
 *     `keepN` prune needs a derived table on MySQL/MariaDB and therefore a
 *     different parameter list);
 *   - **how a duplicate key is reported** — SQLSTATE `23505`, errno `1062`;
 *   - **how a contention abort is reported** — SQLSTATE `40001`, errno `1213`;
 *   - **column types** in the DDL.
 *
 * Everything else is written once in the relational bases as canonical `?`
 * SQL and expanded through `placeholder`.  Adding a SQL backend is then a
 * dialect object plus a `SqlPool` adapter, rather than a third full copy of
 * three stores.
 */

/** The three tables a relational journal owns. */
export type JournalTableNames = {
  readonly events: string;
  readonly tags: string;
  /** Holds the compaction high-water mark (`deleted_to`) per persistence id. */
  readonly meta: string;
};

/** How a dialect signals that a conditional insert hit an existing row. */
export type InsertConflictSignal =
  /** The insert carries an ignore/do-nothing clause; zero affected rows means conflict. */
  | 'affected-rows'
  /** The insert is unguarded; the driver throws a duplicate-key error. */
  | 'duplicate-key-error';

export type SqlDialect = {
  /** Diagnostic label — `'postgres'`, `'mariadb'`, `'sqlite'`, … */
  readonly name: string;

  /** Placeholder text for a zero-based parameter index: `$1` / `?` / `@p1`. */
  placeholder(index: number): string;

  /**
   * Trailing clause that caps a `SELECT` at `count` rows.
   *
   * Row limiting is the most famously non-standard corner of SQL: `LIMIT n`
   * on Postgres, MySQL and SQLite, but T-SQL has no `LIMIT` at all and needs
   * either `TOP` (before the select list) or the ANSI
   * `OFFSET … FETCH NEXT … ROWS ONLY` (after `ORDER BY`).  Returning the
   * trailing form keeps the shared statements' shape intact for every dialect.
   */
  rowLimit(count: number): string;

  /* ------------------------------- DDL ---------------------------------- */

  /**
   * Statements that create the journal's tables and indexes.  An array
   * because Postgres emits separate `CREATE INDEX IF NOT EXISTS` statements
   * while MariaDB declares indexes inline (`CREATE INDEX IF NOT EXISTS` is
   * not portable across MySQL/MariaDB versions).
   */
  journalDdl(tables: JournalTableNames): string[];
  snapshotDdl(table: string): string[];
  durableStateDdl(table: string): string[];

  /* -------------------------- dialect-owned DML ------------------------- */

  /** Tag-row insert that silently skips a row that already exists. */
  insertTagSql(tagsTable: string): string;
  /** Monotonic `deleted_to` upsert — must never lower the stored mark. */
  upsertDeletedToSql(metaTable: string): string;
  /** Snapshot upsert keyed on `(persistence_id, sequence_nr)`. */
  upsertSnapshotSql(snapshotsTable: string): string;
  /** Prune-on-save: keep the newest `keepN` snapshots for one persistence id. */
  pruneSnapshotsStatement(snapshotsTable: string): {
    readonly sql: string;
    params(persistenceId: string, keepN: number): unknown[];
  };
  /**
   * Durable-state insert for `expectedRevision === 0`, paired with
   * `stateInsertConflictSignal` so the base knows how a collision surfaces.
   */
  insertStateSql(table: string): string;
  readonly stateInsertConflictSignal: InsertConflictSignal;

  /* -------------------------- error classification ---------------------- */

  /**
   * True when `error` is a unique/primary-key violation.  This is the
   * backstop that makes the journal's optimistic concurrency correct under a
   * racing writer, so it must match on driver error *codes* rather than
   * message text (Postgres-wire-compatible databases such as CockroachDB and
   * YugabyteDB word the message differently but keep the SQLSTATE).
   */
  isDuplicateKeyError(error: unknown): boolean;

  /**
   * True when `error` is the engine aborting a transaction to resolve
   * contention — a serialization failure, deadlock victim, or lock-wait
   * timeout — rather than a constraint violation.
   *
   * The duplicate-key backstop above assumes the losing writer gets far
   * enough to violate the primary key, and that is not guaranteed: under real
   * contention MariaDB aborts the loser with errno 1020 (`ER_CHECKREAD`)
   * *before* the insert is checked, so the race surfaced as an opaque
   * `JournalError` instead of `JournalConcurrencyError` and callers could no
   * longer tell a retryable race from a storage failure (#479).
   *
   * A conflict alone does not prove a race, so the bases never translate on
   * this predicate alone — they re-read the head and only report a
   * concurrency error when it actually moved.  That keeps an ordinary lock
   * problem (a long-running unrelated transaction) from being relabelled as
   * someone else's append.
   */
  isSerializationConflictError(error: unknown): boolean;
};

/**
 * Rewrite canonical `?` placeholders into `dialect`'s syntax, in order.
 *
 * The bases write every shared statement with `?` and one placeholder per
 * parameter, used exactly once and left to right — which is what makes a
 * positional rewrite sufficient.  None of those statements contains a `?`
 * inside a string literal; a dialect-owned statement is the right home for
 * anything that would.
 */
export function expandPlaceholders(canonicalSql: string, dialect: SqlDialect): string {
  let index = 0;
  return canonicalSql.replace(/\?/g, () => dialect.placeholder(index++));
}
