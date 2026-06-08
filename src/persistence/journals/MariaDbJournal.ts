import type { Journal } from '../Journal.js';
import {
  JournalConcurrencyError,
  JournalError,
  type PersistentEvent,
} from '../JournalTypes.js';
import {
  assertSafeIdentifier,
  buildMariaDbPool,
  isDuplicateKeyError,
  rowsOf,
  type MariaDbPoolLike,
  type MariaDbConnection,
} from './MariaDbClient.js';

export interface MariaDbJournalOptions extends MariaDbConnection {
  /** Events table name.  Default: `events`. */
  readonly eventsTable?: string;
  /** Tags join table name.  Default: `${eventsTable}_tags`. */
  readonly tagsTable?: string;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
}

interface EventRow {
  persistence_id: string;
  sequence_nr: string | number | bigint;
  payload: string;
  tags: string | null;
  timestamp: string | number | bigint;
}

/**
 * Journal backed by MariaDB / MySQL via the `mariadb` connector.  Sibling
 * of `PostgresJournal` (separate implementation, MariaDB dialect): `?`
 * placeholders, `INSERT IGNORE` for the tag dedup, `ER_DUP_ENTRY` (1062)
 * as the optimistic-concurrency backstop, and `LONGTEXT`/`BIGINT` columns.
 * Cross-process backend → no in-process event bus.
 */
export class MariaDbJournal implements Journal {
  private readonly options: MariaDbJournalOptions;
  private readonly table: string;
  private readonly tagsTable: string;
  private readonly autoCreate: boolean;

