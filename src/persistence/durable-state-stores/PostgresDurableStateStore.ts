import {
  DurableStateConcurrencyError,
  type DurableStateRecord,
  type DurableStateStore,
} from '../DurableStateStore.js';
import { JournalError } from '../JournalTypes.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import { none, some, type Option } from '../../util/Option.js';
import {
  assertSafeIdentifier,
  buildPgPool,
  type PgPoolLike,
  type PostgresConnection,
} from '../journals/PostgresClient.js';

export interface PostgresDurableStateStoreOptions extends PostgresConnection {
  /** Table name.  Default: `durable_state`. */
  readonly table?: string;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
}

interface StateRow {
  revision: string | number;
  payload: string;
  timestamp: string | number;
}

/**
 * DurableStateStore backed by PostgreSQL (`pg`) — the first SQL-based
 * durable-state store (SQLite / Cassandra ship journal + snapshot only).
 *
 * One row per `persistence_id`, rewritten in place.  Optimistic
 * concurrency via the `revision` column:
 *
 *   - `expectedRevision === 0` → `INSERT … ON CONFLICT DO NOTHING`; zero
 *     rows affected means the row already exists → conflict.
 *   - `expectedRevision > 0`   → `UPDATE … WHERE revision = expected`;
 *     zero rows affected means the stored revision diverged → conflict.
 *
 * On conflict the current revision is read back and reported in the
 * `DurableStateConcurrencyError`.  `PersistenceOptions` are ignored
 * (JSON-text payload, like the other SQL stores).
 */
export class PostgresDurableStateStore implements DurableStateStore {
  private readonly options: PostgresDurableStateStoreOptions;
  private readonly table: string;
  private readonly autoCreate: boolean;

  private pool: PgPoolLike | null = null;
  private initPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: PostgresDurableStateStoreOptions = {}) {
    this.options = options;
    this.table = assertSafeIdentifier(options.table ?? 'durable_state', 'durable-state table');
    this.autoCreate = options.autoCreateTables ?? true;
  }

  async upsert<S>(
    persistenceId: string,
    expectedRevision: number,
    state: S,
    _options?: PersistenceOptions,
  ): Promise<DurableStateRecord<S>> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new JournalError(
        `PostgresDurableStateStore.upsert: expectedRevision must be a non-negative integer, got ${expectedRevision}`,
      );
    }
    const pool = await this.ensureOpen();
    const now = Date.now();
    const newRevision = expectedRevision + 1;
    const payload = JSON.stringify(state);
    try {
      if (expectedRevision === 0) {
        const res = await pool.query(
          `INSERT INTO ${this.table}(persistence_id, revision, payload, timestamp) VALUES ($1, $2, $3, $4)
           ON CONFLICT (persistence_id) DO NOTHING`,
          [persistenceId, newRevision, payload, now],
        );
        if ((res.rowCount ?? 0) === 0) {
          throw new DurableStateConcurrencyError(
            persistenceId, expectedRevision, await this.currentRevision(pool, persistenceId),
          );
        }
      } else {
        const res = await pool.query(
          `UPDATE ${this.table} SET revision = $1, payload = $2, timestamp = $3 WHERE persistence_id = $4 AND revision = $5`,
          [newRevision, payload, now, persistenceId, expectedRevision],
        );
        if ((res.rowCount ?? 0) === 0) {
          throw new DurableStateConcurrencyError(
            persistenceId, expectedRevision, await this.currentRevision(pool, persistenceId),
          );
        }
      }
      return { persistenceId, revision: newRevision, state, timestamp: now };
    } catch (e) {
      if (e instanceof DurableStateConcurrencyError) throw e;
      throw new JournalError(`PostgresDurableStateStore.upsert failed: ${(e as Error).message}`, e);
    }
  }

  async load<S>(persistenceId: string, _options?: PersistenceOptions): Promise<Option<DurableStateRecord<S>>> {
    const pool = await this.ensureOpen();
    const res = await pool.query(
      `SELECT revision, payload, timestamp FROM ${this.table} WHERE persistence_id = $1`,
      [persistenceId],
    );
    const row = res.rows[0] as unknown as StateRow | undefined;
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
    await pool.query(`DELETE FROM ${this.table} WHERE persistence_id = $1`, [persistenceId]);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.pool?.end(); } catch { /* ignore */ }
    this.pool = null;
  }

  /* --------------------------- internals -------------------------------- */

  /** Read the current revision for conflict reporting; 0 if the row is gone. */
  private async currentRevision(pool: PgPoolLike, pid: string): Promise<number> {
    const res = await pool.query(
      `SELECT revision FROM ${this.table} WHERE persistence_id = $1`,
      [pid],
    );
    const row = res.rows[0] as { revision: string | number } | undefined;
    return row ? Number(row.revision) : 0;
  }

  private async ensureOpen(): Promise<PgPoolLike> {
    if (this.closed) throw new JournalError('PostgresDurableStateStore is closed');
    if (this.pool) return this.pool;
    if (!this.initPromise) this.initPromise = this.init();
    await this.initPromise;
    return this.pool!;
  }

  private async init(): Promise<void> {
    const pool = await buildPgPool(this.options);
    if (this.autoCreate) {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${this.table} (
           persistence_id TEXT PRIMARY KEY,
           revision       BIGINT NOT NULL,
           payload        TEXT NOT NULL,
           timestamp      BIGINT NOT NULL
         )`,
      );
    }
    this.pool = pool;
  }
}
