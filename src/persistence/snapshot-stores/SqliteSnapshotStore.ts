import { getSqliteDriver, type SqliteDb, type SqliteStatement } from '../../runtime/sqlite/index.js';
import { JournalError, type Snapshot } from '../JournalTypes.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import { none, some, type Option } from '../../util/Option.js';
import type { SqliteSnapshotStoreOptions, SqliteSnapshotStoreOptionsType } from './SqliteSnapshotStoreOptions.js';

interface Stmts {
  insert: SqliteStatement;
  latest: SqliteStatement;
  before: SqliteStatement;
  deleteUpTo: SqliteStatement;
  deleteOlderThan: SqliteStatement;
}

/**
 * SQLite-backed SnapshotStore — JSON payloads, single table, prune-on-save.
 * Works on Bun (`bun:sqlite`) and Node.js (`better-sqlite3`) via the
 * `SqliteDriver` abstraction.  Construction is lazy (same pattern as
 * `SqliteJournal`): the DB is opened on the first save / load call.
 */
export class SqliteSnapshotStore implements SnapshotStore {
  private readonly options: SqliteSnapshotStoreOptionsType;
  private readonly table: string;
  private readonly keepN: number;
  private closed = false;

  private db: SqliteDb | null = null;
  private stmts: Stmts | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(options: SqliteSnapshotStoreOptions = {}) {
    const resolvedOptions = (options as SqliteSnapshotStoreOptionsType);
    this.options = resolvedOptions;
    this.table = resolvedOptions.snapshotsTable ?? 'snapshots';
    this.keepN = resolvedOptions.keepN ?? 3;
  }

  async save<S>(pid: string, seq: number, state: S, _options?: PersistenceOptions): Promise<Snapshot<S>> {
    // SQLite store has no compression / encryption — options ignored.
    await this.ensureOpen();
    const stmts = this.stmts!;
    const now = Date.now();
    try {
      stmts.insert.run(pid, seq, JSON.stringify(state), now);
      if (this.keepN > 0) {
        stmts.deleteOlderThan.run(pid, pid, this.keepN);
      }
      return { persistenceId: pid, sequenceNr: seq, state, timestamp: now };
    } catch (e) {
      throw new JournalError(`SqliteSnapshotStore.save failed: ${(e as Error).message}`, e);
    }
  }

  async loadLatest<S>(pid: string, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    await this.ensureOpen();
    const row = this.stmts!.latest.get(pid) as {
      persistence_id: string;
      sequence_nr: number;
      payload: string;
      timestamp: number;
    } | undefined;
    if (!row) return none;
    return some({
      persistenceId: row.persistence_id,
      sequenceNr: row.sequence_nr,
      state: JSON.parse(row.payload) as S,
      timestamp: row.timestamp,
    });
  }

  async loadBefore<S>(pid: string, seq: number, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    await this.ensureOpen();
    const row = this.stmts!.before.get(pid, seq) as {
      persistence_id: string;
      sequence_nr: number;
      payload: string;
      timestamp: number;
    } | undefined;
    if (!row) return none;
    return some({
      persistenceId: row.persistence_id,
      sequenceNr: row.sequence_nr,
      state: JSON.parse(row.payload) as S,
      timestamp: row.timestamp,
    });
  }

  async delete(pid: string, toSeq: number): Promise<void> {
    await this.ensureOpen();
    this.stmts!.deleteUpTo.run(pid, toSeq);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.db?.close(); } catch { /* ignore */ }
  }

  /* --------------------------- internals -------------------------------- */

  private async ensureOpen(): Promise<void> {
    if (this.closed) throw new JournalError('SqliteSnapshotStore is closed');
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
        timestamp      INTEGER NOT NULL,
        PRIMARY KEY (persistence_id, sequence_nr)
      );
    `);
    this.stmts = {
      insert: db.prepare(
        `INSERT OR REPLACE INTO ${this.table}(persistence_id, sequence_nr, payload, timestamp) VALUES (?, ?, ?, ?)`,
      ),
      latest: db.prepare(
        `SELECT persistence_id, sequence_nr, payload, timestamp FROM ${this.table} WHERE persistence_id = ? ORDER BY sequence_nr DESC LIMIT 1`,
      ),
      before: db.prepare(
        `SELECT persistence_id, sequence_nr, payload, timestamp FROM ${this.table} WHERE persistence_id = ? AND sequence_nr < ? ORDER BY sequence_nr DESC LIMIT 1`,
      ),
      deleteUpTo: db.prepare(
        `DELETE FROM ${this.table} WHERE persistence_id = ? AND sequence_nr <= ?`,
      ),
      deleteOlderThan: db.prepare(
        `DELETE FROM ${this.table} WHERE persistence_id = ? AND sequence_nr NOT IN (SELECT sequence_nr FROM ${this.table} WHERE persistence_id = ? ORDER BY sequence_nr DESC LIMIT ?)`,
      ),
    };
    this.db = db;
  }
}
