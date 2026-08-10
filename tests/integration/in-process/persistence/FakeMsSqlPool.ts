/**
 * In-process fake of the `mssql` `ConnectionPool` API — enough T-SQL to
 * exercise `MsSqlJournal` / `MsSqlSnapshotStore` / `MsSqlDurableStateStore` in
 * the fast `bun test` pass without a live SQL Server.  Same idea as
 * `FakePgPool`: it recognises the *specific* statements those stores emit
 * rather than being a SQL engine, and keeps rows in memory.
 *
 * Fidelity choices that make the tests meaningful:
 *   - **Named parameters.** `input('p1', …)` collects into a map and the
 *     statement is read via `@pN`, so the adapter's array → named mapping is
 *     genuinely exercised — including the statements that reference the same
 *     parameter twice (`MERGE`, the `keepN` prune), which is the one thing no
 *     other backend does.
 *   - **A Request may run once.** The real driver rejects re-binding a
 *     parameter on a Request that has already executed; enforcing that here is
 *     what proves the adapter takes a fresh Request per statement.
 *   - The events primary key is enforced, and a duplicate insert throws with
 *     `number = 2627`, driving the journal's concurrency backstop.
 *   - `rowsAffected` is an **array**, as the real driver reports it.
 */
import type {
  MsSqlPoolLike,
  MsSqlRequestLike,
  MsSqlResult,
  MsSqlTransactionLike,
} from '../../../../src/persistence/journals/MsSqlClient.js';
import { pagePersistenceIds } from './PersistenceIdPaging.js';

type EventRow = { persistence_id: string; sequence_nr: number; payload: string; tags: string | null; timestamp: number; };
type TagRow = { persistence_id: string; sequence_nr: number; tag: string; timestamp: number; };
type SnapshotRow = { persistence_id: string; sequence_nr: number; payload: string; timestamp: number; };
type StateRow = { persistence_id: string; revision: number; payload: string; timestamp: number; };

class MsSqlUniqueViolation extends Error {
  /** 2627 — violation of PRIMARY KEY / UNIQUE constraint. */
  readonly number = 2627;
  constructor(message: string) { super(message); this.name = 'RequestError'; }
}

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
/** Bracket-quoted identifiers are how the T-SQL dialect writes table names. */
const tableAfter = (sql: string, keyword: string): string => {
  const match = new RegExp(`${keyword}\\s+\\[([A-Za-z_][A-Za-z0-9_]*)\\]`, 'i').exec(sql)
    ?? new RegExp(`${keyword}\\s+([A-Za-z_][A-Za-z0-9_]*)`, 'i').exec(sql);
  if (!match) throw new Error(`FakeMsSqlPool: cannot parse table after ${keyword} in: ${sql}`);
  return match[1]!;
};
/** Strip brackets so the shared and dialect-owned statements match one branch. */
const unbracket = (sql: string): string => sql.replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, '$1');

export class FakeMsSqlPool implements MsSqlPoolLike {
  private readonly events = new Map<string, EventRow[]>();
  private readonly tags = new Map<string, TagRow[]>();
  private readonly snapshots = new Map<string, SnapshotRow[]>();
  private readonly states = new Map<string, Map<string, StateRow>>();
  /** Compaction high-water mark: meta table → persistence id → deleted_to. */
  private readonly meta = new Map<string, Map<string, number>>();
  closed = false;
  /** Every statement text, in order — lets tests assert on the issued SQL. */
  readonly log: string[] = [];
  /** Transaction lifecycle, in order — 'begin' | 'commit' | 'rollback'. */
  readonly transactionLog: string[] = [];

  request(): MsSqlRequestLike {
    return new FakeMsSqlRequest(this);
  }

  transaction(): MsSqlTransactionLike {
    const pool = this;
    let state: 'open' | 'settled' = 'open';
    return {
      async begin() { pool.transactionLog.push('begin'); },
      async commit() {
        if (state === 'settled') throw new Error('FakeMsSqlPool: transaction already settled');
        state = 'settled';
        pool.transactionLog.push('commit');
      },
      async rollback() {
        if (state === 'settled') throw new Error('FakeMsSqlPool: transaction already settled');
        state = 'settled';
        pool.transactionLog.push('rollback');
      },
      request() { return new FakeMsSqlRequest(pool); },
    };
  }

  async close(): Promise<void> { this.closed = true; }

