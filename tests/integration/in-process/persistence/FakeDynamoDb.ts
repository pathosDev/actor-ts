/**
 * In-process fake of the DynamoDB operations façade — enough of the data model to
 * exercise `DynamoDbJournal` / `DynamoDbSnapshotStore` /
 * `DynamoDbDurableStateStore` in the fast `bun test` pass without a server.
 *
 * The two things it models faithfully are the two the backend's correctness rests
 * on, so a fake that skipped them would make the most important tests vacuous:
 *
 *   - **Conditional writes.** `attribute_not_exists(pid)`, `#rev = :expected` and
 *     `attribute_not_exists(deletedTo) OR deletedTo < :value` are evaluated for
 *     real, and a failure throws `ConditionalCheckFailedException`.
 *   - **Transaction atomicity.** `transactWriteItems` evaluates every condition
 *     first and applies nothing unless all of them pass, throwing
 *     `TransactionCanceledException` with the per-item `CancellationReasons` the
 *     SDK produces.  That is what makes "a losing writer writes nothing"
 *     testable rather than merely asserted.
 *
 * Expression support is deliberately narrow — only the forms the stores emit —
 * and anything else throws, so a new expression cannot slip in untested.
 */
import type {
  DynamoDbBatchWriteResult,
  DynamoDbGetResult,
  DynamoDbItem,
  DynamoDbOperations,
  DynamoDbQueryResult,
  DynamoDbTableDescription,
} from '../../../../src/persistence/journals/DynamoDbClient.js';

class ConditionalCheckFailed extends Error {
  readonly name = 'ConditionalCheckFailedException';
  constructor() { super('The conditional request failed'); }
}

class TransactionCancelled extends Error {
  readonly name = 'TransactionCanceledException';
  constructor(readonly CancellationReasons: ReadonlyArray<{ Code: string }>) {
    super('Transaction cancelled, please refer cancellation reasons for specific reasons');
  }
}

class TableNotFound extends Error {
  readonly name = 'ResourceNotFoundException';
  constructor(table: string) { super(`Requested resource not found: Table: ${table}`); }
}

class TableInUse extends Error {
  readonly name = 'ResourceInUseException';
  constructor(table: string) { super(`Table already exists: ${table}`); }
}

const clone = <T>(value: T): T => structuredClone(value);
/** DynamoDB numbers arrive as strings; sort and compare on the numeric value. */
const scalar = (attribute: unknown): string | number => {
  const value = attribute as Record<string, unknown> | undefined;
  if (value && 'N' in value) return Number(value.N);
  if (value && 'S' in value) return String(value.S);
  return '';
};

type FakeTable = {
  readonly partitionKey: string;
  readonly sortKey?: string;
  /** Items keyed by their serialized primary key, so key equality is exact. */
  readonly items: Map<string, DynamoDbItem>;
};

export type FakeDynamoDbOptions = {
  /**
   * Force `Query` / `Scan` to return at most this many items per call, with a
   * `LastEvaluatedKey` when more remain.
   *
   * DynamoDB pages at 1 MB, which a fake never reaches — so without this the
   * stores' pagination loops would never execute, and dropping one would
   * silently truncate a replay while every test stayed green.  Set it to 1 or 2
   * to make the loops run.
   */
  readonly pageSize?: number;
};

export class FakeDynamoDb implements DynamoDbOperations {
  private readonly tables = new Map<string, FakeTable>();
  private readonly pageSize: number | undefined;
  closed = false;
  /** Every operation, in order — lets tests assert on what the stores issued. */
  readonly log: string[] = [];

  constructor(options: FakeDynamoDbOptions = {}) {
    this.pageSize = options.pageSize;
  }

  /* ------------------------------ table admin ----------------------------- */

