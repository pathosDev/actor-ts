/**
 * In-process fake of the `pg` `Pool` API — just enough SQL to exercise
 * `PostgresJournal` / `PostgresSnapshotStore` / `PostgresDurableStateStore`
 * in the fast `bun test` suite without a live database.  Same idea as
 * `FakeCassandraClient`: it recognises the *specific* statements those
 * backends emit (not a general SQL engine) and maintains row arrays in
 * memory.
 *
 * Fidelity choices that make the tests meaningful:
 *   - BIGINT columns are returned as **strings**, exactly as node-postgres
 *     does, so the backends' `Number(...)` coercion is exercised.
 *   - The events primary key `(persistence_id, sequence_nr)` is enforced;
 *     a duplicate INSERT throws an Error with `code = '23505'`, driving the
 *     journal's unique-violation concurrency backstop.
 *   - `rowCount` is reported for INSERT/UPDATE/DELETE so the durable-state
 *     CAS (`ON CONFLICT DO NOTHING` / `UPDATE … WHERE revision = …`) works.
 *
 * The real behaviour is still covered end-to-end by the live Docker suite;
 * this fake is the dependency-free unit-level counterpart.
 */
import type { PgClientLike, PgPoolLike, PgQueryResult } from '../../../../src/persistence/journals/PostgresClient.js';

interface EventRow { persistence_id: string; sequence_nr: number; payload: string; tags: string | null; timestamp: number; }
interface TagRow { persistence_id: string; sequence_nr: number; tag: string; timestamp: number; }
interface SnapRow { persistence_id: string; sequence_nr: number; payload: string; timestamp: number; }
interface StateRow { persistence_id: string; revision: number; payload: string; timestamp: number; }

class PgUniqueViolation extends Error {
  readonly code = '23505';
  constructor(message: string) { super(message); this.name = 'PgUniqueViolation'; }
}

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const tableFrom = (sql: string, kw: string): string => {
  const map = new RegExp(`${kw}\\s+(?:IF NOT EXISTS\\s+)?([A-Za-z_][A-Za-z0-9_]*)`, 'i').exec(sql);
  if (!map) throw new Error(`FakePgPool: cannot parse table after ${kw} in: ${sql}`);
  return map[1]!;
};

export class FakePgPool implements PgPoolLike {
  // Keyed by table name so configurable table names still work.
  private readonly events = new Map<string, EventRow[]>();
  private readonly tags = new Map<string, TagRow[]>();
  private readonly snaps = new Map<string, SnapRow[]>();
  private readonly states = new Map<string, Map<string, StateRow>>();
  ended = false;
  /** Every statement text, in order — lets tests assert on the issued SQL. */
  readonly log: string[] = [];

  async query(text: string, values: ReadonlyArray<unknown> = []): Promise<PgQueryResult> {
    const sql = norm(text);
    this.log.push(sql);
    const valuesArray = values as unknown[];

    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/^CREATE (TABLE|INDEX)/i.test(sql)) return { rows: [], rowCount: 0 };

    if (/^SELECT COALESCE\(MAX\(sequence_nr\), 0\) AS hi FROM/i.test(sql)) {
      const table = tableFrom(sql, 'FROM');
      const rows = (this.events.get(table) ?? []).filter((r) => r.persistence_id === valuesArray[0]);
      const hi = rows.reduce((map, r) => Math.max(map, r.sequence_nr), 0);
      return { rows: [{ hi: String(hi) }], rowCount: 1 };
    }

    if (/^INSERT INTO \w+\s*\(persistence_id, sequence_nr, payload, tags, timestamp\)/i.test(sql)) {
      const table = tableFrom(sql, 'INTO');
      const arr = this.events.get(table) ?? (this.events.set(table, []), this.events.get(table)!);
      const [persistence_id, sequence_nr, payload, tags, timestamp] = valuesArray as [string, number, string, string | null, number];
      if (arr.some((r) => r.persistence_id === persistence_id && r.sequence_nr === sequence_nr)) {
        throw new PgUniqueViolation(`duplicate key (${persistence_id}, ${sequence_nr})`);
      }
      arr.push({ persistence_id, sequence_nr, payload, tags, timestamp });
      return { rows: [], rowCount: 1 };
    }

    if (/^INSERT INTO \w+\s*\(persistence_id, sequence_nr, tag, timestamp\)/i.test(sql)) {
      const table = tableFrom(sql, 'INTO');
      const arr = this.tags.get(table) ?? (this.tags.set(table, []), this.tags.get(table)!);
      const [persistence_id, sequence_nr, tag, timestamp] = valuesArray as [string, number, string, number];
      const dup = arr.some((r) => r.tag === tag && r.timestamp === timestamp && r.persistence_id === persistence_id && r.sequence_nr === sequence_nr);
      if (!dup) arr.push({ persistence_id, sequence_nr, tag, timestamp });  // ON CONFLICT DO NOTHING
      return { rows: [], rowCount: dup ? 0 : 1 };
    }

    if (/^SELECT persistence_id, sequence_nr, payload, tags, timestamp FROM/i.test(sql)) {
      const table = tableFrom(sql, 'FROM');
      const hasUpper = sql.includes('sequence_nr <= $3');
      const [persistenceId, from, to] = valuesArray as [string, number, number?];
      const rows = (this.events.get(table) ?? [])
        .filter((r) => r.persistence_id === persistenceId && r.sequence_nr >= from && (!hasUpper || r.sequence_nr <= (to as number)))
        .sort((a, b) => a.sequence_nr - b.sequence_nr)
        .map((r) => ({ ...r, sequence_nr: String(r.sequence_nr), timestamp: String(r.timestamp) }));
      return { rows, rowCount: rows.length };
    }

