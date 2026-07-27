import type { JournalTableNames, SqlDialect } from './SqlDialect.js';

/**
 * Microsoft SQL Server dialect — `@pN` named placeholders, `MERGE` upserts,
 * and error numbers 2627 / 2601 for a duplicate key.
 *
 * T-SQL diverges from the other dialects in four ways that all had to be
 * encoded rather than worked around:
 *
 *   - **No `IF NOT EXISTS` on DDL.** Table and index creation are guarded with
 *     `IF OBJECT_ID(…) IS NULL` / a `sys.indexes` lookup instead.
 *   - **No `LIMIT`.** Row limiting uses the ANSI
 *     `OFFSET 0 ROWS FETCH NEXT n ROWS ONLY` tail, which is why `rowLimit` is
 *     part of `SqlDialect` at all.
 *   - **No upsert clause.** `MERGE` covers it, always `WITH (HOLDLOCK)`: without
 *     that hint two concurrent merges can both take the `NOT MATCHED` branch
 *     and one fails on the primary key.
 *   - **Index keys are capped.** `NVARCHAR(n)` counts 2n bytes toward a key, so
 *     the tags table's four-column key needs 1036 bytes — over the 900-byte
 *     clustered limit but inside the 1700-byte nonclustered one, hence
 *     `PRIMARY KEY NONCLUSTERED` there (SQL Server 2016+).
 *
 * Identifiers in dialect-owned statements are bracket-quoted.  `timestamp` is a
 * deprecated *type* alias in T-SQL, so leaving it bare in a column definition
 * invites the parser to read it as a type; bracketing sidesteps that whole
 * class of keyword collision.  The statements shared with the other dialects
 * reference columns in unambiguous positions and stay unquoted.
 */

/** Column type for a persistence id / tag — 510 index-key bytes at NVARCHAR(255). */
const KEY_TEXT = 'NVARCHAR(255)';
/** Payloads are unbounded JSON. */
const PAYLOAD_TEXT = 'NVARCHAR(MAX)';

/** `IF OBJECT_ID(…) IS NULL CREATE TABLE …` — T-SQL's `CREATE TABLE IF NOT EXISTS`. */
function createTable(table: string, body: string): string {
  return `IF OBJECT_ID(N'[${table}]', N'U') IS NULL
         CREATE TABLE [${table}] (
${body}
         )`;
}

/** Guarded `CREATE INDEX` — T-SQL has no `IF NOT EXISTS` for indexes either. */
function createIndex(index: string, table: string, columns: string): string {
  return `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'${index}' AND object_id = OBJECT_ID(N'[${table}]'))
         CREATE INDEX [${index}] ON [${table}] (${columns})`;
}

