import type { JournalTableNames, SqlDialect } from './SqlDialect.js';

/**
 * PostgreSQL dialect — `$n` placeholders, `ON CONFLICT` upserts, SQLSTATE
 * `23505` for a unique violation.
 *
 * Matching on the SQLSTATE rather than the message text is what lets the
 * Postgres stores serve the wire-compatible databases too (CockroachDB,
 * YugabyteDB), which reword the message but keep the code.
 */
export const postgresDialect: SqlDialect = {
  name: 'postgres',

  placeholder: (index) => `$${index + 1}`,

  rowLimit: (count) => `LIMIT ${count}`,

  journalDdl: (tables: JournalTableNames) => [
    `CREATE TABLE IF NOT EXISTS ${tables.events} (
           persistence_id TEXT NOT NULL,
           sequence_nr    BIGINT NOT NULL,
           payload        TEXT NOT NULL,
           tags           TEXT,
           timestamp      BIGINT NOT NULL,
           PRIMARY KEY (persistence_id, sequence_nr)
         )`,
    `CREATE INDEX IF NOT EXISTS idx_${tables.events}_pid ON ${tables.events}(persistence_id)`,
    `CREATE TABLE IF NOT EXISTS ${tables.tags} (
           persistence_id TEXT NOT NULL,
           sequence_nr    BIGINT NOT NULL,
           tag            TEXT NOT NULL,
           timestamp      BIGINT NOT NULL,
           PRIMARY KEY (tag, timestamp, persistence_id, sequence_nr)
         )`,
    `CREATE INDEX IF NOT EXISTS idx_${tables.tags}_pid_seq ON ${tables.tags}(persistence_id, sequence_nr)`,
    `CREATE TABLE IF NOT EXISTS ${tables.meta} (
           persistence_id TEXT PRIMARY KEY,
           deleted_to     BIGINT NOT NULL
         )`,
  ],

  snapshotDdl: (table) => [
    `CREATE TABLE IF NOT EXISTS ${table} (
           persistence_id TEXT NOT NULL,
           sequence_nr    BIGINT NOT NULL,
           payload        TEXT NOT NULL,
           timestamp      BIGINT NOT NULL,
           PRIMARY KEY (persistence_id, sequence_nr)
         )`,
  ],

  durableStateDdl: (table) => [
    `CREATE TABLE IF NOT EXISTS ${table} (
           persistence_id TEXT PRIMARY KEY,
           revision       BIGINT NOT NULL,
           payload        TEXT NOT NULL,
           timestamp      BIGINT NOT NULL
         )`,
  ],

  insertTagSql: (tagsTable) =>
    `INSERT INTO ${tagsTable}(persistence_id, sequence_nr, tag, timestamp) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,

  upsertDeletedToSql: (metaTable) =>
    `INSERT INTO ${metaTable}(persistence_id, deleted_to) VALUES ($1, $2)
         ON CONFLICT (persistence_id) DO UPDATE SET deleted_to = GREATEST(${metaTable}.deleted_to, EXCLUDED.deleted_to)`,

  upsertSnapshotSql: (snapshotsTable) =>
    `INSERT INTO ${snapshotsTable}(persistence_id, sequence_nr, payload, timestamp) VALUES ($1, $2, $3, $4)
         ON CONFLICT (persistence_id, sequence_nr) DO UPDATE SET payload = EXCLUDED.payload, timestamp = EXCLUDED.timestamp`,

  pruneSnapshotsStatement: (snapshotsTable) => ({
    // `$1` is bound once and referenced by both the DELETE and the subquery.
    sql: `DELETE FROM ${snapshotsTable} WHERE persistence_id = $1 AND sequence_nr NOT IN (
             SELECT sequence_nr FROM ${snapshotsTable} WHERE persistence_id = $1 ORDER BY sequence_nr DESC LIMIT $2)`,
    params: (persistenceId, keepN) => [persistenceId, keepN],
  }),

  insertStateSql: (table) =>
    `INSERT INTO ${table}(persistence_id, revision, payload, timestamp) VALUES ($1, $2, $3, $4)
           ON CONFLICT (persistence_id) DO NOTHING`,

  stateInsertConflictSignal: 'affected-rows',

  isDuplicateKeyError: (error) => (error as { code?: string }).code === '23505',
  // `40001` serialization_failure and `40P01` deadlock_detected.  Postgres
  // reaches the duplicate key under READ COMMITTED, so today it never gets
  // here — but a caller running the journal at SERIALIZABLE would, and the
  // wire-compatible engines (CockroachDB, YugabyteDB) retry-abort far more
  // eagerly than Postgres does.  Classified now so they behave (#479).
  isSerializationConflictError: (error) => {
    const code = (error as { code?: string }).code;
    return code === '40001' || code === '40P01';
  },
};
