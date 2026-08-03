import {
  DurableStateConcurrencyError,
  type DurableStateRecord,
  type DurableStateStore,
} from '../DurableStateStore.js';
import { JournalError } from '../JournalTypes.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import { none, some, type Option } from '../../util/Option.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import { assertSafeIdentifier } from '../storage/SqlIdentifier.js';
import { expandPlaceholders } from './SqlDialect.js';
import { RelationalStore, type RelationalStoreConfig } from './RelationalStore.js';
import type { SqlExecutor } from './SqlPool.js';

type StateRow = {
  revision: string | number | bigint;
  payload: string;
  timestamp: string | number | bigint;
};

export interface RelationalDurableStateStoreConfig extends RelationalStoreConfig {
  /** Durable-state table.  Default `'durable_state'`. */
  readonly table?: string;
}

/**
 * DurableStateStore over any SQL database, parameterized by `SqlDialect` — the
 * "event-free" cousin of event sourcing, one row per persistence id rewritten
 * in place.
 *
 * Optimistic concurrency rides on the `revision` column:
 *
 *   - `expectedRevision === 0` → conditional insert.  Whether a collision
 *     arrives as zero affected rows (Postgres' `ON CONFLICT DO NOTHING`) or as
 *     a thrown duplicate-key error (MariaDB's unguarded `INSERT`) is what
 *     `stateInsertConflictSignal` selects.  Forcing both onto one shape would
 *     mean adding `IGNORE` to the MariaDB insert, which would swallow
 *     unrelated errors too.
 *   - `expectedRevision > 0` → `UPDATE … WHERE revision = expected`; zero
 *     affected rows means the stored revision diverged.
 *
 * Either way the current revision is read back so the error can report what
 * the caller actually raced against.
 */
export class RelationalDurableStateStore extends RelationalStore implements DurableStateStore {
  private readonly table: string;
  private readonly statements: {
    readonly insert: string;
    readonly update: string;
    readonly load: string;
    readonly revision: string;
    readonly deleteRow: string;
  };

  constructor(config: RelationalDurableStateStoreConfig) {
    super(config);
    const table = assertSafeIdentifier(config.table ?? 'durable_state', 'durable-state table');
    this.table = table;

    const expand = (sql: string): string => expandPlaceholders(sql, config.dialect);
    this.statements = {
      insert: config.dialect.insertStateSql(table),
      update: expand(
        `UPDATE ${table} SET revision = ?, payload = ?, timestamp = ? WHERE persistence_id = ? AND revision = ?`,
      ),
      load: expand(`SELECT revision, payload, timestamp FROM ${table} WHERE persistence_id = ?`),
      revision: expand(`SELECT revision FROM ${table} WHERE persistence_id = ?`),
      deleteRow: expand(`DELETE FROM ${table} WHERE persistence_id = ?`),
    };
  }

  protected ddl(): string[] {
    return this.dialect.durableStateDdl(this.table);
  }

  async upsert<S>(
    persistenceId: string,
    expectedRevision: number,
    state: S,
    _options?: PersistenceOptions,
  ): Promise<DurableStateRecord<S>> {
    // A bogus revision is a caller bug, not a lost race — reporting it as a
    // concurrency conflict would invite an endless retry loop.
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new JournalError(
        `${this.storeName}.upsert: expectedRevision must be a non-negative integer, got ${expectedRevision}`,
      );
    }
    const pool = await this.ensureOpen();
    const now = Date.now();
    const newRevision = expectedRevision + 1;
    const payload = encodePayload(state);
    try {
      if (expectedRevision === 0) {
        await this.insert(pool, persistenceId, newRevision, payload, now, expectedRevision);
      } else {
        const result = await pool.query(this.statements.update, [
          newRevision, payload, now, persistenceId, expectedRevision,
        ]);
        if (result.affectedRows === 0) {
          throw new DurableStateConcurrencyError(
            persistenceId, expectedRevision, await this.currentRevision(pool, persistenceId),
          );
        }
      }
      return { persistenceId, revision: newRevision, state, timestamp: now };
    } catch (e) {
      if (e instanceof DurableStateConcurrencyError) throw e;
      // Same hole the journal had (#479): a CAS loser can be aborted for
      // contention instead of losing on the duplicate key or the affected-row
      // count, and that owes the caller a concurrency error too.  Confirmed
      // against the stored revision first — a contention abort on its own
      // does not prove someone else won.
      if (this.dialect.isSerializationConflictError(e)) {
        const actual = await this.currentRevision(pool, persistenceId).catch(() => expectedRevision);
        if (actual !== expectedRevision) {
          throw new DurableStateConcurrencyError(persistenceId, expectedRevision, actual);
        }
      }
      this.fail('upsert', e);
    }
  }

  async load<S>(persistenceId: string, _options?: PersistenceOptions): Promise<Option<DurableStateRecord<S>>> {
    const pool = await this.ensureOpen();
    const result = await pool.query(this.statements.load, [persistenceId]);
    const row = result.rows[0] as unknown as StateRow | undefined;
    if (!row) return none;
    return some({
      persistenceId,
      revision: Number(row.revision),
      state: decodePayload(row.payload) as S,
      timestamp: Number(row.timestamp),
    });
  }

  async delete(persistenceId: string): Promise<void> {
    const pool = await this.ensureOpen();
    await pool.query(this.statements.deleteRow, [persistenceId]);
  }

  /* --------------------------- internals -------------------------------- */

  /** Conditional insert, reading the collision signal the dialect declares. */
  private async insert(
    pool: SqlExecutor,
    persistenceId: string,
    newRevision: number,
    payload: string,
    now: number,
    expectedRevision: number,
  ): Promise<void> {
    const params = [persistenceId, newRevision, payload, now];
    if (this.dialect.stateInsertConflictSignal === 'affected-rows') {
      const result = await pool.query(this.statements.insert, params);
      if (result.affectedRows === 0) {
        throw new DurableStateConcurrencyError(
          persistenceId, expectedRevision, await this.currentRevision(pool, persistenceId),
        );
      }
      return;
    }
    try {
      await pool.query(this.statements.insert, params);
    } catch (e) {
      if (this.dialect.isDuplicateKeyError(e)) {
        throw new DurableStateConcurrencyError(
          persistenceId, expectedRevision, await this.currentRevision(pool, persistenceId),
        );
      }
      throw e;
    }
  }

  /** Read the stored revision for conflict reporting; 0 when the row is gone. */
  private async currentRevision(pool: SqlExecutor, persistenceId: string): Promise<number> {
    const result = await pool.query(this.statements.revision, [persistenceId]);
    const row = result.rows[0] as { revision: string | number | bigint } | undefined;
    return row ? Number(row.revision) : 0;
  }
}
