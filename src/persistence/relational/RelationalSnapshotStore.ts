import { type Snapshot } from '../JournalTypes.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import { none, some, type Option } from '../../util/Option.js';
import { assertSafeIdentifier } from '../storage/SqlIdentifier.js';
import { expandPlaceholders } from './SqlDialect.js';
import { RelationalStore, type RelationalStoreConfig } from './RelationalStore.js';

interface SnapshotRow {
  persistence_id: string;
  sequence_nr: string | number | bigint;
  payload: string;
  timestamp: string | number | bigint;
}

export interface RelationalSnapshotStoreConfig extends RelationalStoreConfig {
  /** Snapshots table.  Default `'snapshots'`. */
  readonly snapshotsTable?: string;
  /**
   * How many snapshots to keep per persistence id, pruned on each save.
   * Default `3`; `<= 0` disables pruning and keeps every snapshot.
   */
  readonly keepN?: number;
}

/**
 * SnapshotStore over any SQL database, parameterized by `SqlDialect`.
 *
 * One row per `(persistence_id, sequence_nr)`, so `loadLatest` is an indexed
 * `ORDER BY sequence_nr DESC LIMIT 1` and re-saving at the same sequence
 * number overwrites in place.  `PersistenceOptions` (compression, encryption)
 * are ignored — payloads are JSON text, matching the SQLite and Cassandra
 * stores; the object-storage store is the one that honours them.
 */
export class RelationalSnapshotStore extends RelationalStore implements SnapshotStore {
  private readonly table: string;
  private readonly keepN: number;
  private readonly statements: {
    readonly upsert: string;
    readonly prune: { readonly sql: string; params(persistenceId: string, keepN: number): unknown[] };
    readonly latest: string;
    readonly before: string;
    readonly deleteUpTo: string;
  };

  constructor(config: RelationalSnapshotStoreConfig) {
    super(config);
    const table = assertSafeIdentifier(config.snapshotsTable ?? 'snapshots', 'snapshots table');
    this.table = table;
    this.keepN = config.keepN ?? 3;

    const expand = (sql: string): string => expandPlaceholders(sql, config.dialect);
    this.statements = {
      upsert: config.dialect.upsertSnapshotSql(table),
      prune: config.dialect.pruneSnapshotsStatement(table),
      latest: expand(
        `SELECT persistence_id, sequence_nr, payload, timestamp FROM ${table} WHERE persistence_id = ? ORDER BY sequence_nr DESC LIMIT 1`,
      ),
      before: expand(
        `SELECT persistence_id, sequence_nr, payload, timestamp FROM ${table} WHERE persistence_id = ? AND sequence_nr < ? ORDER BY sequence_nr DESC LIMIT 1`,
      ),
      deleteUpTo: expand(`DELETE FROM ${table} WHERE persistence_id = ? AND sequence_nr <= ?`),
    };
  }

  protected ddl(): string[] {
    return this.dialect.snapshotDdl(this.table);
  }

  async save<S>(persistenceId: string, seq: number, state: S, _options?: PersistenceOptions): Promise<Snapshot<S>> {
    const pool = await this.ensureOpen();
    const now = Date.now();
    try {
      await pool.query(this.statements.upsert, [persistenceId, seq, JSON.stringify(state), now]);
      if (this.keepN > 0) {
        const { sql, params } = this.statements.prune;
        await pool.query(sql, params(persistenceId, this.keepN));
      }
      return { persistenceId, sequenceNr: seq, state, timestamp: now };
    } catch (e) {
      this.fail('save', e);
    }
  }

  async loadLatest<S>(persistenceId: string, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const pool = await this.ensureOpen();
    const result = await pool.query(this.statements.latest, [persistenceId]);
    const row = result.rows[0] as unknown as SnapshotRow | undefined;
    return row ? some(this.toSnapshot<S>(row)) : none;
  }

  async loadBefore<S>(persistenceId: string, seq: number, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const pool = await this.ensureOpen();
    const result = await pool.query(this.statements.before, [persistenceId, seq]);
    const row = result.rows[0] as unknown as SnapshotRow | undefined;
    return row ? some(this.toSnapshot<S>(row)) : none;
  }

  async delete(persistenceId: string, toSeq: number): Promise<void> {
    const pool = await this.ensureOpen();
    await pool.query(this.statements.deleteUpTo, [persistenceId, toSeq]);
  }

  /* --------------------------- internals -------------------------------- */

  private toSnapshot<S>(row: SnapshotRow): Snapshot<S> {
    return {
      persistenceId: row.persistence_id,
      sequenceNr: Number(row.sequence_nr),
      state: JSON.parse(row.payload) as S,
      timestamp: Number(row.timestamp),
    };
  }
}
