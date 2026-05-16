import type {
  CassandraBatchQuery,
  CassandraClientLike,
  CassandraRowResult,
} from '../../../../src/persistence/index.js';

/**
 * In-memory CQL simulator sufficient for the plug-in tests.  It parses a
 * tiny subset of CQL — just enough to round-trip the INSERT / SELECT /
 * DELETE / CREATE statements the journal + snapshot store issue.  Not a
 * general-purpose Cassandra stand-in.
 *
 * Statements supported:
 *   - CREATE KEYSPACE / CREATE TABLE ... IF NOT EXISTS (no-op; kept for DDL)
 *   - INSERT INTO keyspace.table (c1, c2, ...) VALUES (?, ?, ...)
 *   - SELECT col1, col2, ... FROM keyspace.table WHERE <eq-clauses>
 *       [AND seq >= ?] [AND seq <= ?] [AND seq < ?] [LIMIT N]
 *   - DELETE FROM keyspace.table WHERE <eq-clauses> [AND seq <= ?] [AND seq < ?]
 *
 * Every row is stored as a string-keyed record.  Numeric params coerce to
 * Number; other types pass through.
 */

type Row = Record<string, unknown>;

interface TableState {
  readonly table: string;
  readonly rows: Row[];
}

interface SelectPlan {
  readonly table: string;
  readonly columns: string[] | '*';
  readonly filters: ReadonlyArray<{ column: string; op: '=' | '>=' | '<=' | '<'; index: number }>;
  /** `LIMIT N` → literal value; `LIMIT ?` → parameter index; absent → null. */
  readonly limit: { kind: 'literal'; value: number } | { kind: 'param'; index: number } | null;
}

interface InsertPlan {
  readonly table: string;
  readonly columns: string[];
}

interface DeletePlan {
  readonly table: string;
  readonly filters: ReadonlyArray<{ column: string; op: '=' | '<=' | '<'; index: number }>;
}

export class FakeCassandraClient implements CassandraClientLike {
  private readonly tables = new Map<string, TableState>();
  private connected = false;
  private shuttingDown = false;

  async connect(): Promise<void> { this.connected = true; }
  async shutdown(): Promise<void> { this.shuttingDown = true; this.connected = false; }

  async execute(
    query: string,
    params: ReadonlyArray<unknown> = [],
    _options?: { prepare?: boolean; consistency?: number },
  ): Promise<CassandraRowResult> {
    const q = query.trim().replace(/\s+/g, ' ');
    const upper = q.toUpperCase();
    if (upper.startsWith('CREATE KEYSPACE') || upper.startsWith('CREATE TABLE')) {
      // DDL — no-op in the fake.
      return { rows: [] };
    }
    if (upper.startsWith('INSERT')) {
      this.handleInsert(q, params);
      return { rows: [] };
    }
    if (upper.startsWith('SELECT')) {
      return { rows: this.handleSelect(q, params) };
    }
    if (upper.startsWith('DELETE')) {
      this.handleDelete(q, params);
      return { rows: [] };
    }
    throw new Error(`FakeCassandraClient: unsupported statement: ${q}`);
  }

  async batch(
    queries: ReadonlyArray<CassandraBatchQuery>,
    _options?: { prepare?: boolean; logged?: boolean; consistency?: number },
  ): Promise<void> {
    for (const q of queries) await this.execute(q.query, q.params ?? []);
  }

  /** Expose row count — convenient for tests. */
  countRows(keyspaceDotTable: string): number {
    return this.tables.get(keyspaceDotTable)?.rows.length ?? 0;
  }

  get isConnected(): boolean { return this.connected && !this.shuttingDown; }

  /* ============================== internals ============================== */

  private stateOf(table: string): TableState {
    let s = this.tables.get(table);
    if (!s) { s = { table, rows: [] }; this.tables.set(table, s); }
    return s;
  }

  private handleInsert(q: string, params: ReadonlyArray<unknown>): void {
    const plan = parseInsert(q);
    if (!plan) throw new Error(`FakeCassandraClient: cannot parse INSERT: ${q}`);
    const row: Row = {};
    plan.columns.forEach((col, i) => { row[col] = params[i]; });
    const state = this.stateOf(plan.table);
    // Simple upsert semantics — replace if a row with the same PK exists.
    const existing = state.rows.findIndex((r) => samePrimaryKey(r, row));
    if (existing >= 0) state.rows[existing] = row;
    else state.rows.push(row);
  }

  private handleSelect(q: string, params: ReadonlyArray<unknown>): Row[] {
    const plan = parseSelect(q);
    if (!plan) throw new Error(`FakeCassandraClient: cannot parse SELECT: ${q}`);
    const state = this.tables.get(plan.table);
    if (!state) return [];
    let rows = state.rows.filter((row) => plan.filters.every((f) => matches(row, f, params)));
    // Cassandra orders rows by clustering columns — for our tests we just
    // sort by sequence_nr if present.
    rows = rows.slice().sort((a, b) => {
      const sa = typeof a.sequence_nr === 'number' ? a.sequence_nr : Number(a.sequence_nr ?? 0);
      const sb = typeof b.sequence_nr === 'number' ? b.sequence_nr : Number(b.sequence_nr ?? 0);
      return sa - sb;
    });
    // Honour CLUSTERING ORDER BY (sequence_nr DESC) from the snapshot table —
    // heuristic: if the plan is on `snapshots`, reverse.
    if (plan.table.endsWith('.snapshots') || plan.table === 'snapshots') rows.reverse();
    if (plan.columns !== '*') {
      rows = rows.map((r) => {
        const projected: Row = {};
        for (const col of plan.columns) projected[col] = r[col];
        return projected;
      });
    }
    if (plan.limit !== null) {
      const limit = plan.limit.kind === 'literal'
        ? plan.limit.value
        : Number(params[plan.limit.index]);
      if (!Number.isNaN(limit)) rows = rows.slice(0, limit);
    }
    return rows;
  }

