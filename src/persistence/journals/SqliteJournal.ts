import { getSqliteDriver, type SqliteDb, type SqliteStatement } from '../../runtime/sqlite/index.js';
import { InProcessJournalEventBus, type JournalEventBus } from '../JournalEventBus.js';
import type { Journal } from '../Journal.js';
import {
  JournalConcurrencyError,
  JournalError,
  type PersistentEvent,
} from '../JournalTypes.js';
import { assertSafeIdentifier } from '../storage/SqlIdentifier.js';
import type { SqliteJournalOptions, SqliteJournalOptionsType } from './SqliteJournalOptions.js';

interface Stmts {
  insert: SqliteStatement;
  insertTag: SqliteStatement;
  readAll: SqliteStatement;
  readRange: SqliteStatement;
  highestSeq: SqliteStatement;
  deleteUpTo: SqliteStatement;
  deleteTagsUpTo: SqliteStatement;
  persistenceIds: SqliteStatement;
  /** Used by the tags-table backfill at startup. */
  countTags: SqliteStatement;
  /** Iterates events that still have CSV tags but no row in the tag table. */
  rowsWithCsvTags: SqliteStatement;
}

/**
 * Journal backed by SQLite — zero-dependency, single-file persistence.
 *
 * Works on Bun (`bun:sqlite`) and Node.js (`better-sqlite3`) via the
 * `SqliteDriver` abstraction in `src/runtime/sqlite/`.  Both backends
 * share the same prepared-statement + transaction shape, so the journal
 * code itself is unchanged across runtimes.
 *
 * Construction is lazy: the native DB is opened on the first `append` /
 * `read` / `highestSeq` / `delete` / `persistenceIds` call.  This keeps
 * `new SqliteJournal(SqliteJournalOptions.create().withPath(path))`
 * sync-friendly (matches the pre-abstraction shape) while still
 * supporting the async driver-resolution flow Node requires.
 */
export class SqliteJournal implements Journal {
  private readonly options: SqliteJournalOptionsType;
  private readonly table: string;
  private readonly closed = { value: false };
  /**
   * In-process event bus — published-to inside `append` so the query
   * layer can do sub-poll-interval push delivery in the same process.
   * Cross-process subscribers (separate Bun/Node instance reading
   * the same SQLite file) still need to poll; that's the inherent
   * limit of in-process notifications.
   */
  readonly events: JournalEventBus = new InProcessJournalEventBus();

  private db: SqliteDb | null = null;
  private stmts: Stmts | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(options: SqliteJournalOptions = {}) {
    const resolvedOptions = (options as SqliteJournalOptionsType);
    this.options = resolvedOptions;
    // Table name is interpolated into DDL/DML (can't be bound) — validate it
    // so a config-sourced identifier can't inject SQL (security audit #6).
    // The `_tags` sibling is derived from this validated name, so it's safe too.
    this.table = assertSafeIdentifier(resolvedOptions.eventsTable ?? 'events', 'events table');
  }

  async append<E>(
    persistenceId: string,
    events: ReadonlyArray<E>,
    expectedSeq: number,
    tags?: ReadonlyArray<string>,
  ): Promise<PersistentEvent<E>[]> {
    await this.ensureOpen();
    if (events.length === 0) return [];
    const db = this.db!;
    const stmts = this.stmts!;
    const now = Date.now();
    const txn = db.transaction((items: unknown[]) => {
      const row = stmts.highestSeq.get(persistenceId) as { hi: number | null } | undefined;
      const actualSeq = row?.hi ?? 0;
      if (actualSeq !== expectedSeq) {
        throw new JournalConcurrencyError(persistenceId, expectedSeq, actualSeq);
      }
      const out: PersistentEvent<E>[] = [];
      let seq = actualSeq;
      for (const ev of items as E[]) {
        seq++;
        const payload = JSON.stringify(ev);
        const tagString = tags && tags.length ? tags.join(',') : null;
        stmts.insert.run(persistenceId, seq, payload, tagString, now);
        // Also populate the tags join table so SqliteQuery's
        // tag-search can do an indexed lookup instead of a CSV scan.
        // Both inserts run inside the same transaction — partial
        // writes are impossible.
        if (tags) {
          for (const tag of tags) {
            if (tag.length === 0) continue;
            stmts.insertTag.run(persistenceId, seq, tag, now);
          }
        }
        out.push({
          persistenceId: persistenceId,
          sequenceNr: seq,
          event: ev,
          timestamp: now,
          tags: tags ? [...tags] : undefined,
        });
      }
      return out;
    });
    let written: PersistentEvent<E>[];
    try {
      written = txn([...events] as never[]);
    } catch (e) {
      if (e instanceof JournalConcurrencyError) throw e;
      throw new JournalError(`SqliteJournal.append failed: ${(e as Error).message}`, e);
    }
    // Publish AFTER the transaction commits so subscribers that
    // re-read see the events they were notified about.
    for (const pe of written) this.events.publish(pe as PersistentEvent<unknown>);
    return written;
  }

