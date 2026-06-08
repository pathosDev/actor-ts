/**
 * In-process fake of the `mariadb` Pool API — enough SQL to exercise the
 * MariaDB backends in `bun test` without a live server.  Counterpart to
 * FakePgPool, with MariaDB's result shapes:
 *   - SELECT  → an array of row objects.
 *   - DML     → an OK-packet `{ affectedRows, insertId, warningStatus }`.
 * Duplicate-key INSERTs throw an error with `errno = 1062` /
 * `code = 'ER_DUP_ENTRY'`, driving the journal/durable-state CAS.  BIGINT
 * columns are returned as `bigint` (as the connector can), exercising the
 * backends' `Number(...)` coercion.  Transactions go through
 * `getConnection()` + `beginTransaction/commit/rollback` (no-ops here).
 *
 * Real behaviour is covered by the live Docker suite; this is the
 * dependency-free unit counterpart.
 */
import type {
  MariaDbConnectionLike,
  MariaDbPoolLike,
  MariaDbResult,
  MariaDbRow,
} from '../../../../src/persistence/journals/MariaDbClient.js';

interface EventRow { persistence_id: string; sequence_nr: number; payload: string; tags: string | null; timestamp: number; }
interface TagRow { persistence_id: string; sequence_nr: number; tag: string; timestamp: number; }
interface SnapRow { persistence_id: string; sequence_nr: number; payload: string; timestamp: number; }
interface StateRow { persistence_id: string; revision: number; payload: string; timestamp: number; }

class MariaDbDupError extends Error {
  readonly errno = 1062;
  readonly code = 'ER_DUP_ENTRY';
  constructor(msg: string) { super(msg); this.name = 'MariaDbDupError'; }
}

const ok = (affectedRows: number): MariaDbResult => ({ affectedRows, insertId: 0, warningStatus: 0 });
const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const tableFrom = (sql: string, kw: string): string => {
  const m = new RegExp(`${kw}\\s+(?:IGNORE\\s+INTO\\s+|IF NOT EXISTS\\s+)?([A-Za-z_][A-Za-z0-9_]*)`, 'i').exec(sql);
  if (!m) throw new Error(`FakeMariaDbPool: cannot parse table after ${kw} in: ${sql}`);
  return m[1]!;
};

export class FakeMariaDbPool implements MariaDbPoolLike {
  private readonly events = new Map<string, EventRow[]>();
  private readonly tags = new Map<string, TagRow[]>();
  private readonly snaps = new Map<string, SnapRow[]>();
  private readonly states = new Map<string, Map<string, StateRow>>();
  ended = false;
  readonly log: string[] = [];

