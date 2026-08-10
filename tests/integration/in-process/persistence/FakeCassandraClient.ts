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
 *   - INSERT INTO keyspace.table (c1, c2, ...) VALUES (?, ?, ...) [IF NOT EXISTS]
 *   - UPDATE keyspace.table SET c1 = ?, ... WHERE <eq-clauses> [IF <eq-clauses>]
 *   - SELECT col1, col2, ... FROM keyspace.table WHERE <eq-clauses>
 *       [AND seq >= ?] [AND seq <= ?] [AND seq < ?] [LIMIT N]
 *   - DELETE FROM keyspace.table WHERE <eq-clauses> [AND seq <= ?] [AND seq < ?]
 *
 * Every row is stored as a string-keyed record.  Numeric params coerce to
 * Number; other types pass through.
 *
 * **Lightweight transactions** are modelled faithfully enough to test the
 * journal's append serialization (#475): a conditional statement returns the
 * `[applied]` marker row, and on rejection the row as it actually stands.
 * Because every `execute` is `async`, concurrent callers interleave at each
 * `await` — which is what lets the tests race appends deterministically.
 */

type Row = Record<string, unknown>;

type TableState = {
  readonly table: string;
  readonly rows: Row[];
};

/** Comparison operators the WHERE-clause parser understands. */
type ComparisonOperator = '=' | '>=' | '>' | '<=' | '<';

type SelectPlan = {
  readonly table: string;
  readonly columns: string[] | '*';
  readonly filters: ReadonlyArray<{ column: string; op: ComparisonOperator; index: number }>;
  /** `LIMIT N` → literal value; `LIMIT ?` → parameter index; absent → null. */
  readonly limit: { kind: 'literal'; value: number } | { kind: 'param'; index: number } | null;
};

type InsertPlan = {
  readonly table: string;
  readonly columns: string[];
  /** `INSERT ... IF NOT EXISTS` — apply only when no row shares the PK. */
  readonly ifNotExists: boolean;
};

type UpdatePlan = {
  readonly table: string;
  readonly assignments: ReadonlyArray<{ column: string; index: number }>;
  readonly filters: ReadonlyArray<{ column: string; index: number }>;
  /** `IF col = ?` conditions — absent for an unconditional UPDATE. */
  readonly conditions: ReadonlyArray<{ column: string; index: number }>;
};

