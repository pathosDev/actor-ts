import { getSqliteDriver, type SqliteDb, type SqliteDriver, type SqliteStatement } from '../../runtime/sqlite/index.js';
import { InProcessJournalEventBus, type JournalEventBus } from '../JournalEventBus.js';
import type { Journal } from '../Journal.js';
import {
  JournalConcurrencyError,
  JournalError,
  type PersistentEvent,
} from '../JournalTypes.js';

export interface SqliteJournalOptions {
  /** File path (absolute or relative) or ":memory:" for an ephemeral DB. */
  readonly path?: string;
  /** Table name for events.  Default: `events`. */
  readonly eventsTable?: string;
  /** If true, opens the DB with WAL mode enabled. */
  readonly wal?: boolean;
  /**
   * Explicit driver — useful for tests or when you want to pin a
   * specific SQLite backend.  Default: auto-detect via `getSqliteDriver()`
   * (Bun → `bun:sqlite`, Node → `better-sqlite3`).
   */
  readonly driver?: SqliteDriver;
}

interface Stmts {
  insert: SqliteStatement;
  readAll: SqliteStatement;
  readRange: SqliteStatement;
  highestSeq: SqliteStatement;
  deleteUpTo: SqliteStatement;
  pids: SqliteStatement;
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
 * `new SqliteJournal({ path })` sync-friendly (matches the pre-abstraction
 * shape) while still supporting the async driver-resolution flow Node
 * requires.
 */
export class SqliteJournal implements Journal {
  private readonly options: SqliteJournalOptions;
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
    this.options = options;
    this.table = options.eventsTable ?? 'events';
  }

  async append<E>(
    pid: string,
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
      const row = stmts.highestSeq.get(pid) as { hi: number | null } | undefined;
      const actualSeq = row?.hi ?? 0;
      if (actualSeq !== expectedSeq) {
        throw new JournalConcurrencyError(pid, expectedSeq, actualSeq);
      }
      const out: PersistentEvent<E>[] = [];
      let seq = actualSeq;
      for (const ev of items as E[]) {
        seq++;
        const payload = JSON.stringify(ev);
        const tagString = tags && tags.length ? tags.join(',') : null;
        stmts.insert.run(pid, seq, payload, tagString, now);
        out.push({
          persistenceId: pid,
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

  async read<E>(pid: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    await this.ensureOpen();
    const stmts = this.stmts!;
    try {
      const rows = toSeq === undefined
        ? (stmts.readAll.all(pid, fromSeq) as Array<{
            persistence_id: string;
            sequence_nr: number;
            payload: string;
            tags: string | null;
            timestamp: number;
          }>)
        : (stmts.readRange.all(pid, fromSeq, toSeq) as Array<{
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

  async highestSeq(pid: string): Promise<number> {
    await this.ensureOpen();
    const row = this.stmts!.highestSeq.get(pid) as { hi: number | null } | undefined;
    return row?.hi ?? 0;
  }

  async delete(pid: string, toSeq: number): Promise<void> {
    await this.ensureOpen();
    this.stmts!.deleteUpTo.run(pid, toSeq);
  }

  async persistenceIds(): Promise<string[]> {
    await this.ensureOpen();
    const rows = this.stmts!.pids.all() as Array<{ persistence_id: string }>;
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
    `);
    if (this.options.wal) db.exec('PRAGMA journal_mode = WAL;');

    this.stmts = {
      insert: db.prepare(
        `INSERT INTO ${this.table}(persistence_id, sequence_nr, payload, tags, timestamp) VALUES (?, ?, ?, ?, ?)`,
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
      pids: db.prepare(
        `SELECT DISTINCT persistence_id FROM ${this.table}`,
      ),
    };
    this.db = db;
  }
}