  async createTable(input: Record<string, unknown>): Promise<unknown> {
    const name = input.TableName as string;
    this.log.push(`createTable ${name} ${String(input.BillingMode ?? '')}`.trim());
    if (this.tables.has(name)) throw new TableInUse(name);
    const keySchema = input.KeySchema as Array<{ AttributeName: string; KeyType: string }>;
    const partitionKey = keySchema.find((key) => key.KeyType === 'HASH')!.AttributeName;
    const sortKey = keySchema.find((key) => key.KeyType === 'RANGE')?.AttributeName;
    this.tables.set(name, { partitionKey, ...(sortKey ? { sortKey } : {}), items: new Map() });
    return {};
  }

  async describeTable(input: Record<string, unknown>): Promise<DynamoDbTableDescription> {
    const name = input.TableName as string;
    if (!this.tables.has(name)) throw new TableNotFound(name);
    return { Table: { TableStatus: 'ACTIVE' } };
  }

  /* -------------------------------- writes -------------------------------- */

  async putItem(input: Record<string, unknown>): Promise<unknown> {
    const table = this.table(input.TableName as string);
    const item = input.Item as DynamoDbItem;
    this.log.push(`putItem ${input.TableName as string}`);
    const key = this.keyOf(table, item);
    if (!this.conditionHolds(table, key, input)) throw new ConditionalCheckFailed();
    table.items.set(key, clone(item));
    return {};
  }

  async updateItem(input: Record<string, unknown>): Promise<unknown> {
    const table = this.table(input.TableName as string);
    const key = this.keyOf(table, input.Key as DynamoDbItem);
    this.log.push(`updateItem ${input.TableName as string}`);
    if (!this.conditionHolds(table, key, input)) throw new ConditionalCheckFailed();
    const existing = table.items.get(key) ?? clone(input.Key as DynamoDbItem);
    table.items.set(key, applyUpdateExpression(existing, input));
    return {};
  }

  async deleteItem(input: Record<string, unknown>): Promise<unknown> {
    const table = this.table(input.TableName as string);
    this.log.push(`deleteItem ${input.TableName as string}`);
    table.items.delete(this.keyOf(table, input.Key as DynamoDbItem));
    return {};
  }

  async batchWriteItem(input: Record<string, unknown>): Promise<DynamoDbBatchWriteResult> {
    const requestItems = input.RequestItems as Record<string, Array<Record<string, { Key: DynamoDbItem }>>>;
    for (const [name, requests] of Object.entries(requestItems)) {
      const table = this.table(name);
      this.log.push(`batchWriteItem ${name} n=${requests.length}`);
      for (const request of requests) {
        const deleteRequest = request.DeleteRequest;
        if (!deleteRequest) throw new Error('FakeDynamoDb: only DeleteRequest is supported');
        table.items.delete(this.keyOf(table, deleteRequest.Key));
      }
    }
    return {};
  }

  /**
   * All conditions are checked before anything is applied, so a rejected
   * transaction leaves the table exactly as it was.
   */
  async transactWriteItems(input: Record<string, unknown>): Promise<unknown> {
    const transactItems = input.TransactItems as Array<Record<string, Record<string, unknown>>>;
    this.log.push(`transactWriteItems n=${transactItems.length}`);
    if (transactItems.length > 100) throw new Error('FakeDynamoDb: transaction exceeds 100 items');
    const reasons: Array<{ Code: string }> = [];
    let cancelled = false;
    const planned: Array<{ table: FakeTable; key: string; item: DynamoDbItem }> = [];
    for (const entry of transactItems) {
      const put = entry.Put;
      if (!put) throw new Error('FakeDynamoDb: only Put is supported inside a transaction');
      const table = this.table(put.TableName as string);
      const item = put.Item as DynamoDbItem;
      const key = this.keyOf(table, item);
      // A pending item in the same transaction counts as existing, which is how
      // DynamoDB rejects two writes to one key in one transaction.
      const alreadyPlanned = planned.some((entry_) => entry_.table === table && entry_.key === key);
      if (!this.conditionHolds(table, key, put) || alreadyPlanned) {
        reasons.push({ Code: 'ConditionalCheckFailed' });
        cancelled = true;
      } else {
        reasons.push({ Code: 'None' });
        planned.push({ table, key, item: clone(item) });
      }
    }
    if (cancelled) throw new TransactionCancelled(reasons);
    for (const { table, key, item } of planned) table.items.set(key, item);
    return {};
  }