type DeletePlan = {
  readonly table: string;
  readonly filters: ReadonlyArray<{ column: string; op: '=' | '<=' | '<'; index: number }>;
};

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
    const statement = query.trim().replace(/\s+/g, ' ');
    const upper = statement.toUpperCase();
    if (upper.startsWith('CREATE KEYSPACE') || upper.startsWith('CREATE TABLE')) {
      // DDL — no-op in the fake.
      return { rows: [] };
    }
    if (upper.startsWith('INSERT')) {
      return { rows: this.handleInsert(statement, params) };
    }
    if (upper.startsWith('UPDATE')) {
      return { rows: this.handleUpdate(statement, params) };
    }
    if (upper.startsWith('SELECT')) {
      return { rows: this.handleSelect(statement, params) };
    }
    if (upper.startsWith('DELETE')) {
      this.handleDelete(statement, params);
      return { rows: [] };
    }
    throw new Error(`FakeCassandraClient: unsupported statement: ${statement}`);
  }

  async batch(
    queries: ReadonlyArray<CassandraBatchQuery>,
    _options?: { prepare?: boolean; logged?: boolean; consistency?: number },
  ): Promise<void> {
    for (const statement of queries) await this.execute(statement.query, statement.params ?? []);
  }

  /** Expose row count — convenient for tests. */
  countRows(keyspaceDotTable: string): number {
    return this.tables.get(keyspaceDotTable)?.rows.length ?? 0;
  }

  get isConnected(): boolean { return this.connected && !this.shuttingDown; }

  /* ============================== internals ============================== */

  private stateOf(table: string): TableState {
    let state = this.tables.get(table);
    if (!state) { state = { table, rows: [] }; this.tables.set(table, state); }
    return state;
  }

  private handleInsert(statement: string, params: ReadonlyArray<unknown>): Row[] {
    const plan = parseInsert(statement);
    if (!plan) throw new Error(`FakeCassandraClient: cannot parse INSERT: ${statement}`);
    const row: Row = {};
    plan.columns.forEach((col, i) => { row[col] = params[i]; });
    const state = this.stateOf(plan.table);
    // Simple upsert semantics — replace if a row with the same PK exists.
    const existing = state.rows.findIndex((r) => samePrimaryKey(r, row));
    if (plan.ifNotExists) {
      // LWT: reject when the PK is taken, handing back the row that won —
      // exactly what the real driver returns alongside `[applied]: false`.
      if (existing >= 0) return [{ '[applied]': false, ...state.rows[existing] }];
      state.rows.push(row);
      return [{ '[applied]': true }];
    }
    if (existing >= 0) state.rows[existing] = row;
    else state.rows.push(row);
    return [];
  }

  private handleUpdate(statement: string, params: ReadonlyArray<unknown>): Row[] {
    const plan = parseUpdate(statement);
    if (!plan) throw new Error(`FakeCassandraClient: cannot parse UPDATE: ${statement}`);
    const state = this.stateOf(plan.table);
    const index = state.rows.findIndex(
      (row) => plan.filters.every((f) => coerce(row[f.column]) === coerce(params[f.index])),
    );
    const conditional = plan.conditions.length > 0;
    const current = index >= 0 ? state.rows[index]! : undefined;
    if (conditional) {
      // An UPDATE ... IF on a missing row never applies; Cassandra returns
      // `[applied]: false` with no further columns.
      if (current === undefined) return [{ '[applied]': false }];
      const satisfied = plan.conditions.every(
        (c) => coerce(current[c.column]) === coerce(params[c.index]),
      );
      if (!satisfied) return [{ '[applied]': false, ...current }];
    }
    // An unconditional UPDATE on a missing row is an upsert in CQL: the PK
    // columns come from the WHERE clause.
    const target: Row = current ?? {};
    for (const f of plan.filters) target[f.column] = params[f.index];
    for (const a of plan.assignments) target[a.column] = params[a.index];
    if (current === undefined) state.rows.push(target);
    return conditional ? [{ '[applied]': true }] : [];
  }

  private handleSelect(statement: string, params: ReadonlyArray<unknown>): Row[] {
    const plan = parseSelect(statement);
    if (!plan) throw new Error(`FakeCassandraClient: cannot parse SELECT: ${statement}`);
    const state = this.tables.get(plan.table);
    if (!state) return [];
    let rows = state.rows.filter((row) => plan.filters.every((f) => matches(row, f, params)));
    // Cassandra orders rows by clustering columns.  Two shapes matter here:
    // most tables cluster on `sequence_nr`, but `all_persistence_ids` has
    // `PRIMARY KEY (tag, persistence_id)` and therefore clusters on the id —
    // which is exactly what `persistenceIdsPaginated` walks, so returning
    // insertion order there would let a broken cursor look correct.
    const clusterByPersistenceId = rows.length > 0 && rows.every((row) => row.sequence_nr === undefined);
    rows = rows.slice().sort((a, b) => {
      if (clusterByPersistenceId) {
        return String(a.persistence_id) < String(b.persistence_id) ? -1
          : String(a.persistence_id) > String(b.persistence_id) ? 1 : 0;
      }
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

  private handleDelete(statement: string, params: ReadonlyArray<unknown>): void {
    const plan = parseDelete(statement);
    if (!plan) throw new Error(`FakeCassandraClient: cannot parse DELETE: ${statement}`);
    const state = this.tables.get(plan.table);
    if (!state) return;
    state.rows = state.rows.filter((row) => !plan.filters.every((f) => matches(row, f, params)));
    this.tables.set(plan.table, state);
  }
}

/* ============================ CQL mini-parser ============================ */

function parseInsert(statement: string): InsertPlan | null {
  const regexMatch = /^INSERT INTO ([\w.]+) \(([^)]+)\) VALUES \(([^)]+)\)(\s+IF NOT EXISTS)?$/i.exec(statement);
  if (!regexMatch) return null;
  const table = regexMatch[1]!;
  const columns = regexMatch[2]!.split(',').map((c) => c.trim());
  return { table, columns, ifNotExists: regexMatch[4] !== undefined };
}