  private handleDelete(q: string, params: ReadonlyArray<unknown>): void {
    const plan = parseDelete(q);
    if (!plan) throw new Error(`FakeCassandraClient: cannot parse DELETE: ${q}`);
    const state = this.tables.get(plan.table);
    if (!state) return;
    state.rows = state.rows.filter((row) => !plan.filters.every((f) => matches(row, f, params)));
    this.tables.set(plan.table, state);
  }
}

/* ============================ CQL mini-parser ============================ */

function parseInsert(q: string): InsertPlan | null {
  const m = /^INSERT INTO ([\w.]+) \(([^)]+)\) VALUES \(([^)]+)\)(?:\s+IF NOT EXISTS)?$/i.exec(q);
  if (!m) return null;
  const table = m[1]!;
  const columns = m[2]!.split(',').map((c) => c.trim());
  return { table, columns };
}

function parseSelect(q: string): SelectPlan | null {
  const m = /^SELECT (.+?) FROM ([\w.]+)(?: WHERE (.+?))?(?: LIMIT (\?|\d+))?$/i.exec(q);
  if (!m) return null;
  const colsRaw = m[1]!.trim();
  const table = m[2]!;
  const whereClause = m[3]?.trim();
  const limitToken = m[4];
  const columns: string[] | '*' = colsRaw === '*' ? '*' : colsRaw.split(',').map((c) => c.trim());

  const filters: Array<{ column: string; op: '=' | '>=' | '<=' | '<'; index: number }> = [];
  let paramIndex = 0;
  if (whereClause) {
    const parts = whereClause.split(/\s+AND\s+/i);
    for (const part of parts) {
      const match = /^(\w+)\s*(=|>=|<=|<)\s*\?$/.exec(part.trim());
      if (!match) return null;
      filters.push({ column: match[1]!, op: match[2] as '=' | '>=' | '<=' | '<', index: paramIndex++ });
    }
  }
  let limit: SelectPlan['limit'] = null;
  if (limitToken === '?') limit = { kind: 'param', index: paramIndex };
  else if (limitToken !== undefined) limit = { kind: 'literal', value: Number(limitToken) };
  return { table, columns, filters, limit };
}

function parseDelete(q: string): DeletePlan | null {
  const m = /^DELETE FROM ([\w.]+) WHERE (.+)$/i.exec(q);
  if (!m) return null;
  const table = m[1]!;
  const whereClause = m[2]!.trim();
  const parts = whereClause.split(/\s+AND\s+/i);
  const filters: Array<{ column: string; op: '=' | '<=' | '<'; index: number }> = [];
  let paramIndex = 0;
  for (const part of parts) {
    const match = /^(\w+)\s*(=|<=|<)\s*\?$/.exec(part.trim());
    if (!match) return null;
    filters.push({ column: match[1]!, op: match[2] as '=' | '<=' | '<', index: paramIndex++ });
  }
  return { table, filters };
}

function matches(
  row: Row,
  filter: { column: string; op: '=' | '>=' | '<=' | '<'; index: number },
  params: ReadonlyArray<unknown>,
): boolean {
  const rowVal = row[filter.column];
  const paramVal = params[filter.index];
  if (rowVal === undefined) return false;
  switch (filter.op) {
    case '=':  return coerce(rowVal) === coerce(paramVal);
    case '>=': return coerce(rowVal) >= coerce(paramVal);
    case '<=': return coerce(rowVal) <= coerce(paramVal);
    case '<':  return coerce(rowVal) <  coerce(paramVal);
  }
}

function coerce(v: unknown): number | string {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return v as string;
}

/** Composite PK inferred from the columns present in the row. */
function samePrimaryKey(a: Row, b: Row): boolean {
  // Heuristic: events table = (persistence_id, partition_nr, sequence_nr)
  //            metadata    = (persistence_id)
  //            snapshots   = (persistence_id, sequence_nr)
  //            all_ids     = (tag, persistence_id)
  const keys = primaryKeys(a);
  return keys.every((k) => a[k] === b[k]);
}

function primaryKeys(row: Row): string[] {
  // Match more-specific shapes FIRST — `events_by_tag`'s composite key
  // is a strict superset of the `all_persistence_ids` `(tag, pid)`
  // pair, so the latter would otherwise mis-collapse two distinct
  // events under the same tag into one row.
  if ('tag' in row && 'timestamp' in row && 'persistence_id' in row && 'sequence_nr' in row) {
    return ['tag', 'timestamp', 'persistence_id', 'sequence_nr'];
  }
  if ('type_name' in row && 'shard_id' in row && 'entity_id' in row) {
    // remember_entities (#84) — composite (type_name, shard_id, entity_id).
    return ['type_name', 'shard_id', 'entity_id'];
  }
  if ('partition_nr' in row && 'sequence_nr' in row && 'persistence_id' in row) {
    return ['persistence_id', 'partition_nr', 'sequence_nr'];
  }
  if ('sequence_nr' in row && 'persistence_id' in row) {
    return ['persistence_id', 'sequence_nr'];
  }
  if ('persistence_id' in row && 'tag' in row) {
    return ['tag', 'persistence_id'];
  }
  if ('persistence_id' in row) return ['persistence_id'];
  return Object.keys(row);
}