  async query(text: string, values: ReadonlyArray<unknown> = []): Promise<MariaDbResult> {
    const sql = norm(text);
    this.log.push(sql);
    const v = values as unknown[];

    if (/^CREATE TABLE/i.test(sql)) return ok(0);

    if (/^SELECT COALESCE\(MAX\(sequence_nr\), 0\) AS hi FROM/i.test(sql)) {
      const t = tableFrom(sql, 'FROM');
      const hi = (this.events.get(t) ?? []).filter((r) => r.persistence_id === v[0]).reduce((m, r) => Math.max(m, r.sequence_nr), 0);
      return [{ hi: BigInt(hi) }];
    }

    if (/^INSERT INTO \w+\s*\(persistence_id, sequence_nr, payload, tags, timestamp\)/i.test(sql)) {
      const t = tableFrom(sql, 'INTO');
      const arr = this.events.get(t) ?? (this.events.set(t, []), this.events.get(t)!);
      const [persistence_id, sequence_nr, payload, tags, timestamp] = v as [string, number, string, string | null, number];
      if (arr.some((r) => r.persistence_id === persistence_id && r.sequence_nr === sequence_nr)) {
        throw new MariaDbDupError(`duplicate (${persistence_id}, ${sequence_nr})`);
      }
      arr.push({ persistence_id, sequence_nr, payload, tags, timestamp });
      return ok(1);
    }

    if (/^INSERT IGNORE INTO \w+\s*\(persistence_id, sequence_nr, tag, timestamp\)/i.test(sql)) {
      const t = tableFrom(sql, 'INTO');
      const arr = this.tags.get(t) ?? (this.tags.set(t, []), this.tags.get(t)!);
      const [persistence_id, sequence_nr, tag, timestamp] = v as [string, number, string, number];
      const dup = arr.some((r) => r.tag === tag && r.timestamp === timestamp && r.persistence_id === persistence_id && r.sequence_nr === sequence_nr);
      if (!dup) arr.push({ persistence_id, sequence_nr, tag, timestamp });
      return ok(dup ? 0 : 1);
    }

    if (/^SELECT persistence_id, sequence_nr, payload, tags, timestamp FROM/i.test(sql)) {
      const t = tableFrom(sql, 'FROM');
      const hasUpper = sql.includes('sequence_nr <= ?');
      const [pid, from, to] = v as [string, number, number?];
      const rows: MariaDbRow[] = (this.events.get(t) ?? [])
        .filter((r) => r.persistence_id === pid && r.sequence_nr >= from && (!hasUpper || r.sequence_nr <= (to as number)))
        .sort((a, b) => a.sequence_nr - b.sequence_nr)
        .map((r) => ({ ...r, sequence_nr: BigInt(r.sequence_nr), timestamp: BigInt(r.timestamp) }));
      return rows;
    }

    if (/^SELECT DISTINCT persistence_id FROM/i.test(sql)) {
      const t = tableFrom(sql, 'FROM');
      return [...new Set((this.events.get(t) ?? []).map((r) => r.persistence_id))].map((persistence_id) => ({ persistence_id }));
    }

    if (/^DELETE FROM/i.test(sql)) {
      const t = tableFrom(sql, 'FROM');
      if (/sequence_nr <= \?/i.test(sql)) {
        const [pid, toSeq] = v as [string, number];
        const tagArr = this.tags.get(t); if (tagArr) this.tags.set(t, tagArr.filter((r) => !(r.persistence_id === pid && r.sequence_nr <= toSeq)));
        const evArr = this.events.get(t); if (evArr) this.events.set(t, evArr.filter((r) => !(r.persistence_id === pid && r.sequence_nr <= toSeq)));
        const snapArr = this.snaps.get(t); if (snapArr) this.snaps.set(t, snapArr.filter((r) => !(r.persistence_id === pid && r.sequence_nr <= toSeq)));
        return ok(0);
      }
      if (/NOT IN/i.test(sql)) {
        const [pid, , keepN] = v as [string, string, number];
        const arr = (this.snaps.get(t) ?? []).filter((r) => r.persistence_id === pid).sort((a, b) => b.sequence_nr - a.sequence_nr);
        const keep = new Set(arr.slice(0, keepN).map((r) => r.sequence_nr));
        this.snaps.set(t, (this.snaps.get(t) ?? []).filter((r) => r.persistence_id !== pid || keep.has(r.sequence_nr)));
        return ok(0);
      }
      const st = this.states.get(t); if (st) st.delete(v[0] as string);
      return ok(0);
    }

    // ---- snapshots ----
    if (/^INSERT INTO \w+\s*\(persistence_id, sequence_nr, payload, timestamp\)/i.test(sql)) {
      const t = tableFrom(sql, 'INTO');
      const arr = this.snaps.get(t) ?? (this.snaps.set(t, []), this.snaps.get(t)!);
      const [persistence_id, sequence_nr, payload, timestamp] = v as [string, number, string, number];
      const existing = arr.find((r) => r.persistence_id === persistence_id && r.sequence_nr === sequence_nr);
      if (existing) { existing.payload = payload; existing.timestamp = timestamp; return ok(2); }  // ON DUPLICATE KEY UPDATE
      arr.push({ persistence_id, sequence_nr, payload, timestamp });
      return ok(1);
    }
    if (/^SELECT persistence_id, sequence_nr, payload, timestamp FROM/i.test(sql)) {
      const t = tableFrom(sql, 'FROM');
      const before = sql.includes('sequence_nr < ?');
      const [pid, seq] = v as [string, number?];
      const rows = (this.snaps.get(t) ?? [])
        .filter((r) => r.persistence_id === pid && (!before || r.sequence_nr < (seq as number)))
        .sort((a, b) => b.sequence_nr - a.sequence_nr);
      const row = rows[0];
      return row ? [{ ...row, sequence_nr: BigInt(row.sequence_nr), timestamp: BigInt(row.timestamp) }] : [];
    }

    // ---- durable_state ----
    if (/^INSERT INTO \w+\s*\(persistence_id, revision, payload, timestamp\)/i.test(sql)) {
      const t = tableFrom(sql, 'INTO');
      const st = this.states.get(t) ?? (this.states.set(t, new Map()), this.states.get(t)!);
      const [persistence_id, revision, payload, timestamp] = v as [string, number, string, number];
      if (st.has(persistence_id)) throw new MariaDbDupError(`duplicate key ${persistence_id}`);
      st.set(persistence_id, { persistence_id, revision, payload, timestamp });
      return ok(1);
    }
    if (/^UPDATE \w+ SET revision/i.test(sql)) {
      const t = tableFrom(sql, 'UPDATE');
      const st = this.states.get(t) ?? new Map<string, StateRow>();
      const [revision, payload, timestamp, persistence_id, expected] = v as [number, string, number, string, number];
      const cur = st.get(persistence_id);
      if (!cur || cur.revision !== expected) return ok(0);
      st.set(persistence_id, { persistence_id, revision, payload, timestamp });
      return ok(1);
    }
    if (/^SELECT revision, payload, timestamp FROM/i.test(sql)) {
      const t = tableFrom(sql, 'FROM');
      const cur = this.states.get(t)?.get(v[0] as string);
      return cur ? [{ revision: BigInt(cur.revision), payload: cur.payload, timestamp: BigInt(cur.timestamp) }] : [];
    }
    if (/^SELECT revision FROM/i.test(sql)) {
      const t = tableFrom(sql, 'FROM');
      const cur = this.states.get(t)?.get(v[0] as string);
      return cur ? [{ revision: BigInt(cur.revision) }] : [];
    }

    throw new Error(`FakeMariaDbPool: unrecognised statement: ${sql}`);
  }

  async getConnection(): Promise<MariaDbConnectionLike> {
    const self = this;
    return {
      query: (text: string, values?: ReadonlyArray<unknown>) => self.query(text, values),
      beginTransaction: async () => { /* no-op */ },
      commit: async () => { /* no-op */ },
      rollback: async () => { /* no-op */ },
      release: () => { /* no-op */ },
    };
  }

  async end(): Promise<void> { this.ended = true; }
}
