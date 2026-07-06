import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { JournalError, type Snapshot } from '../JournalTypes.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import { none, some, type Option } from '../../util/Option.js';
import {
  assertSafeIdentifier,
  buildPgPool,
  type PgPoolLike,
  type PostgresConnection,
} from '../journals/PostgresClient.js';

export interface PostgresSnapshotStoreSettings extends PostgresConnection {
  /** Snapshots table name.  Default: `snapshots`. */
  readonly snapshotsTable?: string;
  /** Keep this many snapshots per persistenceId; older ones pruned on save.  Default: 3.  `<=0` keeps all. */
  readonly keepN?: number;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
}

/**
 * Fluent builder for {@link PostgresSnapshotStoreSettings}:
 *
 *     new PostgresSnapshotStore(PostgresSnapshotStoreOptions.create().withUrl('postgres://…').withKeepN(5))
 *
 * The connection fields (`withUrl` / `withPoolConfig` / `withPool`) come
 * from the shared {@link PostgresConnection} mixin.
 */
export class PostgresSnapshotStoreOptions extends OptionsBuilder<PostgresSnapshotStoreSettings> {
  /** Start a fresh builder.  Equivalent to `new PostgresSnapshotStoreOptions()`. */
  static create(): PostgresSnapshotStoreOptions {
    return new PostgresSnapshotStoreOptions();
  }

  /** Connection string, e.g. `postgres://user:pass@host:5432/db`. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Extra node-postgres `Pool` config, merged over `{ connectionString: url }`. */
  withPoolConfig(poolConfig: Record<string, unknown>): this {
    return this.set('poolConfig', poolConfig);
  }

  /** Pre-built pool — bypasses the lazy `pg` import; share it across stores. */
  withPool(pool: PgPoolLike): this {
    return this.set('pool', pool);
  }

  /** Snapshots table name.  Default: `snapshots`. */
  withSnapshotsTable(snapshotsTable: string): this {
    return this.set('snapshotsTable', snapshotsTable);
  }

  /** Keep this many snapshots per persistenceId; older ones pruned on save.  Default: 3.  `<=0` keeps all. */
  withKeepN(keepN: number): this {
    return this.set('keepN', keepN);
  }

  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  withAutoCreateTables(autoCreateTables: boolean): this {
    return this.set('autoCreateTables', autoCreateTables);
  }
}

interface SnapRow {
  persistence_id: string;
  sequence_nr: string | number;
  payload: string;
  timestamp: string | number;
}

/**
 * SnapshotStore backed by PostgreSQL (`pg`).  One row per
 * `(persistence_id, sequence_nr)`; `loadLatest` is an indexed
 * `ORDER BY sequence_nr DESC LIMIT 1`.  Prune-on-save keeps the newest
 * `keepN`.  `PersistenceOptions` (compression/encryption) are ignored —
 * like the SQLite and Cassandra stores, payloads are stored as JSON text.
 */
export class PostgresSnapshotStore implements SnapshotStore {
  private readonly settings: PostgresSnapshotStoreSettings;
  private readonly table: string;
  private readonly keepN: number;
  private readonly autoCreate: boolean;

  private pool: PgPoolLike | null = null;
  private initPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: PostgresSnapshotStoreOptions = PostgresSnapshotStoreOptions.create()) {
    const s = options.build();
    this.settings = s;
    this.table = assertSafeIdentifier(s.snapshotsTable ?? 'snapshots', 'snapshots table');
    this.keepN = s.keepN ?? 3;
    this.autoCreate = s.autoCreateTables ?? true;
  }

  async save<S>(pid: string, seq: number, state: S, _options?: PersistenceOptions): Promise<Snapshot<S>> {
    const pool = await this.ensureOpen();
    const now = Date.now();
    try {
      await pool.query(
        `INSERT INTO ${this.table}(persistence_id, sequence_nr, payload, timestamp) VALUES ($1, $2, $3, $4)
         ON CONFLICT (persistence_id, sequence_nr) DO UPDATE SET payload = EXCLUDED.payload, timestamp = EXCLUDED.timestamp`,
        [pid, seq, JSON.stringify(state), now],
      );
      if (this.keepN > 0) {
        await pool.query(
          `DELETE FROM ${this.table} WHERE persistence_id = $1 AND sequence_nr NOT IN (
             SELECT sequence_nr FROM ${this.table} WHERE persistence_id = $1 ORDER BY sequence_nr DESC LIMIT $2)`,
          [pid, this.keepN],
        );
      }
      return { persistenceId: pid, sequenceNr: seq, state, timestamp: now };
    } catch (e) {
      throw new JournalError(`PostgresSnapshotStore.save failed: ${(e as Error).message}`, e);
    }
  }

  async loadLatest<S>(pid: string, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const pool = await this.ensureOpen();
    const res = await pool.query(
      `SELECT persistence_id, sequence_nr, payload, timestamp FROM ${this.table} WHERE persistence_id = $1 ORDER BY sequence_nr DESC LIMIT 1`,
      [pid],
    );
    const row = res.rows[0] as unknown as SnapRow | undefined;
    return row ? some(this.toSnapshot<S>(row)) : none;
  }

  async loadBefore<S>(pid: string, seq: number, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const pool = await this.ensureOpen();
    const res = await pool.query(
      `SELECT persistence_id, sequence_nr, payload, timestamp FROM ${this.table} WHERE persistence_id = $1 AND sequence_nr < $2 ORDER BY sequence_nr DESC LIMIT 1`,
      [pid, seq],
    );
    const row = res.rows[0] as unknown as SnapRow | undefined;
    return row ? some(this.toSnapshot<S>(row)) : none;
  }

  async delete(pid: string, toSeq: number): Promise<void> {
    const pool = await this.ensureOpen();
    await pool.query(
      `DELETE FROM ${this.table} WHERE persistence_id = $1 AND sequence_nr <= $2`,
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

  private async ensureOpen(): Promise<PgPoolLike> {
    if (this.closed) throw new JournalError('PostgresSnapshotStore is closed');
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
           timestamp      BIGINT NOT NULL,
           PRIMARY KEY (persistence_id, sequence_nr)
         )`,
      );
    }
    this.pool = pool;
  }
}