  /** Run one statement with its named parameters already collected. */
  execute(rawSql: string, params: ReadonlyMap<string, unknown>): MsSqlResult {
    const sql = norm(unbracket(rawSql));
    this.log.push(sql);
    const argument = (name: string): unknown => params.get(name);

    if (/^IF OBJECT_ID/i.test(sql) || /^IF NOT EXISTS \(SELECT 1 FROM sys\.indexes/i.test(sql)) {
      return rowsOnly([]);
    }

    /* ------------------------------- journal ------------------------------ */

    if (/^SELECT COALESCE\(MAX\(sequence_nr\), 0\) AS hi FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const highest = (this.events.get(table) ?? [])
        .filter((row) => row.persistence_id === argument('p1'))
        .reduce((high, row) => Math.max(high, row.sequence_nr), 0);
      return rowsOnly([{ hi: highest }]);
    }

    if (/^SELECT COALESCE\(deleted_to, 0\) AS d FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const mark = this.meta.get(table)?.get(argument('p1') as string);
      return mark === undefined ? rowsOnly([]) : rowsOnly([{ d: mark }]);
    }

    // MERGE onto the meta table — monotonic deleted_to.
    if (/^MERGE INTO \w+ WITH \(HOLDLOCK\) AS target USING \(SELECT @p1 AS persistence_id, @p2 AS deleted_to\)/i.test(sql)) {
      const table = tableAfter(sql, 'INTO');
      const marks = this.meta.get(table) ?? this.meta.set(table, new Map()).get(table)!;
      const persistenceId = argument('p1') as string;
      const deletedTo = argument('p2') as number;
      marks.set(persistenceId, Math.max(marks.get(persistenceId) ?? 0, deletedTo));
      return affected(1);
    }

    if (/^INSERT INTO \w+\s*\(persistence_id, sequence_nr, payload, tags, timestamp\) VALUES/i.test(sql)) {
      const table = tableAfter(sql, 'INTO');
      const rows = this.events.get(table) ?? this.events.set(table, []).get(table)!;
      const persistence_id = argument('p1') as string;
      const sequence_nr = argument('p2') as number;
      if (rows.some((row) => row.persistence_id === persistence_id && row.sequence_nr === sequence_nr)) {
        throw new MsSqlUniqueViolation(
          `Violation of PRIMARY KEY constraint 'PK_${table}'. Cannot insert duplicate key.`,
        );
      }
      rows.push({
        persistence_id, sequence_nr,
        payload: argument('p3') as string,
        tags: argument('p4') as string | null,
        timestamp: argument('p5') as number,
      });
      return affected(1);
    }

    // Tag insert: INSERT … SELECT … WHERE NOT EXISTS (T-SQL's insert-if-absent).
    if (/^INSERT INTO \w+\s*\(persistence_id, sequence_nr, tag, timestamp\) SELECT/i.test(sql)) {
      const table = tableAfter(sql, 'INTO');
      const rows = this.tags.get(table) ?? this.tags.set(table, []).get(table)!;
      const row: TagRow = {
        persistence_id: argument('p1') as string,
        sequence_nr: argument('p2') as number,
        tag: argument('p3') as string,
        timestamp: argument('p4') as number,
      };
      const exists = rows.some((existing) => existing.tag === row.tag && existing.timestamp === row.timestamp
        && existing.persistence_id === row.persistence_id && existing.sequence_nr === row.sequence_nr);
      if (!exists) rows.push(row);
      return affected(exists ? 0 : 1);
    }

    if (/^SELECT persistence_id, sequence_nr, payload, tags, timestamp FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const bounded = /sequence_nr <= @p3/.test(sql);
      const persistenceId = argument('p1') as string;
      const fromSeq = argument('p2') as number;
      const toSeq = argument('p3') as number | undefined;
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
      const ids = pagePersistenceIds(sql, distinct, [argument('p1')]);
      return rowsOnly(ids.map((persistence_id) => ({ persistence_id })));
    }

    /* ------------------------------ snapshots ----------------------------- */

    if (/^MERGE INTO \w+ WITH \(HOLDLOCK\) AS target USING \(SELECT @p1 AS persistence_id, @p2 AS sequence_nr\)/i.test(sql)) {
      const table = tableAfter(sql, 'INTO');
      const rows = this.snapshots.get(table) ?? this.snapshots.set(table, []).get(table)!;
      const persistence_id = argument('p1') as string;
      const sequence_nr = argument('p2') as number;
      const payload = argument('p3') as string;
      const timestamp = argument('p4') as number;
      const existing = rows.find((row) => row.persistence_id === persistence_id && row.sequence_nr === sequence_nr);
      if (existing) { existing.payload = payload; existing.timestamp = timestamp; }
      else rows.push({ persistence_id, sequence_nr, payload, timestamp });
      return affected(1);
    }

    if (/^SELECT persistence_id, sequence_nr, payload, timestamp FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const strictlyBelow = /sequence_nr < @p2/.test(sql);
      const persistenceId = argument('p1') as string;
      const seq = argument('p2') as number | undefined;
      const rows = (this.snapshots.get(table) ?? [])
        .filter((row) => row.persistence_id === persistenceId
          && (!strictlyBelow || row.sequence_nr < (seq as number)))
        .sort((a, b) => b.sequence_nr - a.sequence_nr);
      const row = rows[0];
      return rowsOnly(row ? [{ ...row }] : []);
    }

    /* ---------------------------- durable state --------------------------- */

    if (/^INSERT INTO \w+\s*\(persistence_id, revision, payload, timestamp\) VALUES/i.test(sql)) {
      const table = tableAfter(sql, 'INTO');
      const records = this.states.get(table) ?? this.states.set(table, new Map()).get(table)!;
      const persistence_id = argument('p1') as string;
      if (records.has(persistence_id)) {
        throw new MsSqlUniqueViolation(
          `Violation of PRIMARY KEY constraint 'PK_${table}'. Cannot insert duplicate key.`,
        );
      }
      records.set(persistence_id, {
        persistence_id,
        revision: argument('p2') as number,
        payload: argument('p3') as string,
        timestamp: argument('p4') as number,
      });
      return affected(1);
    }

    if (/^UPDATE \w+ SET revision/i.test(sql)) {
      const table = tableAfter(sql, 'UPDATE');
      const records = this.states.get(table) ?? new Map<string, StateRow>();
      const persistence_id = argument('p4') as string;
      const expected = argument('p5') as number;
      const current = records.get(persistence_id);
      if (!current || current.revision !== expected) return affected(0);
      records.set(persistence_id, {
        persistence_id,
        revision: argument('p1') as number,
        payload: argument('p2') as string,
        timestamp: argument('p3') as number,
      });
      return affected(1);
    }

    if (/^SELECT revision, payload, timestamp FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const current = this.states.get(table)?.get(argument('p1') as string);
      return rowsOnly(current
        ? [{ revision: current.revision, payload: current.payload, timestamp: current.timestamp }]
        : []);
    }

    if (/^SELECT revision FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const current = this.states.get(table)?.get(argument('p1') as string);
      return rowsOnly(current ? [{ revision: current.revision }] : []);
    }

    /* ------------------------------- deletes ------------------------------ */

    if (/^DELETE FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      // keepN prune: … NOT IN (SELECT TOP (@p2) …) — the persistence id is
      // bound ONCE and referenced twice, unlike every other dialect.
      if (/NOT IN/i.test(sql)) {
        const persistenceId = argument('p1') as string;
        const keepN = argument('p2') as number;
        const forId = (this.snapshots.get(table) ?? [])
          .filter((row) => row.persistence_id === persistenceId)
          .sort((a, b) => b.sequence_nr - a.sequence_nr);
        const keep = new Set(forId.slice(0, keepN).map((row) => row.sequence_nr));
        const before = this.snapshots.get(table) ?? [];
        const after = before.filter((row) => row.persistence_id !== persistenceId || keep.has(row.sequence_nr));
        this.snapshots.set(table, after);
        return affected(before.length - after.length);
      }
      if (/sequence_nr <= @p2/i.test(sql)) {
        const persistenceId = argument('p1') as string;
        const toSeq = argument('p2') as number;
        let removed = 0;
        for (const store of [this.events, this.tags, this.snapshots] as const) {
          const rows = store.get(table) as Array<{ persistence_id: string; sequence_nr: number }> | undefined;
          if (!rows) continue;
          const kept = rows.filter((row) => !(row.persistence_id === persistenceId && row.sequence_nr <= toSeq));
          removed += rows.length - kept.length;
          (store as Map<string, unknown>).set(table, kept);
        }
        return affected(removed);
      }
      const records = this.states.get(table);
      const existed = records?.delete(argument('p1') as string) ?? false;
      return affected(existed ? 1 : 0);
    }

    throw new Error(`FakeMsSqlPool: unrecognised statement: ${sql}`);
  }
}

/**
 * One `mssql` Request: collects named parameters, then runs exactly once.  The
 * single-use rule mirrors the real driver, where re-binding a parameter on a
 * Request that has already executed throws.
 */
class FakeMsSqlRequest implements MsSqlRequestLike {
  private readonly params = new Map<string, unknown>();
  private used = false;

  constructor(private readonly pool: FakeMsSqlPool) {}

  input(name: string, value: unknown): unknown {
    if (this.used) throw new Error(`FakeMsSqlPool: cannot bind ${name} on a Request that already ran`);
    if (this.params.has(name)) throw new Error(`FakeMsSqlPool: parameter ${name} bound twice`);
    this.params.set(name, value);
    return this;
  }

  async query(sql: string): Promise<MsSqlResult> {
    if (this.used) throw new Error('FakeMsSqlPool: Request already ran');
    this.used = true;
    return this.pool.execute(sql, this.params);
  }
}

function rowsOnly(recordset: ReadonlyArray<Record<string, unknown>>): MsSqlResult {
  return { recordset, rowsAffected: [0] };
}

function affected(count: number): MsSqlResult {
  return { recordset: [], rowsAffected: [count] };
}