export const msSqlDialect: SqlDialect = {
  name: 'mssql',

  placeholder: (index) => `@p${index + 1}`,

  rowLimit: (count) => `OFFSET 0 ROWS FETCH NEXT ${count} ROWS ONLY`,

  journalDdl: (tables: JournalTableNames) => [
    createTable(tables.events,
      `           [persistence_id] ${KEY_TEXT} NOT NULL,
           [sequence_nr]    BIGINT NOT NULL,
           [payload]        ${PAYLOAD_TEXT} NOT NULL,
           [tags]           ${PAYLOAD_TEXT} NULL,
           [timestamp]      BIGINT NOT NULL,
           CONSTRAINT [PK_${tables.events}] PRIMARY KEY ([persistence_id], [sequence_nr])`),
    createIndex(`idx_${tables.events}_pid`, tables.events, '[persistence_id]'),
    createTable(tables.tags,
      // NONCLUSTERED: the four-column key is 1036 bytes, past the 900-byte
      // clustered limit and inside the 1700-byte nonclustered one.
      `           [persistence_id] ${KEY_TEXT} NOT NULL,
           [sequence_nr]    BIGINT NOT NULL,
           [tag]            ${KEY_TEXT} NOT NULL,
           [timestamp]      BIGINT NOT NULL,
           CONSTRAINT [PK_${tables.tags}] PRIMARY KEY NONCLUSTERED ([tag], [timestamp], [persistence_id], [sequence_nr])`),
    createIndex(`idx_${tables.tags}_pid_seq`, tables.tags, '[persistence_id], [sequence_nr]'),
    createTable(tables.meta,
      `           [persistence_id] ${KEY_TEXT} NOT NULL,
           [deleted_to]     BIGINT NOT NULL,
           CONSTRAINT [PK_${tables.meta}] PRIMARY KEY ([persistence_id])`),
  ],

  snapshotDdl: (table) => [
    createTable(table,
      `           [persistence_id] ${KEY_TEXT} NOT NULL,
           [sequence_nr]    BIGINT NOT NULL,
           [payload]        ${PAYLOAD_TEXT} NOT NULL,
           [timestamp]      BIGINT NOT NULL,
           CONSTRAINT [PK_${table}] PRIMARY KEY ([persistence_id], [sequence_nr])`),
  ],

  durableStateDdl: (table) => [
    createTable(table,
      `           [persistence_id] ${KEY_TEXT} NOT NULL,
           [revision]       BIGINT NOT NULL,
           [payload]        ${PAYLOAD_TEXT} NOT NULL,
           [timestamp]      BIGINT NOT NULL,
           CONSTRAINT [PK_${table}] PRIMARY KEY ([persistence_id])`),
  ],

  // No `INSERT IGNORE` / `ON CONFLICT DO NOTHING` in T-SQL.  `INSERT … SELECT …
  // WHERE NOT EXISTS` is the portable equivalent; the caller ignores the row
  // count, and a genuine race here is impossible because the events row for the
  // same (persistence_id, sequence_nr) would have conflicted first.
  insertTagSql: (tagsTable) =>
    `INSERT INTO [${tagsTable}] ([persistence_id], [sequence_nr], [tag], [timestamp])
         SELECT @p1, @p2, @p3, @p4
          WHERE NOT EXISTS (SELECT 1 FROM [${tagsTable}]
                             WHERE [tag] = @p3 AND [timestamp] = @p4
                               AND [persistence_id] = @p1 AND [sequence_nr] = @p2)`,

  // The `WHEN MATCHED AND …` guard is what makes the mark monotonic; T-SQL has
  // no `GREATEST` before SQL Server 2022, and this reads better than a `CASE`.
  upsertDeletedToSql: (metaTable) =>
    `MERGE INTO [${metaTable}] WITH (HOLDLOCK) AS target
         USING (SELECT @p1 AS [persistence_id], @p2 AS [deleted_to]) AS source
            ON target.[persistence_id] = source.[persistence_id]
          WHEN MATCHED AND target.[deleted_to] < source.[deleted_to]
               THEN UPDATE SET [deleted_to] = source.[deleted_to]
          WHEN NOT MATCHED
               THEN INSERT ([persistence_id], [deleted_to])
                    VALUES (source.[persistence_id], source.[deleted_to]);`,

  upsertSnapshotSql: (snapshotsTable) =>
    `MERGE INTO [${snapshotsTable}] WITH (HOLDLOCK) AS target
         USING (SELECT @p1 AS [persistence_id], @p2 AS [sequence_nr]) AS source
            ON target.[persistence_id] = source.[persistence_id]
           AND target.[sequence_nr] = source.[sequence_nr]
          WHEN MATCHED THEN UPDATE SET [payload] = @p3, [timestamp] = @p4
          WHEN NOT MATCHED
               THEN INSERT ([persistence_id], [sequence_nr], [payload], [timestamp])
                    VALUES (@p1, @p2, @p3, @p4);`,

  pruneSnapshotsStatement: (snapshotsTable) => ({
    // `TOP (@p2)` accepts a parameter when parenthesized, and a named parameter
    // can be referenced twice — so the persistence id is bound once.
    sql: `DELETE FROM [${snapshotsTable}] WHERE [persistence_id] = @p1 AND [sequence_nr] NOT IN (
             SELECT TOP (@p2) [sequence_nr] FROM [${snapshotsTable}]
              WHERE [persistence_id] = @p1 ORDER BY [sequence_nr] DESC)`,
    params: (persistenceId, keepN) => [persistenceId, keepN],
  }),

  // A plain INSERT rather than a MERGE or `WHERE NOT EXISTS`: both of those
  // would still have to handle the duplicate-key race, so letting the primary
  // key report it is both shorter and correct under concurrency.
  insertStateSql: (table) =>
    `INSERT INTO [${table}] ([persistence_id], [revision], [payload], [timestamp])
         VALUES (@p1, @p2, @p3, @p4)`,

  stateInsertConflictSignal: 'duplicate-key-error',

  /**
   * 2627 is a primary-key / unique-constraint violation, 2601 a duplicate key
   * in a unique index.
   */
  isDuplicateKeyError: (error) => hasErrorNumber(error, new Set([2627, 2601])),
  // 1205 is the deadlock victim ("chosen as the deadlock victim; rerun the
  // transaction"); 1222 is a lock-request timeout (#479).
  isSerializationConflictError: (error) => hasErrorNumber(error, new Set([1205, 1222])),
};

/**
 * True when the error carries one of `numbers` as its T-SQL error number.
 * The `mssql` driver surfaces the number on the error itself, but wraps the
 * tedious error for some failures, so the original is checked too.
 */
function hasErrorNumber(error: unknown, numbers: ReadonlySet<number>): boolean {
  const candidate = error as { number?: unknown; originalError?: { info?: { number?: unknown } } };
  if (typeof candidate.number === 'number' && numbers.has(candidate.number)) return true;
  const original = candidate.originalError?.info?.number;
  return typeof original === 'number' && numbers.has(original);
}
