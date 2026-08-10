/**
 * In-process fake of the Cloudflare D1 transport.
 *
 * D1 has **no local emulator that fits a Docker suite** — outside a Worker it is
 * a REST API, and locally it only exists inside `wrangler`/Miniflare, which is a
 * Workers runtime rather than a database you can bring up in compose.  So unlike
 * every other backend, D1's verification stops at this fake, and the gap is
 * documented rather than papered over.
 *
 * Two consequences shape how faithful this has to be:
 *
 *   - It is the **only** check on the D1 code path, so it models the transport's
 *     real shape: D1 answers a rejected statement with HTTP 200 and
 *     `success: false`, and reports write counts as `meta.changes`.
 *   - The SQL underneath is `sqliteDialect`'s — byte-identical to what libSQL and
 *     local SQLite run, and already exercised against a real SQLite by
 *     `SqliteJournal`'s suite.  What is genuinely untested against a real service
 *     is the envelope handling and the error text, which is exactly what this
 *     fake pins.
 *
 * The statement engine is intentionally the same shape as `FakeLibSqlClient`'s:
 * it recognises the specific statements the SQLite dialect emits and enforces the
 * primary keys, so the journal's concurrency backstop is genuinely exercised.
 */
import type { D1ClientLike, D1QueryResult } from '../../../../src/persistence/journals/D1Client.js';
import { D1RequestError } from '../../../../src/persistence/journals/D1Client.js';
import { pagePersistenceIds } from './PersistenceIdPaging.js';

type EventRow = { persistence_id: string; sequence_nr: number; payload: string; tags: string | null; timestamp: number; };
type TagRow = { persistence_id: string; sequence_nr: number; tag: string; timestamp: number; };
type SnapshotRow = { persistence_id: string; sequence_nr: number; payload: string; timestamp: number; };
type StateRow = { persistence_id: string; revision: number; payload: string; timestamp: number; };

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const tableAfter = (sql: string, keyword: string): string => {
  const match = new RegExp(`${keyword}\\s+(?:IF NOT EXISTS\\s+)?([A-Za-z_][A-Za-z0-9_]*)`, 'i').exec(sql);
  if (!match) throw new Error(`FakeD1Client: cannot parse table after ${keyword} in: ${sql}`);
  return match[1]!;
};

export class FakeD1Client implements D1ClientLike {
  private readonly events = new Map<string, EventRow[]>();
  private readonly tags = new Map<string, TagRow[]>();
  private readonly snapshots = new Map<string, SnapshotRow[]>();
  private readonly states = new Map<string, Map<string, StateRow>>();
  /** Compaction high-water mark: meta table → persistence id → deleted_to. */
  private readonly meta = new Map<string, Map<string, number>>();
  closed = false;
  /** Every statement, in order — lets tests assert on what the stores issued. */
  readonly log: string[] = [];

