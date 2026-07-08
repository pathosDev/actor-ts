import { JournalError, type Snapshot } from '../JournalTypes.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import { none, some, type Option } from '../../util/Option.js';
import {
  assertSafeIdentifier,
  buildMariaDbPool,
  rowsOf,
  type MariaDbPoolLike,
} from '../journals/MariaDbClient.js';
import type { MariaDbSnapshotStoreOptions, MariaDbSnapshotStoreOptionsType } from './MariaDbSnapshotStoreOptions.js';

interface SnapRow {
  persistence_id: string;
  sequence_nr: string | number | bigint;
  payload: string;
  timestamp: string | number | bigint;
}

/**
 * SnapshotStore backed by MariaDB / MySQL (`mariadb`).  Sibling of
 * `PostgresSnapshotStore` with the MariaDB dialect: `ON DUPLICATE KEY
 * UPDATE` upsert and a derived-table-wrapped `keepN` prune (MySQL/MariaDB
 * reject `LIMIT` inside a bare `IN (SELECT …)` against the same table).
 */
export class MariaDbSnapshotStore implements SnapshotStore {
  private readonly options: MariaDbSnapshotStoreOptionsType;
  private readonly table: string;
  private readonly keepN: number;
  private readonly autoCreate: boolean;

  private pool: MariaDbPoolLike | null = null;
  private initPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: MariaDbSnapshotStoreOptions = {}) {
    const s = (options as MariaDbSnapshotStoreOptionsType);
    this.options = s;
    this.table = assertSafeIdentifier(s.snapshotsTable ?? 'snapshots', 'snapshots table');
    this.keepN = s.keepN ?? 3;
    this.autoCreate = s.autoCreateTables ?? true;
  }

  async save<S>(pid: string, seq: number, state: S, _options?: PersistenceOptions): Promise<Snapshot<S>> {
    const pool = await this.ensureOpen();
    const now = Date.now();
    try {
      await pool.query(
        `INSERT INTO ${this.table}(persistence_id, sequence_nr, payload, timestamp) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE payload = VALUES(payload), timestamp = VALUES(timestamp)`,
        [pid, seq, JSON.stringify(state), now],
      );
      if (this.keepN > 0) {
        await pool.query(
          `DELETE FROM ${this.table} WHERE persistence_id = ? AND sequence_nr NOT IN (
             SELECT s FROM (
               SELECT sequence_nr AS s FROM ${this.table} WHERE persistence_id = ? ORDER BY sequence_nr DESC LIMIT ?
             ) AS keep)`,
          [pid, pid, this.keepN],
        );
      }
      return { persistenceId: pid, sequenceNr: seq, state, timestamp: now };
    } catch (e) {
      throw new JournalError(`MariaDbSnapshotStore.save failed: ${(e as Error).message}`, e);
    }
  }

  async loadLatest<S>(pid: string, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const pool = await this.ensureOpen();
    const rows = rowsOf(await pool.query(
      `SELECT persistence_id, sequence_nr, payload, timestamp FROM ${this.table} WHERE persistence_id = ? ORDER BY sequence_nr DESC LIMIT 1`,
      [pid],
    ));
    const row = rows[0] as unknown as SnapRow | undefined;
    return row ? some(this.toSnapshot<S>(row)) : none;
  }

  async loadBefore<S>(pid: string, seq: number, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const pool = await this.ensureOpen();
    const rows = rowsOf(await pool.query(
      `SELECT persistence_id, sequence_nr, payload, timestamp FROM ${this.table} WHERE persistence_id = ? AND sequence_nr < ? ORDER BY sequence_nr DESC LIMIT 1`,
      [pid, seq],
    ));
    const row = rows[0] as unknown as SnapRow | undefined;
    return row ? some(this.toSnapshot<S>(row)) : none;
  }

  async delete(pid: string, toSeq: number): Promise<void> {
    const pool = await this.ensureOpen();
    await pool.query(
      `DELETE FROM ${this.table} WHERE persistence_id = ? AND sequence_nr <= ?`,
      [pid, toSeq],
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.pool?.end(); } catch { /* ignore */ }
    this.pool = null;
  }

  /* --------------------------- internals -------------------------------- */

  private toSnapshot<S>(row: SnapRow): Snapshot<S> {
    return {
      persistenceId: row.persistence_id,
      sequenceNr: Number(row.sequence_nr),
      state: JSON.parse(row.payload) as S,
      timestamp: Number(row.timestamp),
    };
  }

  private async ensureOpen(): Promise<MariaDbPoolLike> {
    if (this.closed) throw new JournalError('MariaDbSnapshotStore is closed');
    if (this.pool) return this.pool;
    if (!this.initPromise) this.initPromise = this.init();
    await this.initPromise;
    return this.pool!;
  }

  private async init(): Promise<void> {
    const pool = await buildMariaDbPool(this.options);
    if (this.autoCreate) {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${this.table} (
           persistence_id VARCHAR(255) NOT NULL,
           sequence_nr    BIGINT NOT NULL,
           payload        LONGTEXT NOT NULL,
           timestamp      BIGINT NOT NULL,
           PRIMARY KEY (persistence_id, sequence_nr)
         )`,
      );
    }
    this.pool = pool;
  }
}