  /* -------------------------------- reads --------------------------------- */

  async getItem(input: Record<string, unknown>): Promise<DynamoDbGetResult> {
    const table = this.table(input.TableName as string);
    const found = table.items.get(this.keyOf(table, input.Key as DynamoDbItem));
    return found ? { Item: clone(found) } : {};
  }

  async query(input: Record<string, unknown>): Promise<DynamoDbQueryResult> {
    const table = this.table(input.TableName as string);
    const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
    const condition = input.KeyConditionExpression as string;
    const matched = [...table.items.values()].filter((item) => matchesKeyCondition(table, item, condition, values));
    matched.sort((left, right) => {
      const sortKey = table.sortKey;
      if (!sortKey) return 0;
      const ordering = Number(scalar(left[sortKey])) - Number(scalar(right[sortKey]));
      return input.ScanIndexForward === false ? -ordering : ordering;
    });
    const limited = typeof input.Limit === 'number' ? matched.slice(0, input.Limit) : matched;
    return this.page(table, limited, input);
  }

  async scan(input: Record<string, unknown>): Promise<DynamoDbQueryResult> {
    const table = this.table(input.TableName as string);
    return this.page(table, [...table.items.values()], input);
  }

  /**
   * Slice a result set the way DynamoDB does when it hits its response limit:
   * hand back a prefix plus the key to resume from.  Only active when
   * `pageSize` is set, so ordinary tests see whole result sets.
   */
  private page(
    table: FakeTable,
    matched: ReadonlyArray<DynamoDbItem>,
    input: Record<string, unknown>,
  ): DynamoDbQueryResult {
    if (this.pageSize === undefined) return { Items: matched.map(clone) };
    const startKey = input.ExclusiveStartKey as DynamoDbItem | undefined;
    const startIndex = startKey === undefined
      ? 0
      : matched.findIndex((item) => this.keyOf(table, item) === this.keyOf(table, startKey)) + 1;
    const slice = matched.slice(startIndex, startIndex + this.pageSize);
    const consumed = startIndex + slice.length;
    return {
      Items: slice.map(clone),
      ...(consumed < matched.length && slice.length > 0
        ? { LastEvaluatedKey: this.primaryKeyOf(table, slice[slice.length - 1]!) }
        : {}),
    };
  }

  /** Just the key attributes, which is what `LastEvaluatedKey` carries. */
  private primaryKeyOf(table: FakeTable, item: DynamoDbItem): DynamoDbItem {
    const key: DynamoDbItem = { [table.partitionKey]: item[table.partitionKey]! };
    if (table.sortKey) key[table.sortKey] = item[table.sortKey]!;
    return key;
  }

  async close(): Promise<void> { this.closed = true; }

  /* ------------------------------ internals ------------------------------- */

  private table(name: string): FakeTable {
    const found = this.tables.get(name);
    if (!found) throw new TableNotFound(name);
    return found;
  }

  private keyOf(table: FakeTable, item: DynamoDbItem): string {
    const partition = scalar(item[table.partitionKey]);
    return table.sortKey === undefined ? `${partition}` : `${partition}\0${scalar(item[table.sortKey])}`;
  }

