import type { JournalTableNames, SqlDialect } from './SqlDialect.js';

/**
 * SQLite dialect for the relational bases — `?` placeholders, `INSERT OR
 * IGNORE`, `ON CONFLICT(col) DO UPDATE … excluded.…`, and `SQLITE_CONSTRAINT`
 * for a uniqueness violation.
 *
 * This exists for the **remote** SQLite-compatible services — libSQL/Turso
 * today, Cloudflare D1 next — not for a local file.  A local database is
 * served better by `SqliteJournal`, which talks to the synchronous
 * `SqliteDriver` and can keep prepared statements alive across calls; a
 * service reached over HTTP is async and pays a round-trip per statement, so it
 * belongs on the same base as Postgres and MariaDB.
 *
 * The statements mirror `SqliteJournal`'s almost verbatim, which is what makes
 * the two schema-compatible: a local file can be pushed to Turso, or a Turso
 * database pulled down and opened locally, without a migration.
 *
 * One deliberate difference: the snapshot upsert is `ON CONFLICT … DO UPDATE`
 * rather than `SqliteJournal`'s `INSERT OR REPLACE`.  Both overwrite, but
 * `INSERT OR REPLACE` deletes and re-inserts the row, so it would fire delete
 * triggers and renumber `rowid` — needless surprise for a remote database a
 * user may have attached their own triggers to.
 */
export const sqliteDialect: SqlDialect = {
  name: 'sqlite',

  placeholder: () => '?',

  rowLimit: (count) => `LIMIT ${count}`,

  journalDdl: (tables: JournalTableNames) => [
    `CREATE TABLE IF NOT EXISTS ${tables.events} (
           persistence_id TEXT NOT NULL,
           sequence_nr    INTEGER NOT NULL,
           payload        TEXT NOT NULL,
           tags           TEXT,
           timestamp      INTEGER NOT NULL,
           PRIMARY KEY (persistence_id, sequence_nr)
         )`,
    `CREATE INDEX IF NOT EXISTS idx_${tables.events}_pid ON ${tables.events}(persistence_id)`,
    `CREATE TABLE IF NOT EXISTS ${tables.tags} (
           persistence_id TEXT NOT NULL,
           sequence_nr    INTEGER NOT NULL,
           tag            TEXT NOT NULL,
           timestamp      INTEGER NOT NULL,
           PRIMARY KEY (tag, timestamp, persistence_id, sequence_nr)
         )`,
    `CREATE INDEX IF NOT EXISTS idx_${tables.tags}_pid_seq ON ${tables.tags}(persistence_id, sequence_nr)`,
    `CREATE TABLE IF NOT EXISTS ${tables.meta} (
           persistence_id TEXT PRIMARY KEY,
           deleted_to     INTEGER NOT NULL
         )`,
  ],

  snapshotDdl: (table) => [
    `CREATE TABLE IF NOT EXISTS ${table} (
           persistence_id TEXT NOT NULL,
           sequence_nr    INTEGER NOT NULL,
           payload        TEXT NOT NULL,
           timestamp      INTEGER NOT NULL,
           PRIMARY KEY (persistence_id, sequence_nr)
         )`,
  ],

  durableStateDdl: (table) => [
    `CREATE TABLE IF NOT EXISTS ${table} (
           persistence_id TEXT PRIMARY KEY,
           revision       INTEGER NOT NULL,
           payload        TEXT NOT NULL,
           timestamp      INTEGER NOT NULL
         )`,
  ],

  storageIdentityDdl: (table) => [
    `CREATE TABLE IF NOT EXISTS ${table} (
           singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
           identity  TEXT NOT NULL
         )`,
  ],

  insertTagSql: (tagsTable) =>
    `INSERT OR IGNORE INTO ${tagsTable}(persistence_id, sequence_nr, tag, timestamp) VALUES (?, ?, ?, ?)`,

  upsertDeletedToSql: (metaTable) =>
    `INSERT INTO ${metaTable}(persistence_id, deleted_to) VALUES (?, ?)
         ON CONFLICT(persistence_id) DO UPDATE SET deleted_to = MAX(deleted_to, excluded.deleted_to)`,

  upsertSnapshotSql: (snapshotsTable) =>
    `INSERT INTO ${snapshotsTable}(persistence_id, sequence_nr, payload, timestamp) VALUES (?, ?, ?, ?)
         ON CONFLICT(persistence_id, sequence_nr) DO UPDATE SET payload = excluded.payload, timestamp = excluded.timestamp`,

  pruneSnapshotsStatement: (snapshotsTable) => ({
    // SQLite allows LIMIT inside the subquery, but binds positionally, so the
    // persistence id goes in twice.
    sql: `DELETE FROM ${snapshotsTable} WHERE persistence_id = ? AND sequence_nr NOT IN (
             SELECT sequence_nr FROM ${snapshotsTable} WHERE persistence_id = ? ORDER BY sequence_nr DESC LIMIT ?)`,
    params: (persistenceId, keepN) => [persistenceId, persistenceId, keepN],
  }),

  insertStateSql: (table) =>
    `INSERT INTO ${table}(persistence_id, revision, payload, timestamp) VALUES (?, ?, ?, ?)
           ON CONFLICT(persistence_id) DO NOTHING`,

  stateInsertConflictSignal: 'affected-rows',

  /**
   * SQLite reports every constraint failure through the `SQLITE_CONSTRAINT`
   * family (`SQLITE_CONSTRAINT_PRIMARYKEY`, `_UNIQUE`, …).  The message check
   * is the fallback for transports that forward the text but drop the code —
   * libSQL over HTTP does so for some error shapes.
   */
  isDuplicateKeyError: (error) => {
    const candidate = error as { code?: unknown; message?: unknown };
    if (typeof candidate.code === 'string' && candidate.code.startsWith('SQLITE_CONSTRAINT')) return true;
    return typeof candidate.message === 'string'
      && /UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(candidate.message);
  },
  // SQLite serializes writers with a database-level lock instead of aborting
  // one of them, so a contended writer waits and then proceeds — there is no
  // deadlock victim to classify.  `SQLITE_BUSY` is the closest relative, but
  // it means "the lock did not free in time", not "you lost a race", and the
  // head will not have moved — so translating it would be a lie either way.
  //
  // Revised for #124: the "waits and then proceeds" half is not something
  // SQLite does on its own, it is something this package now arranges.  A
  // handle with `busy_timeout = 0` — which was `bun:sqlite`'s and
  // `node:sqlite`'s default, and therefore what two of the three supported
  // runtimes actually ran — never waits at all, so `SQLITE_BUSY` arrived on
  // the first tick of contention.  `applySqliteBusyTimeout` now sets a
  // non-zero timeout on every handle opened here, which is what makes the
  // sentence above true across all three runtimes.  The conclusion is
  // unchanged and better founded: past that budget the lock genuinely did not
  // free, and a retry-the-read-and-recompute translation would still be
  // wrong.
  isSerializationConflictError: () => false,
};
