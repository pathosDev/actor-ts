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

export interface SqlDialect {
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
  /**
   * Statements that create the one-row `storage_identity` table naming the
   * database instance (#1358).  Optional: a dialect without it leaves the
   * relational family's `storageIdentity()` rejecting, which callers treat
   * as unknown rather than fatal.
   */
  storageIdentityDdl?(table: string): string[];

  /* ----------------------------- catalogue ------------------------------ */

  /**
   * Statement reading the declared collation of one table's columns back out
   * of the server's catalogue (#1412).
   *
   * The table name is the statement's **only parameter**, not an
   * interpolation, so nothing here needs `assertSafeIdentifier` and the
   * statement is one constant string per dialect.  It must alias its two
   * output columns to `column_name` and `collation_name` — the catalogues
   * disagree on both spelling and case (`information_schema.COLUMNS` shouts,
   * `sys.columns` calls them `name` and `collation_name`) and
   * {@link RelationalStore} reads one shape.  A row for a column that has no
   * collation (a `BIGINT`, a blob) reports `collation_name` as null.
   *
   * Optional, and left undefined by a dialect whose text comparison is
   * byte-exact by construction: Postgres `TEXT` and SQLite have no collation
   * to get wrong, so there is nothing to advise about.
   */
  columnCollationsSql?(): string;

  /* ---------------------------- reachability ---------------------------- */

  /**
   * A statement that needs no table and no privilege beyond a session — the
   * round trip a store's open makes when it runs no DDL (#1473).  Without
   * it, {@link RelationalStore} sends `SELECT 1`.
   *
   * With `autoCreateTables` off nothing else in the open talks to the
   * database: node-postgres and libSQL build their pool or client without
   * connecting, and the collation probe swallows its own failures by design.
   * Without a round trip a store over a database the node cannot reach
   * opened cleanly and failed at its first persisted message.
   *
   * Optional because `SELECT 1` is right on every engine the in-repo
   * dialects serve, which leave it undefined.  A dialect whose SQL cannot
   * select a constant without a table overrides it — `SELECT 1 FROM DUAL`
   * on Oracle, `SELECT 1 FROM SYSIBM.SYSDUMMY1` on Db2.  Only whether it
   * succeeds is read, never its rows.
   */
  pingSql?(): string;

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
}

/**
 * The columns whose *comparison* the relational family depends on, and
 * therefore the only ones {@link SqlDialect.columnCollationsSql} is read for.
 *
 * `persistence_id` is the name of an event stream and half of the events
 * primary key; `tag` keys the projection index.  Everything else a relational
 * store stores is a value that is never compared as a string — the payload,
 * the serialized tag list, the minted `identity` of `storage_identity` — and
 * the DDL leaves those on the server default on purpose, so flagging them
 * would report the intended state as a defect.  That makes this list the
 * classification rather than a tuned value, which is why it sits beside the
 * member it is read through.
 */
export const COLLATION_SENSITIVE_COLUMNS: ReadonlySet<string> = new Set(['persistence_id', 'tag']);

/**
 * The name segments that mean "compare code point by code point".
 *
 * Matched on the **shape of the name**, not against the collation this
 * project's DDL happens to pin, and that distinction is the whole point
 * (#1412).  `utf8mb4_nopad_bin` is a MariaDB operator's deliberately
 * *stricter* choice, `utf8mb4_0900_bin` is what MySQL 8 offers, SQL Server
 * has a whole `*_BIN2` family and TiDB pins its own (#1127) — a rule of the
 * shape "not the collation we write" would nag every one of those on every
 * start, which is how an advisory trains people to ignore it.  `binary` is
 * the collation MySQL/MariaDB report for a column on the `binary` charset,
 * and it is a whole name rather than a trailing token, which is why the three
 * live in one set read against segments.
 */
const BINARY_COLLATION_SEGMENTS: ReadonlySet<string> = new Set(['bin', 'bin2', 'binary']);

/**
 * Segments a server may append **after** the binary token without changing
 * what the comparison is.
 *
 * SQL Server 2019 added a UTF-8 encoding to the collation grammar, and it is
 * spelled as a suffix: `Latin1_General_100_BIN2_UTF8` is the same ordinal
 * comparison as `Latin1_General_100_BIN2` over UTF-8 storage.  A rule anchored
 * on the *end* of the name therefore classified the strictest choice the
 * server offers as folding and advised an operator who had already done the
 * migration — the exact nag this advisory is gated against.  A set rather than
 * one more literal in a pattern, because the grammar is "binary token, then
 * encoding flags": the next one goes here.
 */
const COLLATION_ENCODING_SUFFIXES: ReadonlySet<string> = new Set(['utf8']);

/**
 * True when `collation` compares code point by code point, so two ids
 * differing in case or accent stay two ids.
 *
 * Read over `_`-separated segments rather than as one pattern: that is the
 * structure every one of these servers actually names collations with, so a
 * token that moves off the end of the name (`…_BIN2_UTF8`) stays recognisable
 * without the rule being rewritten around it.  Anything after the binary token
 * that is *not* a known encoding flag makes the answer `false` — an unfamiliar
 * name is better advised about once than silently trusted.
 */
export function isBinaryCollation(collation: string): boolean {
  const segments = collation.toLowerCase().split('_');
  const binaryIndex = segments.findIndex((segment) => BINARY_COLLATION_SEGMENTS.has(segment));
  if (binaryIndex === -1) return false;
  return segments.slice(binaryIndex + 1).every((segment) => COLLATION_ENCODING_SUFFIXES.has(segment));
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