  async query(rawSql: string, params: ReadonlyArray<unknown>): Promise<D1QueryResult> {
    const sql = norm(rawSql);
    this.log.push(sql);
    const args = params as unknown[];

    if (/^CREATE (TABLE|INDEX)/i.test(sql)) return rows([]);

    /* ------------------------------- journal ------------------------------ */

    if (/^SELECT COALESCE\(MAX\(sequence_nr\), 0\) AS hi FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const highest = (this.events.get(table) ?? [])
        .filter((row) => row.persistence_id === args[0])
        .reduce((high, row) => Math.max(high, row.sequence_nr), 0);
      return rows([{ hi: highest }]);
    }

    if (/^SELECT COALESCE\(deleted_to, 0\) AS d FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const mark = this.meta.get(table)?.get(args[0] as string);
      return mark === undefined ? rows([]) : rows([{ d: mark }]);
    }

    if (/^INSERT INTO \w+\(persistence_id, deleted_to\)/i.test(sql)) {
      const table = tableAfter(sql, 'INTO');
      const marks = this.meta.get(table) ?? this.meta.set(table, new Map()).get(table)!;
      const [persistenceId, deletedTo] = args as [string, number];
      // ON CONFLICT … DO UPDATE SET deleted_to = MAX(deleted_to, excluded.deleted_to)
      marks.set(persistenceId, Math.max(marks.get(persistenceId) ?? 0, deletedTo));
      return changed(1);
    }

    if (/^INSERT INTO \w+\(persistence_id, sequence_nr, payload, tags, timestamp\)/i.test(sql)) {
      const table = tableAfter(sql, 'INTO');
      const stored = this.events.get(table) ?? this.events.set(table, []).get(table)!;
      const [persistence_id, sequence_nr, payload, tags, timestamp] =
        args as [string, number, string, string | null, number];
      if (stored.some((row) => row.persistence_id === persistence_id && row.sequence_nr === sequence_nr)) {
        // D1 forwards SQLite's message but not its extended result code — which
        // is why `sqliteDialect.isDuplicateKeyError` also matches on text.
        throw new D1RequestError(
          `D1_ERROR: UNIQUE constraint failed: ${table}.persistence_id, ${table}.sequence_nr`,
          7500,
        );
      }
      stored.push({ persistence_id, sequence_nr, payload, tags, timestamp });
      return changed(1);
    }

    if (/^INSERT OR IGNORE INTO \w+\(persistence_id, sequence_nr, tag, timestamp\)/i.test(sql)) {
      const table = tableAfter(sql, 'INTO');
      const stored = this.tags.get(table) ?? this.tags.set(table, []).get(table)!;
      const [persistence_id, sequence_nr, tag, timestamp] = args as [string, number, string, number];
      const duplicate = stored.some((row) => row.tag === tag && row.timestamp === timestamp
        && row.persistence_id === persistence_id && row.sequence_nr === sequence_nr);
      if (!duplicate) stored.push({ persistence_id, sequence_nr, tag, timestamp });
      return changed(duplicate ? 0 : 1);
    }

    if (/^SELECT persistence_id, sequence_nr, payload, tags, timestamp FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const bounded = /sequence_nr <= \?/.test(sql);
      const [persistenceId, fromSeq, toSeq] = args as [string, number, number?];
      const matched = (this.events.get(table) ?? [])
        .filter((row) => row.persistence_id === persistenceId
          && row.sequence_nr >= fromSeq
          && (!bounded || row.sequence_nr <= (toSeq as number)))
        .sort((a, b) => a.sequence_nr - b.sequence_nr);
      return rows(matched.map((row) => ({ ...row })));
    }

    if (/^SELECT DISTINCT persistence_id FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const distinct = [...new Set((this.events.get(table) ?? []).map((row) => row.persistence_id))];
      const ids = pagePersistenceIds(sql, distinct, args);
      return rows(ids.map((persistence_id) => ({ persistence_id })));
    }

    /* ------------------------------ snapshots ----------------------------- */

    if (/^INSERT INTO \w+\(persistence_id, sequence_nr, payload, timestamp\)/i.test(sql)) {
      const table = tableAfter(sql, 'INTO');
      const stored = this.snapshots.get(table) ?? this.snapshots.set(table, []).get(table)!;
      const [persistence_id, sequence_nr, payload, timestamp] = args as [string, number, string, number];
      const existing = stored.find((row) => row.persistence_id === persistence_id && row.sequence_nr === sequence_nr);
      if (existing) { existing.payload = payload; existing.timestamp = timestamp; }
      else stored.push({ persistence_id, sequence_nr, payload, timestamp });
      return changed(1);
    }

    if (/^SELECT persistence_id, sequence_nr, payload, timestamp FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const strictlyBelow = /sequence_nr < \?/.test(sql);
      const [persistenceId, seq] = args as [string, number?];
      const matched = (this.snapshots.get(table) ?? [])
        .filter((row) => row.persistence_id === persistenceId
          && (!strictlyBelow || row.sequence_nr < (seq as number)))
        .sort((a, b) => b.sequence_nr - a.sequence_nr);
      const row = matched[0];
      return rows(row ? [{ ...row }] : []);
    }

    /* ---------------------------- durable state --------------------------- */

    if (/^INSERT INTO \w+\(persistence_id, revision, payload, timestamp\)/i.test(sql)) {
      const table = tableAfter(sql, 'INTO');
      const records = this.states.get(table) ?? this.states.set(table, new Map()).get(table)!;
      const [persistence_id, revision, payload, timestamp] = args as [string, number, string, number];
      if (records.has(persistence_id)) return changed(0);   // ON CONFLICT DO NOTHING
      records.set(persistence_id, { persistence_id, revision, payload, timestamp });
      return changed(1);
    }

    if (/^UPDATE \w+ SET revision/i.test(sql)) {
      const table = tableAfter(sql, 'UPDATE');
      const records = this.states.get(table) ?? new Map<string, StateRow>();
      const [revision, payload, timestamp, persistence_id, expected] =
        args as [number, string, number, string, number];
      const current = records.get(persistence_id);
      if (!current || current.revision !== expected) return changed(0);
      records.set(persistence_id, { persistence_id, revision, payload, timestamp });
      return changed(1);
    }

    if (/^SELECT revision, payload, timestamp FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const current = this.states.get(table)?.get(args[0] as string);
      return rows(current
        ? [{ revision: current.revision, payload: current.payload, timestamp: current.timestamp }]
        : []);
    }

    if (/^SELECT revision FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      const current = this.states.get(table)?.get(args[0] as string);
      return rows(current ? [{ revision: current.revision }] : []);
    }

    /* ------------------------------- deletes ------------------------------ */

    if (/^DELETE FROM/i.test(sql)) {
      const table = tableAfter(sql, 'FROM');
      if (/NOT IN/i.test(sql)) {
        const [persistenceId, , keepN] = args as [string, string, number];
        const forId = (this.snapshots.get(table) ?? [])
          .filter((row) => row.persistence_id === persistenceId)
          .sort((a, b) => b.sequence_nr - a.sequence_nr);
        const keep = new Set(forId.slice(0, keepN).map((row) => row.sequence_nr));
        const before = this.snapshots.get(table) ?? [];
        const after = before.filter((row) => row.persistence_id !== persistenceId || keep.has(row.sequence_nr));
        this.snapshots.set(table, after);
        return changed(before.length - after.length);
      }
      if (/sequence_nr <= \?/i.test(sql)) {
        const [persistenceId, toSeq] = args as [string, number];
        let removed = 0;
        for (const store of [this.events, this.tags, this.snapshots] as const) {
          const stored = store.get(table) as Array<{ persistence_id: string; sequence_nr: number }> | undefined;
          if (!stored) continue;
          const kept = stored.filter((row) => !(row.persistence_id === persistenceId && row.sequence_nr <= toSeq));
          removed += stored.length - kept.length;
          (store as Map<string, unknown>).set(table, kept);
        }
        return changed(removed);
      }
      const records = this.states.get(table);
      const existed = records?.delete(args[0] as string) ?? false;
      return changed(existed ? 1 : 0);
    }

    throw new D1RequestError(`FakeD1Client: unrecognised statement: ${sql}`);
  }

  async close(): Promise<void> { this.closed = true; }
}

function rows(results: ReadonlyArray<Record<string, unknown>>): D1QueryResult {
  return { rows: results, changes: 0 };
}

function changed(changes: number): D1QueryResult {
  return { rows: [], changes };
}
