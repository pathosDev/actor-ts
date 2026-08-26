import type { JournalTableNames, SqlDialect } from './SqlDialect.js';

/**
 * MariaDB / MySQL dialect — `?` placeholders, `INSERT IGNORE` and
 * `ON DUPLICATE KEY UPDATE`, errno `1062` for a duplicate key.
 *
 * Two divergences from Postgres are structural rather than cosmetic:
 *
 *   - the `keepN` prune needs its subquery wrapped in a derived table, because
 *     MySQL/MariaDB reject `LIMIT` inside a bare `IN (SELECT …)` against the
 *     table being deleted from — and the persistence id must then be bound
 *     twice;
 *   - the durable-state insert is unguarded, so a collision arrives as a
 *     thrown duplicate-key error instead of zero affected rows.  Adding
 *     `IGNORE` would swallow unrelated errors too, which is why the dialect
 *     declares the signal instead of forcing the Postgres shape.
 */
export const mariaDbDialect: SqlDialect = {
  name: 'mariadb',

  placeholder: () => '?',

  rowLimit: (count) => `LIMIT ${count}`,

  journalDdl: (tables: JournalTableNames) => [
    // Indexes are declared inline: `CREATE INDEX IF NOT EXISTS` is not
    // portable across MariaDB/MySQL versions, but inline `INDEX` is.
    `CREATE TABLE IF NOT EXISTS ${tables.events} (
           persistence_id VARCHAR(255) NOT NULL,
           sequence_nr    BIGINT NOT NULL,
           payload        LONGTEXT NOT NULL,
           tags           TEXT,
           timestamp      BIGINT NOT NULL,
           PRIMARY KEY (persistence_id, sequence_nr),
           INDEX idx_${tables.events}_pid (persistence_id)
         )`,
    `CREATE TABLE IF NOT EXISTS ${tables.tags} (
           persistence_id VARCHAR(255) NOT NULL,
           sequence_nr    BIGINT NOT NULL,
           tag            VARCHAR(255) NOT NULL,
           timestamp      BIGINT NOT NULL,
           PRIMARY KEY (tag, timestamp, persistence_id, sequence_nr),
           INDEX idx_${tables.tags}_pid_seq (persistence_id, sequence_nr)
         )`,
    `CREATE TABLE IF NOT EXISTS ${tables.meta} (
           persistence_id VARCHAR(255) NOT NULL,
           deleted_to     BIGINT NOT NULL,
           PRIMARY KEY (persistence_id)
         )`,
  ],

  snapshotDdl: (table) => [
    `CREATE TABLE IF NOT EXISTS ${table} (
           persistence_id VARCHAR(255) NOT NULL,
           sequence_nr    BIGINT NOT NULL,
           payload        LONGTEXT NOT NULL,
           timestamp      BIGINT NOT NULL,
           PRIMARY KEY (persistence_id, sequence_nr)
         )`,
  ],

  durableStateDdl: (table) => [
    `CREATE TABLE IF NOT EXISTS ${table} (
           persistence_id VARCHAR(255) NOT NULL,
           revision       BIGINT NOT NULL,
           payload        LONGTEXT NOT NULL,
           timestamp      BIGINT NOT NULL,
           PRIMARY KEY (persistence_id)
         )`,
  ],

  storageIdentityDdl: (table) => [
    `CREATE TABLE IF NOT EXISTS ${table} (
           singleton INT NOT NULL,
           identity  VARCHAR(64) NOT NULL,
           PRIMARY KEY (singleton)
         )`,
  ],

  insertTagSql: (tagsTable) =>
    `INSERT IGNORE INTO ${tagsTable}(persistence_id, sequence_nr, tag, timestamp) VALUES (?, ?, ?, ?)`,

  upsertDeletedToSql: (metaTable) =>
    `INSERT INTO ${metaTable}(persistence_id, deleted_to) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE deleted_to = GREATEST(deleted_to, VALUES(deleted_to))`,

  upsertSnapshotSql: (snapshotsTable) =>
    `INSERT INTO ${snapshotsTable}(persistence_id, sequence_nr, payload, timestamp) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE payload = VALUES(payload), timestamp = VALUES(timestamp)`,

  pruneSnapshotsStatement: (snapshotsTable) => ({
    sql: `DELETE FROM ${snapshotsTable} WHERE persistence_id = ? AND sequence_nr NOT IN (
             SELECT keep_seq FROM (
               SELECT sequence_nr AS keep_seq FROM ${snapshotsTable} WHERE persistence_id = ? ORDER BY sequence_nr DESC LIMIT ?
             ) AS keep)`,
    // The persistence id is bound twice — once for the DELETE, once inside
    // the derived table.
    params: (persistenceId, keepN) => [persistenceId, persistenceId, keepN],
  }),

  insertStateSql: (table) =>
    `INSERT INTO ${table}(persistence_id, revision, payload, timestamp) VALUES (?, ?, ?, ?)`,

  stateInsertConflictSignal: 'duplicate-key-error',

  // errno 1062 / `ER_DUP_ENTRY`.
  isDuplicateKeyError: (error) => {
    const candidate = error as { errno?: number; code?: string };
    return candidate.errno === 1062 || candidate.code === 'ER_DUP_ENTRY';
  },
  // 1020 `ER_CHECKREAD` is the one that actually bites: InnoDB aborts the
  // losing writer with "Record has changed since last read" before the
  // duplicate key is ever checked (#479).  1213/1205 round out the family —
  // a deadlock victim and a lock-wait timeout are the same "you lost, retry"
  // signal wearing different numbers.
  isSerializationConflictError: (error) => {
    const candidate = error as { errno?: number; code?: string };
    const codes = new Set(['ER_CHECKREAD', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);
    return (candidate.errno !== undefined && new Set([1020, 1213, 1205]).has(candidate.errno))
      || (candidate.code !== undefined && codes.has(candidate.code));
  },
};
