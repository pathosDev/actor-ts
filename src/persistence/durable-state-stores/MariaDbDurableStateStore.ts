import {
  DurableStateConcurrencyError,
  type DurableStateRecord,
  type DurableStateStore,
} from '../DurableStateStore.js';
import { JournalError } from '../JournalTypes.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import { none, some, type Option } from '../../util/Option.js';
import {
  affectedRowsOf,
  assertSafeIdentifier,
  buildMariaDbPool,
  isDuplicateKeyError,
  rowsOf,
  type MariaDbPoolLike,
} from '../journals/MariaDbClient.js';
import type { MariaDbDurableStateStoreOptions, MariaDbDurableStateStoreOptionsType } from './MariaDbDurableStateStoreOptions.js';

interface StateRow {
  revision: string | number | bigint;
  payload: string;
  timestamp: string | number | bigint;
}

/**
 * DurableStateStore backed by MariaDB / MySQL (`mariadb`).  Sibling of
 * `PostgresDurableStateStore` with the MariaDB dialect for the revision
 * CAS:
 *
 *   - create (expectedRevision 0): plain `INSERT`; a duplicate-key error
 *     (1062) means the row already exists → conflict.
 *   - update (expectedRevision > 0): `UPDATE … WHERE revision = expected`;
 *     `affectedRows === 0` means the stored revision diverged → conflict.
 *     (revision always changes, so a matched row always reports 1.)
 */
export class MariaDbDurableStateStore implements DurableStateStore {
  private readonly options: MariaDbDurableStateStoreOptionsType;
  private readonly table: string;
  private readonly autoCreate: boolean;

  private pool: MariaDbPoolLike | null = null;
  private initPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: MariaDbDurableStateStoreOptions = {}) {
    const s = (options as MariaDbDurableStateStoreOptionsType);
    this.options = s;
    this.table = assertSafeIdentifier(s.table ?? 'durable_state', 'durable-state table');
    this.autoCreate = s.autoCreateTables ?? true;
  }

  async upsert<S>(
    persistenceId: string,
    expectedRevision: number,
    state: S,
    _options?: PersistenceOptions,
  ): Promise<DurableStateRecord<S>> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new JournalError(
        `MariaDbDurableStateStore.upsert: expectedRevision must be a non-negative integer, got ${expectedRevision}`,
      );
    }
    const pool = await this.ensureOpen();
    const now = Date.now();
    const newRevision = expectedRevision + 1;
    const payload = JSON.stringify(state);
    try {
      if (expectedRevision === 0) {
        try {
          await pool.query(
            `INSERT INTO ${this.table}(persistence_id, revision, payload, timestamp) VALUES (?, ?, ?, ?)`,
            [persistenceId, newRevision, payload, now],
          );
        } catch (e) {
          if (isDuplicateKeyError(e)) {
            throw new DurableStateConcurrencyError(
              persistenceId, expectedRevision, await this.currentRevision(pool, persistenceId),
            );
          }
          throw e;
        }
      } else {
        const res = await pool.query(
          `UPDATE ${this.table} SET revision = ?, payload = ?, timestamp = ? WHERE persistence_id = ? AND revision = ?`,
          [newRevision, payload, now, persistenceId, expectedRevision],
        );
        if (affectedRowsOf(res) === 0) {
          throw new DurableStateConcurrencyError(
            persistenceId, expectedRevision, await this.currentRevision(pool, persistenceId),
          );
        }
      }
      return { persistenceId, revision: newRevision, state, timestamp: now };
    } catch (e) {
      if (e instanceof DurableStateConcurrencyError) throw e;
      throw new JournalError(`MariaDbDurableStateStore.upsert failed: ${(e as Error).message}`, e);
    }
  }

  async load<S>(persistenceId: string, _options?: PersistenceOptions): Promise<Option<DurableStateRecord<S>>> {
    const pool = await this.ensureOpen();
    const rows = rowsOf(await pool.query(
      `SELECT revision, payload, timestamp FROM ${this.table} WHERE persistence_id = ?`,
      [persistenceId],
    ));
    const row = rows[0] as unknown as StateRow | undefined;
    if (!row) return none;
    return some({
      persistenceId,
      revision: Number(row.revision),
      state: JSON.parse(row.payload) as S,
      timestamp: Number(row.timestamp),
    });
  }

  async delete(persistenceId: string): Promise<void> {
    const pool = await this.ensureOpen();
    await pool.query(`DELETE FROM ${this.table} WHERE persistence_id = ?`, [persistenceId]);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.pool?.end(); } catch { /* ignore */ }
    this.pool = null;
  }

  /* --------------------------- internals -------------------------------- */

  private async currentRevision(pool: MariaDbPoolLike, pid: string): Promise<number> {
    const rows = rowsOf(await pool.query(
      `SELECT revision FROM ${this.table} WHERE persistence_id = ?`,
      [pid],
    ));
    const row = rows[0] as { revision: string | number | bigint } | undefined;
    return row ? Number(row.revision) : 0;
  }

  private async ensureOpen(): Promise<MariaDbPoolLike> {
    if (this.closed) throw new JournalError('MariaDbDurableStateStore is closed');
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
           revision       BIGINT NOT NULL,
           payload        LONGTEXT NOT NULL,
           timestamp      BIGINT NOT NULL,
           PRIMARY KEY (persistence_id)
         )`,
      );
    }
    this.pool = pool;
  }
}
