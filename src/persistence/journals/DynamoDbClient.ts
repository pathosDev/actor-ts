import { Lazy } from '../../util/Lazy.js';

/**
 * Minimal DynamoDB surface the backends use, expressed as **operations** rather
 * than as the SDK's command objects.
 *
 * The AWS SDK v3 is command-based — `client.send(new PutItemCommand(input))` —
 * which would force every test fake to supply command constructors too.  One
 * adapter here turns that into a flat operation interface, the same way
 * `adaptPgPool` turns a driver pool into `SqlPool`: the stores speak operations,
 * the adapter speaks AWS, and a fake implements ten methods and nothing else.
 *
 * `@aws-sdk/client-dynamodb` is the same SDK family already shipped for S3, so
 * the lazy-import and cross-runtime story is proven — verified to import and
 * construct a client on Bun, Node and Deno.
 */

/** A DynamoDB attribute value.  Numbers travel as strings on the wire. */
export type DynamoDbAttribute =
  | { S: string }
  | { N: string }
  | { BOOL: boolean }
  | { NULL: true }
  | { SS: string[] }
  | { L: DynamoDbAttribute[] }
  | { M: Record<string, DynamoDbAttribute> };

/** One item: attribute name → attribute value. */
export type DynamoDbItem = Record<string, DynamoDbAttribute>;

export type DynamoDbQueryResult = {
  readonly Items?: DynamoDbItem[];
  /** Present when the 1 MB page limit was hit — the caller must keep paging. */
  readonly LastEvaluatedKey?: DynamoDbItem;
};

export type DynamoDbGetResult = {
  readonly Item?: DynamoDbItem;
};

export type DynamoDbBatchWriteResult = {
  /** Throttled writes the caller must resubmit. */
  readonly UnprocessedItems?: Record<string, unknown[]>;
};

export type DynamoDbTableDescription = {
  readonly Table?: { readonly TableStatus?: string };
};

/**
 * The operations the persistence stores need.  Deliberately not the whole API:
 * an operation absent here is one no store issues.
 */
export interface DynamoDbOperations {
  putItem(input: Record<string, unknown>): Promise<unknown>;
  getItem(input: Record<string, unknown>): Promise<DynamoDbGetResult>;
  query(input: Record<string, unknown>): Promise<DynamoDbQueryResult>;
  scan(input: Record<string, unknown>): Promise<DynamoDbQueryResult>;
  updateItem(input: Record<string, unknown>): Promise<unknown>;
  deleteItem(input: Record<string, unknown>): Promise<unknown>;
  batchWriteItem(input: Record<string, unknown>): Promise<DynamoDbBatchWriteResult>;
  /** Atomic across up to 100 items — the journal's multi-event append. */
  transactWriteItems(input: Record<string, unknown>): Promise<unknown>;
  createTable(input: Record<string, unknown>): Promise<unknown>;
  describeTable(input: Record<string, unknown>): Promise<DynamoDbTableDescription>;
  close(): Promise<void>;
}

/** The low-level client the adapter wraps. */
export interface DynamoDbClientLike {
  send(command: unknown): Promise<Record<string, unknown>>;
  destroy?(): void;
}

type DynamoDbSdkModule = {
  DynamoDBClient: new (config: Record<string, unknown>) => DynamoDbClientLike;
  PutItemCommand: new (input: Record<string, unknown>) => unknown;
  GetItemCommand: new (input: Record<string, unknown>) => unknown;
  QueryCommand: new (input: Record<string, unknown>) => unknown;
  ScanCommand: new (input: Record<string, unknown>) => unknown;
  UpdateItemCommand: new (input: Record<string, unknown>) => unknown;
  DeleteItemCommand: new (input: Record<string, unknown>) => unknown;
  BatchWriteItemCommand: new (input: Record<string, unknown>) => unknown;
  TransactWriteItemsCommand: new (input: Record<string, unknown>) => unknown;
  CreateTableCommand: new (input: Record<string, unknown>) => unknown;
  DescribeTableCommand: new (input: Record<string, unknown>) => unknown;
};

const dynamoDbSdkLazy: Lazy<Promise<DynamoDbSdkModule>> = Lazy.of(async () => {
  try {
    const name = '@aws-sdk/client-dynamodb';
    return (await import(name)) as unknown as DynamoDbSdkModule;
  } catch (e) {
    throw new Error(
      'The DynamoDB persistence backends require the "@aws-sdk/client-dynamodb" package.  '
      + 'Install it with: npm install @aws-sdk/client-dynamodb\nOriginal error: '
      + (e instanceof Error ? e.message : String(e)),
    );
  }
});

/** Connection options shared by all three DynamoDB stores. */
export type DynamoDbConnection = {
  /** AWS region, e.g. `eu-central-1`.  Falls back to the SDK's own resolution. */
  readonly region?: string;
  /**
   * Override the service endpoint — how you point at `dynamodb-local` or
   * LocalStack (`http://localhost:8000`).
   */
  readonly endpoint?: string;
  /**
   * Extra `DynamoDBClient` config, merged over `region` / `endpoint`:
   * `{ credentials, maxAttempts, requestHandler, … }`.
   */
  readonly clientConfig?: Record<string, unknown>;
  /**
   * Pre-built operations façade — bypasses the lazy SDK import entirely.  Use to
   * share ONE client across the journal, snapshot and durable-state stores (see
   * `registerDynamoDbPlugins`), or to inject a fake in tests.
   */
  readonly operations?: DynamoDbOperations;
};