function parseUpdate(statement: string): UpdatePlan | null {
  const regexMatch = /^UPDATE ([\w.]+) SET (.+?) WHERE (.+?)(?: IF (.+))?$/i.exec(statement);
  if (!regexMatch) return null;
  const table = regexMatch[1]!;
  // Param order in CQL is positional: SET assignments, then WHERE, then IF.
  let paramIndex = 0;
  const bind = (clause: string, separator: RegExp): Array<{ column: string; index: number }> | null => {
    const out: Array<{ column: string; index: number }> = [];
    for (const part of clause.split(separator)) {
      const match = /^(\w+)\s*=\s*\?$/.exec(part.trim());
      if (!match) return null;
      out.push({ column: match[1]!, index: paramIndex++ });
    }
    return out;
  };
  const assignments = bind(regexMatch[2]!, /,/);
  if (!assignments) return null;
  const filters = bind(regexMatch[3]!, /\s+AND\s+/i);
  if (!filters) return null;
  const conditions = regexMatch[4] === undefined ? [] : bind(regexMatch[4], /\s+AND\s+/i);
  if (!conditions) return null;
  return { table, assignments, filters, conditions };
}

function parseSelect(statement: string): SelectPlan | null {
  const regexMatch = /^SELECT (.+?) FROM ([\w.]+)(?: WHERE (.+?))?(?: LIMIT (\?|\d+))?$/i.exec(statement);
  if (!regexMatch) return null;
  const colsRaw = regexMatch[1]!.trim();
  const table = regexMatch[2]!;
  const whereClause = regexMatch[3]?.trim();
  const limitToken = regexMatch[4];
  const columns: string[] | '*' = colsRaw === '*' ? '*' : colsRaw.split(',').map((c) => c.trim());

  const filters: Array<{ column: string; op: ComparisonOperator; index: number }> = [];
  let paramIndex = 0;
  if (whereClause) {
    const parts = whereClause.split(/\s+AND\s+/i);
    for (const part of parts) {
      // `>=` and `<=` must be tried before the bare `>` / `<` alternatives, or
      // the regex matches the first character and leaves `= ?` unconsumed.
      const match = /^(\w+)\s*(>=|<=|=|>|<)\s*\?$/.exec(part.trim());
      if (!match) return null;
      filters.push({ column: match[1]!, op: match[2] as ComparisonOperator, index: paramIndex++ });
    }
  }
  let limit: SelectPlan['limit'] = null;
  if (limitToken === '?') limit = { kind: 'param', index: paramIndex };
  else if (limitToken !== undefined) limit = { kind: 'literal', value: Number(limitToken) };
  return { table, columns, filters, limit };
}

function parseDelete(statement: string): DeletePlan | null {
  const regexMatch = /^DELETE FROM ([\w.]+) WHERE (.+)$/i.exec(statement);
  if (!regexMatch) return null;
  const table = regexMatch[1]!;
  const whereClause = regexMatch[2]!.trim();
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
  filter: { column: string; op: ComparisonOperator; index: number },
  params: ReadonlyArray<unknown>,
): boolean {
  const rowVal = row[filter.column];
  const paramVal = params[filter.index];
  if (rowVal === undefined) return false;
  switch (filter.op) {
    case '=':  return coerce(rowVal) === coerce(paramVal);
    case '>=': return coerce(rowVal) >= coerce(paramVal);
    case '>':  return coerce(rowVal) >  coerce(paramVal);
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