  async read<E>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    await this.ensureOpen();
    const stmts = this.stmts!;
    try {
      const rows = toSeq === undefined
        ? (stmts.readAll.all(persistenceId, fromSeq) as Array<{
            persistence_id: string;
            sequence_nr: number;
            payload: string;
            tags: string | null;
            timestamp: number;
          }>)
        : (stmts.readRange.all(persistenceId, fromSeq, toSeq) as Array<{
            persistence_id: string;
            sequence_nr: number;
            payload: string;
            tags: string | null;
            timestamp: number;
          }>);
      return rows.map(r => ({
        persistenceId: r.persistence_id,
        sequenceNr: r.sequence_nr,
        event: JSON.parse(r.payload) as E,
        timestamp: r.timestamp,
        tags: r.tags ? r.tags.split(',') : undefined,
      }));
    } catch (e) {
      throw new JournalError(`SqliteJournal.read failed: ${(e as Error).message}`, e);
    }
  }

  async highestSeq(persistenceId: string): Promise<number> {
    await this.ensureOpen();
    const row = this.stmts!.highestSeq.get(persistenceId) as { hi: number | null } | undefined;
    return row?.hi ?? 0;
  }

  async delete(persistenceId: string, toSeq: number): Promise<void> {
    await this.ensureOpen();
    // Order matters: delete from the tags-table FIRST so that a
    // crash mid-delete leaves an inconsistent state where tags exist
    // for events that don't — recoverable via a manual cleanup or a
    // future backfill.  Doing it the other way around would produce
    // events with missing tags, which the JOIN-based query path
    // would silently miss.
    this.stmts!.deleteTagsUpTo.run(persistenceId, toSeq);
    this.stmts!.deleteUpTo.run(persistenceId, toSeq);
  }

  async persistenceIds(): Promise<string[]> {
    await this.ensureOpen();
    const rows = this.stmts!.persistenceIds.all() as Array<{ persistence_id: string }>;
    return rows.map(r => r.persistence_id);
  }

  async close(): Promise<void> {
    if (this.closed.value) return;
    this.closed.value = true;
    try { this.db?.close(); } catch { /* ignore */ }
  }

  /* --------------------------- internals -------------------------------- */

  private async ensureOpen(): Promise<void> {
    if (this.closed.value) throw new JournalError('SqliteJournal is closed');
    if (this.db && this.stmts) return;
    if (!this.initPromise) this.initPromise = this.init();
    await this.initPromise;
  }

  private async init(): Promise<void> {
    const driver = this.options.driver ?? await getSqliteDriver();
    const db = driver.open(this.options.path ?? ':memory:');
    const tagsTable = `${this.table}_tags`;
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        persistence_id TEXT NOT NULL,
        sequence_nr    INTEGER NOT NULL,
        payload        TEXT NOT NULL,
        tags           TEXT,
        timestamp      INTEGER NOT NULL,
        PRIMARY KEY (persistence_id, sequence_nr)
      );
      CREATE INDEX IF NOT EXISTS idx_${this.table}_pid ON ${this.table}(persistence_id);
      CREATE TABLE IF NOT EXISTS ${tagsTable} (
        persistence_id TEXT NOT NULL,
        sequence_nr    INTEGER NOT NULL,
        tag            TEXT NOT NULL,
        timestamp      INTEGER NOT NULL,
        PRIMARY KEY (tag, timestamp, persistence_id, sequence_nr)
      );
      CREATE INDEX IF NOT EXISTS idx_${tagsTable}_pid_seq ON ${tagsTable}(persistence_id, sequence_nr);
    `);
    if (this.options.wal) db.exec('PRAGMA journal_mode = WAL;');

    this.stmts = {
      insert: db.prepare(
        `INSERT INTO ${this.table}(persistence_id, sequence_nr, payload, tags, timestamp) VALUES (?, ?, ?, ?, ?)`,
      ),
      insertTag: db.prepare(
        `INSERT OR IGNORE INTO ${tagsTable}(persistence_id, sequence_nr, tag, timestamp) VALUES (?, ?, ?, ?)`,
      ),
      readAll: db.prepare(
        `SELECT persistence_id, sequence_nr, payload, tags, timestamp FROM ${this.table} WHERE persistence_id = ? AND sequence_nr >= ? ORDER BY sequence_nr ASC`,
      ),
      readRange: db.prepare(
        `SELECT persistence_id, sequence_nr, payload, tags, timestamp FROM ${this.table} WHERE persistence_id = ? AND sequence_nr >= ? AND sequence_nr <= ? ORDER BY sequence_nr ASC`,
      ),
      highestSeq: db.prepare(
        `SELECT MAX(sequence_nr) AS hi FROM ${this.table} WHERE persistence_id = ?`,
      ),
      deleteUpTo: db.prepare(
        `DELETE FROM ${this.table} WHERE persistence_id = ? AND sequence_nr <= ?`,
      ),
      deleteTagsUpTo: db.prepare(
        `DELETE FROM ${tagsTable} WHERE persistence_id = ? AND sequence_nr <= ?`,
      ),
      persistenceIds: db.prepare(
        `SELECT DISTINCT persistence_id FROM ${this.table}`,
      ),
      countTags: db.prepare(
        `SELECT COUNT(*) AS n FROM ${tagsTable}`,
      ),
      rowsWithCsvTags: db.prepare(
        `SELECT persistence_id, sequence_nr, tags, timestamp FROM ${this.table} WHERE tags IS NOT NULL AND tags <> ''`,
      ),
    };
    this.db = db;

    // Backfill — for databases written by SqliteJournal v0 (before
    // this commit) the tags table doesn't exist yet, OR exists empty
    // because the user upgraded the dependency.  Populate it from
    // the CSV column once.  Idempotent: if the tags table already
    // has rows, this skips entirely.
    this.backfillTagsTableIfNeeded(db);
  }

  /**
   * One-shot backfill of the tags join table from the legacy CSV
   * `tags` column.  Runs at most once per init — when `event_tags`
   * is empty AND the `events` table still has tagged rows we'd
   * otherwise leave un-indexed.  Re-running is a no-op (the count
   * check skips it) and the underlying inserts use `INSERT OR
   * IGNORE` as a defence-in-depth so a partial backfill that gets
   * interrupted can be resumed without duplicate-key errors.
   */
  private backfillTagsTableIfNeeded(db: SqliteDb): void {
    const stmts = this.stmts!;
    const tagsCount = (stmts.countTags.get() as { n: number } | undefined)?.n ?? 0;
    if (tagsCount > 0) return;

    type CsvRow = {
      persistence_id: string;
      sequence_nr: number;
      tags: string;
      timestamp: number;
    };
    const rows = stmts.rowsWithCsvTags.all() as CsvRow[];
    if (rows.length === 0) return;

    const fill = db.transaction((items: CsvRow[]) => {
      for (const row of items) {
        const tagList = row.tags.split(',').filter((t) => t.length > 0);
        for (const tag of tagList) {
          stmts.insertTag.run(row.persistence_id, row.sequence_nr, tag, row.timestamp);
        }
      }
    });
    fill(rows);
  }
}
