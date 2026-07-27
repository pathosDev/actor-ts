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
 *   - **column types** in the DDL.
 *
 * Everything else is written once in the relational bases as canonical `?`
 * SQL and expanded through `placeholder`.  Adding a SQL backend is then a
 * dialect object plus a `SqlPool` adapter, rather than a third full copy of
 * three stores.
 */

/** The three tables a relational journal owns. */
export interface JournalTableNames {
  readonly events: string;
  readonly tags: string;
  /** Holds the compaction high-water mark (`deleted_to`) per persistence id. */
  readonly meta: string;
}

/** How a dialect signals that a conditional insert hit an existing row. */
export type InsertConflictSignal =
  /** The insert carries an ignore/do-nothing clause; zero affected rows means conflict. */
  | 'affected-rows'
  /** The insert is unguarded; the driver throws a duplicate-key error. */
  | 'duplicate-key-error';

export interface SqlDialect {
  /** Diagnostic label — `'postgres'`, `'mariadb'`, `'sqlite'`, … */
  readonly name: string;

  /** Placeholder text for a zero-based parameter index: `$1` / `?` / `@p1`. */
  placeholder(index: number): string;

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
}

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
