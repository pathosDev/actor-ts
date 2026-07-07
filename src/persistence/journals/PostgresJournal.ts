import { resolveSettings } from '../../util/OptionsBuilder.js';
import type { Journal } from '../Journal.js';
import {
  JournalConcurrencyError,
  JournalError,
  type PersistentEvent,
} from '../JournalTypes.js';
import {
  assertSafeIdentifier,
  buildPgPool,
  type PgPoolLike,
  type PostgresConnection,
} from './PostgresClient.js';
import type { PostgresJournalOptions } from './PostgresJournalOptions.js';

export interface PostgresJournalSettings extends PostgresConnection {
  /** Events table name.  Default: `events`. */
  readonly eventsTable?: string;
  /** Tags join table name.  Default: `${eventsTable}_tags`. */
  readonly tagsTable?: string;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
}

interface EventRow {
  persistence_id: string;
  sequence_nr: string | number;
  payload: string;
  tags: string | null;
  timestamp: string | number;
}

/**
 * Journal backed by PostgreSQL via the `pg` (node-postgres) driver.
 *
 * Mirrors `SqliteJournal`'s shape — an events table keyed on
 * `(persistence_id, sequence_nr)` plus a tags join table for indexed
 * tag queries — using Postgres types and `$1` bind parameters.
 *
 * Optimistic concurrency: `append` runs `SELECT MAX(sequence_nr)` and the
 * INSERTs inside one transaction; a racing writer that slips between the
 * read and the insert trips the primary-key unique constraint (SQLSTATE
 * `23505`), which is translated to `JournalConcurrencyError` as a
 * backstop.  Construction is lazy — the pool opens and tables are created
 * on the first call.
 *
 * No in-process event bus: Postgres is a cross-process backend (like
 * Cassandra), so the `events` field is left undefined and the query layer
 * falls back to polling.  (A `LISTEN/NOTIFY` bus is a possible future
 * enhancement.)
 */
export class PostgresJournal implements Journal {
  private readonly settings: PostgresJournalSettings;
  private readonly table: string;
  private readonly tagsTable: string;
  private readonly autoCreate: boolean;