  private pool: MariaDbPoolLike | null = null;
  private initPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: MariaDbJournalOptions = {}) {
    this.options = options;
    this.table = assertSafeIdentifier(options.eventsTable ?? 'events', 'events table');
    this.tagsTable = assertSafeIdentifier(
      options.tagsTable ?? `${this.table}_tags`, 'tags table',
    );
    this.autoCreate = options.autoCreateTables ?? true;
  }

  async append<E>(
    pid: string,
    events: ReadonlyArray<E>,
    expectedSeq: number,
    tags?: ReadonlyArray<string>,
  ): Promise<PersistentEvent<E>[]> {
    if (events.length === 0) return [];
    const pool = await this.ensureOpen();
    const conn = await pool.getConnection();
    const now = Date.now();
    try {
      await conn.beginTransaction();
      const head = rowsOf(await conn.query(
        `SELECT COALESCE(MAX(sequence_nr), 0) AS hi FROM ${this.table} WHERE persistence_id = ?`,
        [pid],
      ));
      const actualSeq = Number((head[0] as { hi: string | number | bigint }).hi);
      if (actualSeq !== expectedSeq) {
        await conn.rollback();
        throw new JournalConcurrencyError(pid, expectedSeq, actualSeq);
      }
      const out: PersistentEvent<E>[] = [];
      const tagString = tags && tags.length ? tags.join(',') : null;
      let seq = actualSeq;
      for (const ev of events) {
        seq++;
        await conn.query(
          `INSERT INTO ${this.table}(persistence_id, sequence_nr, payload, tags, timestamp) VALUES (?, ?, ?, ?, ?)`,
          [pid, seq, JSON.stringify(ev), tagString, now],
        );
        if (tags) {
          for (const tag of tags) {
            if (tag.length === 0) continue;
            await conn.query(
              `INSERT IGNORE INTO ${this.tagsTable}(persistence_id, sequence_nr, tag, timestamp) VALUES (?, ?, ?, ?)`,
              [pid, seq, tag, now],
            );
          }
        }
        out.push({
          persistenceId: pid,
          sequenceNr: seq,
          event: ev,
          timestamp: now,
          tags: tags ? [...tags] : undefined,
        });
      }
      await conn.commit();
      return out;
    } catch (e) {
      try { await conn.rollback(); } catch { /* already rolled back */ }
      if (e instanceof JournalConcurrencyError) throw e;
      if (isDuplicateKeyError(e)) {
        const actual = await this.highestSeq(pid).catch(() => expectedSeq);
        throw new JournalConcurrencyError(pid, expectedSeq, actual);
      }
      throw new JournalError(`MariaDbJournal.append failed: ${(e as Error).message}`, e);
    } finally {
      conn.release();
    }
  }

  async read<E>(pid: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    const pool = await this.ensureOpen();
    try {
      const rows = rowsOf(toSeq === undefined
        ? await pool.query(
            `SELECT persistence_id, sequence_nr, payload, tags, timestamp FROM ${this.table} WHERE persistence_id = ? AND sequence_nr >= ? ORDER BY sequence_nr ASC`,
            [pid, fromSeq],
          )
        : await pool.query(
            `SELECT persistence_id, sequence_nr, payload, tags, timestamp FROM ${this.table} WHERE persistence_id = ? AND sequence_nr >= ? AND sequence_nr <= ? ORDER BY sequence_nr ASC`,
            [pid, fromSeq, toSeq],
          ));
      return (rows as unknown as EventRow[]).map((r) => ({
        persistenceId: r.persistence_id,
        sequenceNr: Number(r.sequence_nr),
        event: JSON.parse(r.payload) as E,
        timestamp: Number(r.timestamp),
        tags: r.tags ? String(r.tags).split(',') : undefined,
      }));
    } catch (e) {
      throw new JournalError(`MariaDbJournal.read failed: ${(e as Error).message}`, e);
    }
  }

  async highestSeq(pid: string): Promise<number> {
    const pool = await this.ensureOpen();
    const rows = rowsOf(await pool.query(
      `SELECT COALESCE(MAX(sequence_nr), 0) AS hi FROM ${this.table} WHERE persistence_id = ?`,
      [pid],
    ));
    return Number((rows[0] as { hi: string | number | bigint }).hi);
  }

  async delete(pid: string, toSeq: number): Promise<void> {
    const pool = await this.ensureOpen();
    await pool.query(
      `DELETE FROM ${this.tagsTable} WHERE persistence_id = ? AND sequence_nr <= ?`,
      [pid, toSeq],
    );
    await pool.query(
      `DELETE FROM ${this.table} WHERE persistence_id = ? AND sequence_nr <= ?`,
      [pid, toSeq],
    );
  }

  async persistenceIds(): Promise<string[]> {
    const pool = await this.ensureOpen();
    const rows = rowsOf(await pool.query(`SELECT DISTINCT persistence_id FROM ${this.table}`));
    return (rows as Array<{ persistence_id: string }>).map((r) => r.persistence_id);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.pool?.end(); } catch { /* ignore */ }
    this.pool = null;
  }

  /* --------------------------- internals -------------------------------- */

  private async ensureOpen(): Promise<MariaDbPoolLike> {
    if (this.closed) throw new JournalError('MariaDbJournal is closed');
    if (this.pool) return this.pool;
    if (!this.initPromise) this.initPromise = this.init();
    await this.initPromise;
    return this.pool!;
  }

  private async init(): Promise<void> {
    const pool = await buildMariaDbPool(this.options);
    if (this.autoCreate) {
      // Indexes declared inline — `CREATE INDEX IF NOT EXISTS` isn't
      // portable across MariaDB/MySQL versions, but inline INDEX in
      // CREATE TABLE is.
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${this.table} (
           persistence_id VARCHAR(255) NOT NULL,
           sequence_nr    BIGINT NOT NULL,
           payload        LONGTEXT NOT NULL,
           tags           TEXT,
           timestamp      BIGINT NOT NULL,
           PRIMARY KEY (persistence_id, sequence_nr),
           INDEX idx_${this.table}_pid (persistence_id)
         )`,
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${this.tagsTable} (
           persistence_id VARCHAR(255) NOT NULL,
           sequence_nr    BIGINT NOT NULL,
           tag            VARCHAR(255) NOT NULL,
           timestamp      BIGINT NOT NULL,
           PRIMARY KEY (tag, timestamp, persistence_id, sequence_nr),
           INDEX idx_${this.tagsTable}_pid_seq (persistence_id, sequence_nr)
         )`,
      );
    }
    this.pool = pool;
  }
}
