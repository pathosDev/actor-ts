/**
 * In-process fake of the `@libsql/client` API — enough SQLite to exercise
 * `LibSqlJournal` / `LibSqlSnapshotStore` / `LibSqlDurableStateStore` in the
 * fast `bun test` pass without a live `sqld`.  Same idea as `FakePgPool`: it
 * recognises the *specific* statements those stores emit rather than being a
 * SQL engine, and keeps rows in memory.
 *
 * Fidelity choices that make the tests meaningful:
 *   - the events primary key `(persistence_id, sequence_nr)` is enforced, and a
 *     duplicate insert throws with `code = 'SQLITE_CONSTRAINT_PRIMARYKEY'`,
 *     driving the journal's unique-violation concurrency backstop;
 *   - `rowsAffected` is reported for INSERT / UPDATE / DELETE, so the
 *     durable-state CAS (`ON CONFLICT DO NOTHING`, `UPDATE … WHERE revision =
 *     …`) is genuinely exercised;
 *   - `transaction()` hands back an interactive handle, which is what the real
 *     client does over HTTP and what the pool adapter relies on.  Statements
 *     apply immediately (like `FakePgPool`), so the fake does not model
 *     rollback of already-applied writes — the live Docker suite covers that.
 */
import type {
  LibSqlClientLike,
  LibSqlResultSet,
  LibSqlStatement,
  LibSqlTransactionLike,
} from '../../../../src/persistence/journals/LibSqlClient.js';
import { pagePersistenceIds } from './PersistenceIdPaging.js';

type EventRow = { persistence_id: string; sequence_nr: number; payload: string; tags: string | null; timestamp: number; };
type TagRow = { persistence_id: string; sequence_nr: number; tag: string; timestamp: number; };
type SnapshotRow = { persistence_id: string; sequence_nr: number; payload: string; timestamp: number; };
type StateRow = { persistence_id: string; revision: number; payload: string; timestamp: number; };

class SqliteConstraintViolation extends Error {
  readonly code = 'SQLITE_CONSTRAINT_PRIMARYKEY';
  constructor(message: string) {
    super(`SQLITE_CONSTRAINT: ${message}`);
    this.name = 'SqliteError';
  }
}

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const tableAfter = (sql: string, keyword: string): string => {
  const match = new RegExp(`${keyword}\\s+(?:IF NOT EXISTS\\s+)?([A-Za-z_][A-Za-z0-9_]*)`, 'i').exec(sql);
  if (!match) throw new Error(`FakeLibSqlClient: cannot parse table after ${keyword} in: ${sql}`);
  return match[1]!;
};

export class FakeLibSqlClient implements LibSqlClientLike {
  // Keyed by table name so configurable table names still work.
  private readonly events = new Map<string, EventRow[]>();
  private readonly tags = new Map<string, TagRow[]>();
  private readonly snapshots = new Map<string, SnapshotRow[]>();
  private readonly states = new Map<string, Map<string, StateRow>>();
  /** Compaction high-water mark: meta table → persistence id → deleted_to. */
  private readonly meta = new Map<string, Map<string, number>>();
  closed = false;
  /** Every statement text, in order — lets tests assert on the issued SQL. */
  readonly log: string[] = [];