  /** Evaluate the narrow set of `ConditionExpression` forms the stores emit. */
  private conditionHolds(table: FakeTable, key: string, input: Record<string, unknown>): boolean {
    const expression = input.ConditionExpression as string | undefined;
    if (expression === undefined) return true;
    const existing = table.items.get(key);
    const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
    const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;

    // "only if this item does not exist" — the journal's and durable state's
    // insert guard.  The attribute named is always a key attribute.
    if (/^attribute_not_exists\(\w+\)$/.test(expression)) return existing === undefined;

    // "only if the stored revision is what I expect" — the durable-state CAS.
    const revisionMatch = /^(#?\w+) = (:\w+)$/.exec(expression);
    if (revisionMatch) {
      if (!existing) return false;
      const field = names[revisionMatch[1]!] ?? revisionMatch[1]!;
      return scalar(existing[field]) === scalar(values[revisionMatch[2]!]);
    }

    // "only if this raises the mark" — the monotonic high-water update.
    const monotonic = /^attribute_not_exists\((\w+)\) OR \1 < (:\w+)$/.exec(expression);
    if (monotonic) {
      const field = monotonic[1]!;
      const incoming = Number(scalar(values[monotonic[2]!]));
      if (!existing || existing[field] === undefined) return true;
      return Number(scalar(existing[field])) < incoming;
    }

    throw new Error(`FakeDynamoDb: unsupported ConditionExpression ${expression}`);
  }
}

/** Apply the one `UpdateExpression` shape the stores emit: `SET a = :x, b = :y`. */
function applyUpdateExpression(existing: DynamoDbItem, input: Record<string, unknown>): DynamoDbItem {
  const expression = input.UpdateExpression as string;
  const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
  const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
  const setClause = /^SET (.+)$/.exec(expression);
  if (!setClause) throw new Error(`FakeDynamoDb: unsupported UpdateExpression ${expression}`);
  const next = clone(existing) as Record<string, unknown>;
  for (const assignment of setClause[1]!.split(',')) {
    const parts = /^\s*(#?\w+) = (:\w+)\s*$/.exec(assignment);
    if (!parts) throw new Error(`FakeDynamoDb: unsupported assignment ${assignment}`);
    const field = names[parts[1]!] ?? parts[1]!;
    next[field] = values[parts[2]!];
  }
  return next as DynamoDbItem;
}

/**
 * Evaluate the `KeyConditionExpression` forms the stores emit.
 *
 * Tokenized rather than split on `AND`, because `BETWEEN :from AND :to` contains
 * one — splitting would silently mangle every ranged read.  `<=` and `>=` are
 * listed before `<` and `>` so the two-character operators win.
 */
const KEY_CLAUSE_PATTERN =
  /(\w+)\s+BETWEEN\s+(:\w+)\s+AND\s+(:\w+)|(\w+)\s*(<=|>=|=|<|>)\s*(:\w+)/g;

function matchesKeyCondition(
  table: FakeTable,
  item: DynamoDbItem,
  condition: string,
  values: Record<string, unknown>,
): boolean {
  let constrainsPartition = false;
  let clauseCount = 0;
  let satisfied = true;
  for (const clause of condition.matchAll(KEY_CLAUSE_PATTERN)) {
    clauseCount++;
    const [, betweenField, lowerBound, upperBound, field, operator, placeholder] = clause;
    if (betweenField !== undefined) {
      const actual = Number(scalar(item[betweenField]));
      if (actual < Number(scalar(values[lowerBound!])) || actual > Number(scalar(values[upperBound!]))) {
        satisfied = false;
      }
      continue;
    }
    if (field === table.partitionKey && operator === '=') constrainsPartition = true;
    const actual = scalar(item[field!]);
    const expected = scalar(values[placeholder!]);
    switch (operator) {
      case '=': if (actual !== expected) satisfied = false; break;
      case '<': if (!(Number(actual) < Number(expected))) satisfied = false; break;
      case '<=': if (!(Number(actual) <= Number(expected))) satisfied = false; break;
      case '>': if (!(Number(actual) > Number(expected))) satisfied = false; break;
      case '>=': if (!(Number(actual) >= Number(expected))) satisfied = false; break;
      default: throw new Error(`FakeDynamoDb: unsupported operator ${operator}`);
    }
  }
  if (clauseCount === 0) throw new Error(`FakeDynamoDb: unsupported key condition ${condition}`);
  // A query without a partition-key equality would be a table scan in disguise —
  // DynamoDB rejects it, so the fake must too.
  if (!constrainsPartition) {
    throw new Error(`FakeDynamoDb: query must constrain the partition key ${table.partitionKey}`);
  }
  return satisfied;
}