    if (/^SELECT DISTINCT persistence_id FROM/i.test(sql)) {
      const table = tableFrom(sql, 'FROM');
      const ids = [...new Set((this.events.get(table) ?? []).map((r) => r.persistence_id))];
      return { rows: ids.map((persistence_id) => ({ persistence_id })), rowCount: ids.length };
    }

    if (/^DELETE FROM/i.test(sql)) {
      const table = tableFrom(sql, 'FROM');
      // events_tags / events: WHERE persistence_id=$1 AND sequence_nr <= $2
      if (/sequence_nr <= \$2/i.test(sql)) {
        const [persistenceId, toSeq] = valuesArray as [string, number];
        for (const map of [this.tags, this.events]) {
          const arr = map.get(table);
          if (arr) map.set(table, arr.filter((r) => !(r.persistence_id === persistenceId && (r as { sequence_nr: number }).sequence_nr <= toSeq)) as never);
        }
        const snapArr = this.snaps.get(table);
        if (snapArr) this.snaps.set(table, snapArr.filter((r) => !(r.persistence_id === persistenceId && r.sequence_nr <= toSeq)));
        return { rows: [], rowCount: 0 };
      }
      // snapshot keepN prune: … WHERE persistence_id=$1 AND sequence_nr NOT IN (… LIMIT $2)
      if (/NOT IN/i.test(sql)) {
        const [persistenceId, keepN] = valuesArray as [string, number];
        const arr = (this.snaps.get(table) ?? []).filter((r) => r.persistence_id === persistenceId).sort((a, b) => b.sequence_nr - a.sequence_nr);
        const keep = new Set(arr.slice(0, keepN).map((r) => r.sequence_nr));
        this.snaps.set(table, (this.snaps.get(table) ?? []).filter((r) => r.persistence_id !== persistenceId || keep.has(r.sequence_nr)));
        return { rows: [], rowCount: 0 };
      }
      // durable_state delete: WHERE persistence_id=$1
      const st = this.states.get(table); if (st) st.delete(valuesArray[0] as string);
      return { rows: [], rowCount: 0 };
    }

    // ---- snapshots ----
    if (/^INSERT INTO \w+\s*\(persistence_id, sequence_nr, payload, timestamp\)/i.test(sql)) {
      const table = tableFrom(sql, 'INTO');
      const arr = this.snaps.get(table) ?? (this.snaps.set(table, []), this.snaps.get(table)!);
      const [persistence_id, sequence_nr, payload, timestamp] = valuesArray as [string, number, string, number];
      const existing = arr.find((r) => r.persistence_id === persistence_id && r.sequence_nr === sequence_nr);
      if (existing) { existing.payload = payload; existing.timestamp = timestamp; }  // ON CONFLICT DO UPDATE
      else arr.push({ persistence_id, sequence_nr, payload, timestamp });
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT persistence_id, sequence_nr, payload, timestamp FROM/i.test(sql)) {
      const table = tableFrom(sql, 'FROM');
      const before = sql.includes('sequence_nr < $2');
      const [persistenceId, seq] = valuesArray as [string, number?];
      const rows = (this.snaps.get(table) ?? [])
        .filter((r) => r.persistence_id === persistenceId && (!before || r.sequence_nr < (seq as number)))
        .sort((a, b) => b.sequence_nr - a.sequence_nr);
      const row = rows[0];
      return { rows: row ? [{ ...row, sequence_nr: String(row.sequence_nr), timestamp: String(row.timestamp) }] : [], rowCount: row ? 1 : 0 };
    }

    // ---- durable_state ----
    if (/^INSERT INTO \w+\s*\(persistence_id, revision, payload, timestamp\)/i.test(sql)) {
      const table = tableFrom(sql, 'INTO');
      const st = this.states.get(table) ?? (this.states.set(table, new Map()), this.states.get(table)!);
      const [persistence_id, revision, payload, timestamp] = valuesArray as [string, number, string, number];
      if (st.has(persistence_id)) return { rows: [], rowCount: 0 };  // ON CONFLICT DO NOTHING
      st.set(persistence_id, { persistence_id, revision, payload, timestamp });
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE .* SET revision/i.test(sql)) {
      const table = tableFrom(sql, 'UPDATE');
      const st = this.states.get(table) ?? new Map<string, StateRow>();
      const [revision, payload, timestamp, persistence_id, expected] = valuesArray as [number, string, number, string, number];
      const cur = st.get(persistence_id);
      if (!cur || cur.revision !== expected) return { rows: [], rowCount: 0 };
      st.set(persistence_id, { persistence_id, revision, payload, timestamp });
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT revision, payload, timestamp FROM/i.test(sql)) {
      const table = tableFrom(sql, 'FROM');
      const cur = this.states.get(table)?.get(valuesArray[0] as string);
      return { rows: cur ? [{ revision: String(cur.revision), payload: cur.payload, timestamp: String(cur.timestamp) }] : [], rowCount: cur ? 1 : 0 };
    }
    if (/^SELECT revision FROM/i.test(sql)) {
      const table = tableFrom(sql, 'FROM');
      const cur = this.states.get(table)?.get(valuesArray[0] as string);
      return { rows: cur ? [{ revision: String(cur.revision) }] : [], rowCount: cur ? 1 : 0 };
    }

    throw new Error(`FakePgPool: unrecognised statement: ${sql}`);
  }

  async connect(): Promise<PgClientLike> {
    const self = this;
    return {
      query: (text: string, values?: ReadonlyArray<unknown>) => self.query(text, values),
      release: () => { /* no-op */ },
    };
  }

  async end(): Promise<void> { this.ended = true; }
}