  private pool: PgPoolLike | null = null;
  private initPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: PostgresJournalOptions | Partial<PostgresJournalSettings> = {}) {
    const s = resolveSettings(options);
    this.settings = s;
    this.table = assertSafeIdentifier(s.eventsTable ?? 'events', 'events table');
    this.tagsTable = assertSafeIdentifier(
      s.tagsTable ?? `${this.table}_tags`, 'tags table',
    );
    this.autoCreate = s.autoCreateTables ?? true;
  }

  async append<E>(
    pid: string,
    events: ReadonlyArray<E>,
    expectedSeq: number,
    tags?: ReadonlyArray<string>,
  ): Promise<PersistentEvent<E>[]> {
    if (events.length === 0) return [];
    const pool = await this.ensureOpen();
    const client = await pool.connect();
    const now = Date.now();
    try {
      await client.query('BEGIN');
      const head = await client.query(
        `SELECT COALESCE(MAX(sequence_nr), 0) AS hi FROM ${this.table} WHERE persistence_id = $1`,
        [pid],
      );
      const actualSeq = Number((head.rows[0] as { hi: string | number }).hi);
      if (actualSeq !== expectedSeq) {
        await client.query('ROLLBACK');
        throw new JournalConcurrencyError(pid, expectedSeq, actualSeq);
      }
      const out: PersistentEvent<E>[] = [];
      const tagString = tags && tags.length ? tags.join(',') : null;
      let seq = actualSeq;
      for (const ev of events) {
        seq++;
        await client.query(
          `INSERT INTO ${this.table}(persistence_id, sequence_nr, payload, tags, timestamp) VALUES ($1, $2, $3, $4, $5)`,
          [pid, seq, JSON.stringify(ev), tagString, now],
        );
        if (tags) {
          for (const tag of tags) {
            if (tag.length === 0) continue;
            await client.query(
              `INSERT INTO ${this.tagsTable}(persistence_id, sequence_nr, tag, timestamp) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
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
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* already rolled back / aborted */ }
      if (e instanceof JournalConcurrencyError) throw e;
      // Unique-violation backstop: a concurrent writer claimed the same
      // (pid, seq) between our MAX read and INSERT.  Report the now-current
      // head as the actual seq so the caller can recover.
      if ((e as { code?: string }).code === '23505') {
        const actual = await this.highestSeq(pid).catch(() => expectedSeq);
        throw new JournalConcurrencyError(pid, expectedSeq, actual);
      }
      throw new JournalError(`PostgresJournal.append failed: ${(e as Error).message}`, e);
    } finally {
      client.release();
    }
  }

  async read<E>(pid: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    const pool = await this.ensureOpen();
    try {
      const res = toSeq === undefined
        ? await pool.query(
            `SELECT persistence_id, sequence_nr, payload, tags, timestamp FROM ${this.table} WHERE persistence_id = $1 AND sequence_nr >= $2 ORDER BY sequence_nr ASC`,
            [pid, fromSeq],
          )
        : await pool.query(
            `SELECT persistence_id, sequence_nr, payload, tags, timestamp FROM ${this.table} WHERE persistence_id = $1 AND sequence_nr >= $2 AND sequence_nr <= $3 ORDER BY sequence_nr ASC`,
            [pid, fromSeq, toSeq],
          );
      return (res.rows as unknown as EventRow[]).map((r) => ({
        persistenceId: r.persistence_id,
        sequenceNr: Number(r.sequence_nr),
        event: JSON.parse(r.payload) as E,
        timestamp: Number(r.timestamp),
        tags: r.tags ? String(r.tags).split(',') : undefined,
      }));
    } catch (e) {
      throw new JournalError(`PostgresJournal.read failed: ${(e as Error).message}`, e);
    }
  }

  async highestSeq(pid: string): Promise<number> {
    const pool = await this.ensureOpen();
    const res = await pool.query(
      `SELECT COALESCE(MAX(sequence_nr), 0) AS hi FROM ${this.table} WHERE persistence_id = $1`,
      [pid],
    );
    return Number((res.rows[0] as { hi: string | number }).hi);
  }

  async delete(pid: string, toSeq: number): Promise<void> {
    const pool = await this.ensureOpen();
    // Tags first (same order as SqliteJournal): a crash mid-delete then
    // leaves orphan tag-less events rather than tags pointing at deleted
    // events, which the JOIN-based query path would silently miss.
    await pool.query(
      `DELETE FROM ${this.tagsTable} WHERE persistence_id = $1 AND sequence_nr <= $2`,
      [pid, toSeq],
    );
    await pool.query(
      `DELETE FROM ${this.table} WHERE persistence_id = $1 AND sequence_nr <= $2`,
      [pid, toSeq],
    );
  }

  async persistenceIds(): Promise<string[]> {
    const pool = await this.ensureOpen();
    const res = await pool.query(`SELECT DISTINCT persistence_id FROM ${this.table}`);
    return (res.rows as Array<{ persistence_id: string }>).map((r) => r.persistence_id);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.pool?.end(); } catch { /* ignore */ }
    this.pool = null;
  }

  /* --------------------------- internals -------------------------------- */

  private async ensureOpen(): Promise<PgPoolLike> {
    if (this.closed) throw new JournalError('PostgresJournal is closed');
    if (this.pool) return this.pool;
    if (!this.initPromise) this.initPromise = this.init();
    await this.initPromise;
    return this.pool!;
  }

  private async init(): Promise<void> {
    const pool = await buildPgPool(this.settings);
    if (this.autoCreate) {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${this.table} (
           persistence_id TEXT NOT NULL,
           sequence_nr    BIGINT NOT NULL,
           payload        TEXT NOT NULL,
           tags           TEXT,
           timestamp      BIGINT NOT NULL,
           PRIMARY KEY (persistence_id, sequence_nr)
         )`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_${this.table}_pid ON ${this.table}(persistence_id)`,
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${this.tagsTable} (
           persistence_id TEXT NOT NULL,
           sequence_nr    BIGINT NOT NULL,
           tag            TEXT NOT NULL,
           timestamp      BIGINT NOT NULL,
           PRIMARY KEY (tag, timestamp, persistence_id, sequence_nr)
         )`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_${this.tagsTable}_pid_seq ON ${this.tagsTable}(persistence_id, sequence_nr)`,
      );
    }
    this.pool = pool;
  }
}
