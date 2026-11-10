import { JournalError, type Snapshot } from '../JournalTypes.js';
import type { PersistenceOptionSupport } from '../PersistenceCapabilities.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import { none, some, type Option } from '../../util/Option.js';
import { DEFAULT_SNAPSHOTS_TABLE, DEFAULT_SNAPSHOT_KEEP_N } from '../Constants.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import {
  openPayload,
  sealPayload,
  snapshotPayloadContext,
  type SealedPayloadReadPolicy,
} from '../storage/SealedPayload.js';
import { assertSafeIdentifier } from '../storage/SqlIdentifier.js';
import { expandPlaceholders } from './SqlDialect.js';
import { RelationalStore, type RelationalStoreConfig } from './RelationalStore.js';

type SnapshotRow = {
  persistence_id: string;
  sequence_nr: string | number | bigint;
  payload: string;
  timestamp: string | number | bigint;
};

export interface RelationalSnapshotStoreConfig extends RelationalStoreConfig {
  /** Snapshots table.  Default `'snapshots'`. */
  readonly snapshotsTable?: string;
  /**
   * How many snapshots to keep per persistence id, pruned on each save.
   * Default `3`; `<= 0` disables pruning and keeps every snapshot.
   */
  readonly keepN?: number;
  /**
   * Re-admit rows that lack the protection an actor's `encryption()` /
   * `integrity()` asks for — the read-then-write migration window (#1802).
   * Default `false`; see `storage/SealedPayload.ts`.
   */
  readonly allowPlaintextRows?: boolean;
}

/**
 * SnapshotStore over any SQL database, parameterized by `SqlDialect`.
 *
 * One row per `(persistence_id, sequence_nr)`, so `loadLatest` is an indexed
 * `ORDER BY sequence_nr DESC LIMIT 1` and re-saving at the same sequence
 * number overwrites in place.  The payload is JSON text, or — when the actor
 * sets `compression()`, `encryption()` or `integrity()` — the object-storage
 * `BodyCodec` frame in base64 behind an `ats1:` prefix, in the same column
 * (#1802, `storage/SealedPayload.ts`).
 */
export class RelationalSnapshotStore extends RelationalStore implements SnapshotStore {
  /**
   * All three hooks are honoured on the write and the read path (#1802).
   * One declaration covers Postgres, MariaDB, MSSQL, libSQL and D1; the
   * SQLite *snapshot* store is standalone and declares its own.
   */
  readonly persistenceOptionSupport: PersistenceOptionSupport = {
    encryption: true,
    compression: true,
    integrity: true,
  };

  private readonly table: string;
  private readonly keepN: number;
  private readonly readPolicy: SealedPayloadReadPolicy;
  private readonly statements: {
    readonly upsert: string;
    readonly prune: { readonly sql: string; params(persistenceId: string, keepN: number): unknown[] };
    readonly latest: string;
    readonly before: string;
    readonly deleteUpTo: string;
  };

  constructor(config: RelationalSnapshotStoreConfig) {
    super(config);
    const table = assertSafeIdentifier(config.snapshotsTable ?? DEFAULT_SNAPSHOTS_TABLE, 'snapshots table');
    this.table = table;
    this.keepN = config.keepN ?? DEFAULT_SNAPSHOT_KEEP_N;
    this.readPolicy = { allowPlaintextRows: config.allowPlaintextRows ?? false };

    const expand = (sql: string): string => expandPlaceholders(sql, config.dialect);
    this.statements = {
      upsert: config.dialect.upsertSnapshotSql(table),
      prune: config.dialect.pruneSnapshotsStatement(table),
      // Row limiting is dialect-specific — T-SQL has no `LIMIT` at all.
      latest: expand(
        `SELECT persistence_id, sequence_nr, payload, timestamp FROM ${table} WHERE persistence_id = ? ORDER BY sequence_nr DESC ${config.dialect.rowLimit(1)}`,
      ),
      before: expand(
        `SELECT persistence_id, sequence_nr, payload, timestamp FROM ${table} WHERE persistence_id = ? AND sequence_nr < ? ORDER BY sequence_nr DESC ${config.dialect.rowLimit(1)}`,
      ),
      deleteUpTo: expand(`DELETE FROM ${table} WHERE persistence_id = ? AND sequence_nr <= ?`),
    };
  }

  protected ddl(): string[] {
    return this.dialect.snapshotDdl(this.table);
  }

  protected ownedTables(): ReadonlyArray<string> {
    return [this.table];
  }

  async save<S>(persistenceId: string, seq: number, state: S, options?: PersistenceOptions): Promise<Snapshot<S>> {
    const pool = await this.ensureOpen();
    const now = Date.now();
    let payload: string;
    try {
      payload = await sealPayload(
        encodePayload(state, this.serializer), persistenceId, snapshotPayloadContext(persistenceId, seq), options,
      );
    } catch (e) {
      throw new JournalError(
        `${this.storeName}.save: cannot seal the snapshot of ${persistenceId}@${seq}: ${(e as Error).message}`, e,
      );
    }
    try {
      await pool.query(this.statements.upsert, [persistenceId, seq, payload, now]);
    } catch (e) {
      this.fail('save', e);
    }
    // Best-effort prune — outside the write's catch on purpose.  See the
    // retention note on `SnapshotStore.save`.
    if (this.keepN > 0) {
      const { sql, params } = this.statements.prune;
      try { await pool.query(sql, params(persistenceId, this.keepN)); } catch { /* swallow */ }
    }
    return { persistenceId, sequenceNr: seq, state, timestamp: now };
  }

  async loadLatest<S>(persistenceId: string, options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const pool = await this.ensureOpen();
    const result = await pool.query(this.statements.latest, [persistenceId]);
    const row = result.rows[0] as unknown as SnapshotRow | undefined;
    return row ? some(await this.toSnapshot<S>(row, options)) : none;
  }

  async loadBefore<S>(persistenceId: string, seq: number, options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const pool = await this.ensureOpen();
    const result = await pool.query(this.statements.before, [persistenceId, seq]);
    const row = result.rows[0] as unknown as SnapshotRow | undefined;
    return row ? some(await this.toSnapshot<S>(row, options)) : none;
  }

  async delete(persistenceId: string, toSeq: number): Promise<void> {
    const pool = await this.ensureOpen();
    await pool.query(this.statements.deleteUpTo, [persistenceId, toSeq]);
  }

  /* --------------------------- internals -------------------------------- */

  private async toSnapshot<S>(row: SnapshotRow, options: PersistenceOptions | undefined): Promise<Snapshot<S>> {
    const sequenceNr = Number(row.sequence_nr);
    let json: string;
    try {
      json = await openPayload(
        row.payload, row.persistence_id, snapshotPayloadContext(row.persistence_id, sequenceNr), options, this.readPolicy,
      );
    } catch (e) {
      throw new JournalError(
        `${this.storeName}: snapshot ${row.persistence_id}@${sequenceNr} refused: ${(e as Error).message}`, e,
      );
    }
    return {
      persistenceId: row.persistence_id,
      sequenceNr,
      state: decodePayload(json, this.serializer) as S,
      timestamp: Number(row.timestamp),
    };
  }
}