/** Build (or pass through) the operations façade for a store. */
export async function buildDynamoDbOperations(
  connection: DynamoDbConnection,
): Promise<DynamoDbOperations> {
  if (connection.operations) return connection.operations;
  const sdk = await dynamoDbSdkLazy.get();
  const client = new sdk.DynamoDBClient({
    ...(connection.region === undefined ? {} : { region: connection.region }),
    ...(connection.endpoint === undefined ? {} : { endpoint: connection.endpoint }),
    ...connection.clientConfig,
  });
  return adaptDynamoDbClient(client, sdk);
}

/** Wrap an SDK client so the stores see flat operations instead of commands. */
function adaptDynamoDbClient(client: DynamoDbClientLike, sdk: DynamoDbSdkModule): DynamoDbOperations {
  const send = async <TResult>(command: unknown): Promise<TResult> =>
    (await client.send(command)) as TResult;
  return {
    putItem: (input) => send(new sdk.PutItemCommand(input)),
    getItem: (input) => send<DynamoDbGetResult>(new sdk.GetItemCommand(input)),
    query: (input) => send<DynamoDbQueryResult>(new sdk.QueryCommand(input)),
    scan: (input) => send<DynamoDbQueryResult>(new sdk.ScanCommand(input)),
    updateItem: (input) => send(new sdk.UpdateItemCommand(input)),
    deleteItem: (input) => send(new sdk.DeleteItemCommand(input)),
    batchWriteItem: (input) => send<DynamoDbBatchWriteResult>(new sdk.BatchWriteItemCommand(input)),
    transactWriteItems: (input) => send(new sdk.TransactWriteItemsCommand(input)),
    createTable: (input) => send(new sdk.CreateTableCommand(input)),
    describeTable: (input) => send<DynamoDbTableDescription>(new sdk.DescribeTableCommand(input)),
    async close() { client.destroy?.(); },
  };
}

/* ------------------------- error classification -------------------------- */

/**
 * A failed conditional write.  DynamoDB reports it two ways, and both matter:
 *
 *   - a single conditional `PutItem` / `UpdateItem` throws
 *     `ConditionalCheckFailedException`;
 *   - a `TransactWriteItems` throws `TransactionCanceledException`, and the
 *     reason has to be dug out of `CancellationReasons` — a transaction is also
 *     cancelled for throttling or conflicts, which are retryable and must NOT be
 *     mistaken for a concurrency conflict.
 *
 * This is DynamoDB's equivalent of SQLSTATE `23505` / MongoDB's error 11000, and
 * it is what makes the journal's optimistic concurrency sound.
 */
export function isConditionalCheckFailed(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    name?: string;
    CancellationReasons?: ReadonlyArray<{ Code?: string }>;
  };
  if (candidate.name === 'ConditionalCheckFailedException') return true;
  if (candidate.name === 'TransactionCanceledException') {
    return (candidate.CancellationReasons ?? []).some((reason) => reason.Code === 'ConditionalCheckFailed');
  }
  return false;
}

/** The table does not exist — distinguishes "not created yet" from a real fault. */
export function isTableNotFound(error: unknown): boolean {
  return (error as { name?: string })?.name === 'ResourceNotFoundException';
}

/** The table already exists — a benign race between two stores creating it. */
export function isTableAlreadyExists(error: unknown): boolean {
  return (error as { name?: string })?.name === 'ResourceInUseException';
}

/* --------------------------- attribute helpers --------------------------- */

/** DynamoDB carries numbers as strings; these keep the conversion in one place. */
export const stringAttribute = (value: string): DynamoDbAttribute => ({ S: value });
export const numberAttribute = (value: number): DynamoDbAttribute => ({ N: String(value) });
export const stringSetAttribute = (values: ReadonlyArray<string>): DynamoDbAttribute => ({ SS: [...values] });

export function readString(item: DynamoDbItem, name: string): string {
  const attribute = item[name];
  return attribute !== undefined && 'S' in attribute ? attribute.S : '';
}

export function readNumber(item: DynamoDbItem, name: string): number {
  const attribute = item[name];
  return attribute !== undefined && 'N' in attribute ? Number(attribute.N) : 0;
}

/**
 * Read a string set.  A DynamoDB set cannot be empty — writing one is an error —
 * so an absent attribute is how "no tags" is represented, and `undefined` is the
 * right answer rather than `[]`.
 */
export function readStringSet(item: DynamoDbItem, name: string): string[] | undefined {
  const attribute = item[name];
  if (attribute === undefined || !('SS' in attribute) || attribute.SS.length === 0) return undefined;
  return [...attribute.SS];
}

/** Test hook — reset the cached lazy SDK import. */
export function resetDynamoDbSdkCache(): void {
  dynamoDbSdkLazy.reset();
}