  async execute(statement: LibSqlStatement): Promise<LibSqlResultSet> {
    const sql = norm(statement.sql);
    this.log.push(sql);
    const args = statement.args as unknown[];

    if (/^CREATE (TABLE|INDEX)/i.test(sql)) return rowsOnly([]);

    /* ------------------------------- journal ------------------------------ */

    if (/^SELECT COALESCE\(MAX\(sequence_nr\), 0\) AS hi FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const highest = (this.events.get(table) ?? [])
        .filter((row) => row.persistence_id === args[0])
        .reduce((high, row) => Math.max(high, row.sequence_nr), 0);
      return rowsOnly([{ hi: highest }]);
    }

    if (/^SELECT COALESCE\(deleted_to, 0\) AS d FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const mark = this.meta.get(table)?.get(args[0] as string);
      return mark === undefined ? rowsOnly([]) : rowsOnly([{ d: mark }]);
    }

    if (/^INSERT INTO \w+\(persistence_id, deleted_to\)/i.test(sql)) {
      const table = tableAfter(sql, 'INTO');
      const marks = this.meta.get(table) ?? this.meta.set(table, new Map()).get(table)!;
      const [persistenceId, deletedTo] = args as [string, number];
      // ON CONFLICT … DO UPDATE SET deleted_to = MAX(deleted_to, excluded.deleted_to)
      marks.set(persistenceId, Math.max(marks.get(persistenceId) ?? 0, deletedTo));
      return affected(1);
    }

    if (/^INSERT INTO \w+\(persistence_id, sequence_nr, payload, tags, timestamp\)/i.test(sql)) {
      const table = tableAfter(sql, 'INTO');
      const rows = this.events.get(table) ?? this.events.set(table, []).get(table)!;
      const [persistence_id, sequence_nr, payload, tags, timestamp] =
        args as [string, number, string, string | null, number];
      if (rows.some((row) => row.persistence_id === persistence_id && row.sequence_nr === sequence_nr)) {
        throw new SqliteConstraintViolation(`UNIQUE constraint failed: ${table}.persistence_id, ${table}.sequence_nr`);
      }
      rows.push({ persistence_id, sequence_nr, payload, tags, timestamp });
      return affected(1);
    }

    if (/^INSERT OR IGNORE INTO \w+\(persistence_id, sequence_nr, tag, timestamp\)/i.test(sql)) {
      const table = tableAfter(sql, 'INTO');
      const rows = this.tags.get(table) ?? this.tags.set(table, []).get(table)!;
      const [persistence_id, sequence_nr, tag, timestamp] = args as [string, number, string, number];
      const duplicate = rows.some((row) => row.tag === tag && row.timestamp === timestamp
        && row.persistence_id === persistence_id && row.sequence_nr === sequence_nr);
      if (!duplicate) rows.push({ persistence_id, sequence_nr, tag, timestamp });
      return affected(duplicate ? 0 : 1);
    }

    if (/^SELECT persistence_id, sequence_nr, payload, tags, timestamp FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const bounded = /sequence_nr <= \?/.test(sql);
      const [persistenceId, fromSeq, toSeq] = args as [string, number, number?];
      const rows = (this.events.get(table) ?? [])
        .filter((row) => row.persistence_id === persistenceId
          && row.sequence_nr >= fromSeq
          && (!bounded || row.sequence_nr <= (toSeq as number)))
        .sort((a, b) => a.sequence_nr - b.sequence_nr);
      return rowsOnly(rows.map((row) => ({ ...row })));
    }

    if (/^SELECT DISTINCT persistence_id FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const distinct = [...new Set((this.events.get(table) ?? []).map((row) => row.persistence_id))];
      const ids = pagePersistenceIds(sql, distinct, args);
      return rowsOnly(ids.map((persistence_id) => ({ persistence_id })));
    }

    /* ------------------------------ snapshots ----------------------------- */

    if (/^INSERT INTO \w+\(persistence_id, sequence_nr, payload, timestamp\)/i.test(sql)) {
      const table = tableAfter(sql, 'INTO');
      const rows = this.snapshots.get(table) ?? this.snapshots.set(table, []).get(table)!;
      const [persistence_id, sequence_nr, payload, timestamp] = args as [string, number, string, number];
      const existing = rows.find((row) => row.persistence_id === persistence_id && row.sequence_nr === sequence_nr);
      // ON CONFLICT … DO UPDATE SET payload = excluded.payload, …
      if (existing) { existing.payload = payload; existing.timestamp = timestamp; }
      else rows.push({ persistence_id, sequence_nr, payload, timestamp });
      return affected(1);
    }

    if (/^SELECT persistence_id, sequence_nr, payload, timestamp FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const strictlyBelow = /sequence_nr < \?/.test(sql);
      const [persistenceId, seq] = args as [string, number?];
      const rows = (this.snapshots.get(table) ?? [])
        .filter((row) => row.persistence_id === persistenceId
          && (!strictlyBelow || row.sequence_nr < (seq as number)))
        .sort((a, b) => b.sequence_nr - a.sequence_nr);
      const row = rows[0];
      return rowsOnly(row ? [{ ...row }] : []);
    }

    /* ---------------------------- durable state --------------------------- */

    if (/^INSERT INTO \w+\(persistence_id, revision, payload, timestamp\)/i.test(sql)) {
      const table = tableAfter(sql, 'INTO');
      const records = this.states.get(table) ?? this.states.set(table, new Map()).get(table)!;
      const [persistence_id, revision, payload, timestamp] = args as [string, number, string, number];
      if (records.has(persistence_id)) return affected(0);   // ON CONFLICT DO NOTHING
      records.set(persistence_id, { persistence_id, revision, payload, timestamp });
      return affected(1);
    }

    if (/^UPDATE \w+ SET revision/i.test(sql)) {
      const table = tableAfter(sql, 'UPDATE');
      const records = this.states.get(table) ?? new Map<string, StateRow>();
      const [revision, payload, timestamp, persistence_id, expected] =
        args as [number, string, number, string, number];
      const current = records.get(persistence_id);
      if (!current || current.revision !== expected) return affected(0);
      records.set(persistence_id, { persistence_id, revision, payload, timestamp });
      return affected(1);
    }

    if (/^SELECT revision, payload, timestamp FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const current = this.states.get(table)?.get(args[0] as string);
      return rowsOnly(current
        ? [{ revision: current.revision, payload: current.payload, timestamp: current.timestamp }]
        : []);
    }

    if (/^SELECT revision FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const current = this.states.get(table)?.get(args[0] as string);
      return rowsOnly(current ? [{ revision: current.revision }] : []);
    }

    /* ------------------------------- deletes ------------------------------ */

    if (/^DELETE FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      // Snapshot keepN prune: … NOT IN (SELECT … LIMIT ?)
      if (/NOT IN/i.test(sql)) {
        const [persistenceId, , keepN] = args as [string, string, number];
        const forId = (this.snapshots.get(table) ?? [])
          .filter((row) => row.persistence_id === persistenceId)
          .sort((a, b) => b.sequence_nr - a.sequence_nr);
        const keep = new Set(forId.slice(0, keepN).map((row) => row.sequence_nr));
        const before = this.snapshots.get(table) ?? [];
        const after = before.filter((row) => row.persistence_id !== persistenceId || keep.has(row.sequence_nr));
        this.snapshots.set(table, after);
        return affected(before.length - after.length);
      }
      // Compaction / snapshot delete: WHERE persistence_id = ? AND sequence_nr <= ?
      if (/sequence_nr <= \?/i.test(sql)) {
        const [persistenceId, toSeq] = args as [string, number];
        let removed = 0;
        const eventRows = this.events.get(table);
        if (eventRows) {
          const kept = eventRows.filter((row) => !(row.persistence_id === persistenceId && row.sequence_nr <= toSeq));
          removed += eventRows.length - kept.length;
          this.events.set(table, kept);
        }
        const tagRows = this.tags.get(table);
        if (tagRows) {
          const kept = tagRows.filter((row) => !(row.persistence_id === persistenceId && row.sequence_nr <= toSeq));
          removed += tagRows.length - kept.length;
          this.tags.set(table, kept);
        }
        const snapshotRows = this.snapshots.get(table);
        if (snapshotRows) {
          const kept = snapshotRows.filter((row) => !(row.persistence_id === persistenceId && row.sequence_nr <= toSeq));
          removed += snapshotRows.length - kept.length;
          this.snapshots.set(table, kept);
        }
        return affected(removed);
      }
      // Durable-state delete: WHERE persistence_id = ?
      const records = this.states.get(table);
      const existed = records?.delete(args[0] as string) ?? false;
      return affected(existed ? 1 : 0);
    }

    throw new Error(`FakeLibSqlClient: unrecognised statement: ${sql}`);
  }

  async transaction(_mode?: 'write' | 'read' | 'deferred'): Promise<LibSqlTransactionLike> {
    let settled = false;
    return {
      execute: (statement: LibSqlStatement) => {
        if (settled) throw new Error('FakeLibSqlClient: transaction already settled');
        return this.execute(statement);
      },
      commit: async () => { settled = true; },
      rollback: async () => { settled = true; },
      close: () => { settled = true; },
    };
  }

  close(): void { this.closed = true; }
}

function rowsOnly(rows: ReadonlyArray<Record<string, unknown>>): LibSqlResultSet {
  return { rows, rowsAffected: 0 };
}

function affected(rowsAffected: number): LibSqlResultSet {
  return { rows: [], rowsAffected };
}
