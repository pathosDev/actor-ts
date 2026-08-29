import { LazyStore, type LazyStoreConfig } from '../LazyStore.js';
import type { StorageLocality } from '../StorageLocality.js';
import {
  isConditionalCheckFailed,
  isTableAlreadyExists,
  isTableNotFound,
  readString,
  stringAttribute,
  type DynamoDbOperations,
} from './DynamoDbClient.js';

/** A table's key schema, in the shape `CreateTable` wants. */
export type DynamoDbTableSchema = {
  readonly tableName: string;
  /** Partition key — always the persistence id in these stores. */
  readonly partitionKey: string;
  /** Sort key, for the tables that hold many items per persistence id. */
  readonly sortKey?: { readonly name: string; readonly type: 'N' | 'S' };
};

/** Wiring every DynamoDB store needs, independent of which contract it implements. */
export interface DynamoDbStoreConfig extends Omit<LazyStoreConfig<DynamoDbOperations>, 'ownsResource' | 'openResource'> {
  /** Create the table on first use.  Default `true`. */
  readonly autoCreateTables?: boolean;
  /**
   * On-demand (`PAY_PER_REQUEST`) or provisioned throughput.  Default on-demand:
   * an event journal's traffic is bursty, and on-demand needs no capacity
   * planning to get started.
   */
  readonly billingMode?: 'PAY_PER_REQUEST' | 'PROVISIONED';
  /** Read/write capacity units, used only when `billingMode` is `PROVISIONED`. */
  readonly provisionedThroughput?: { readonly readCapacityUnits: number; readonly writeCapacityUnits: number };
  /** How long to wait for a freshly created table to become ACTIVE.  Default 30 s. */
  readonly tableReadyTimeoutMs?: number;
  /**
   * Whether this store opened the client itself.  An injected façade — shared
   * across the journal, snapshot and durable-state stores by
   * `registerDynamoDbPlugins`, or a fake in tests — is owned by the caller.
   */
  readonly ownsClient: boolean;
  /** Open the operations façade.  Called once, lazily, on first use. */
  openClient(): Promise<DynamoDbOperations>;
}

/**
 * The DynamoDB half of the store lifecycle: `LazyStore` handles lazy connection,
 * one-shot preparation and ownership-aware teardown, and this layer creates the
 * table and waits for it to be usable.
 *
 * The wait is the part that does not exist in the SQL backends.  `CreateTable`
 * returns while the table is still `CREATING`, and every operation against it
 * fails until it flips to `ACTIVE` — seconds on real AWS, effectively instant on
 * `dynamodb-local`.  Since `prepare` runs inside the memoized init, blocking here
 * is exactly right: the first caller waits, and everyone behind it gets a table
 * that works.
 */
export abstract class DynamoDbStore extends LazyStore<DynamoDbOperations> {
  /** A DynamoDB endpoint any node can reach — `'shared'` for the whole family (#1356). */
  readonly storageLocality: StorageLocality = 'shared';
  private mintedStorageIdentity: string | null = null;
  private readonly autoCreateTables: boolean;

  /**
   * Claim-or-read the identity item under the sentinel partition key
   * (`DYNAMODB_STORAGE_IDENTITY_KEY`, which no user persistence id can
   * collide with — the validator refuses `/`).  Per TABLE on purpose: the
   * table is DynamoDB's unit of divergence, so two nodes on different table
   * names mismatch too (#1358).  Subclasses supply their own key shape,
   * because the durable-state table has no sort key.
   */
  protected async storageIdentityFromTable(
    tableName: string,
    key: Record<string, unknown>,
  ): Promise<string> {
    if (this.mintedStorageIdentity !== null) return this.mintedStorageIdentity;
    const operations = await this.ensureOpen();
    try {
      await operations.putItem({
        TableName: tableName,
        Item: { ...key, identity: stringAttribute(crypto.randomUUID()) },
        ConditionExpression: 'attribute_not_exists(pid)',
      });
    } catch (e) {
      // Losing the conditional put — to a sibling store, or to an earlier
      // run of this node — is the expected path; the stored item wins.
      if (!isConditionalCheckFailed(e)) this.fail('storageIdentity', e);
    }
    const result = await operations.getItem({
      TableName: tableName,
      Key: key,
      // Strong read for the same reason every sequence-number read is: an
      // eventually-consistent read of a just-claimed item can come back empty.
      ConsistentRead: true,
    });
    const identity = result.Item === undefined ? '' : readString(result.Item, 'identity');
    if (identity.length === 0) {
      this.fail('storageIdentity', new Error('identity item missing after conditional put'));
    }
    this.mintedStorageIdentity = identity;
    return identity;
  }
  private readonly billingMode: 'PAY_PER_REQUEST' | 'PROVISIONED';
  private readonly provisionedThroughput?: { readonly readCapacityUnits: number; readonly writeCapacityUnits: number };
  private readonly tableReadyTimeoutMs: number;

  protected constructor(config: DynamoDbStoreConfig) {
    super({
      storeName: config.storeName,
      ownsResource: config.ownsClient,
      openResource: () => config.openClient(),
    });
    this.autoCreateTables = config.autoCreateTables ?? true;
    this.billingMode = config.billingMode ?? 'PAY_PER_REQUEST';
    this.provisionedThroughput = config.provisionedThroughput;
    this.tableReadyTimeoutMs = config.tableReadyTimeoutMs ?? 30_000;
  }

  /** The tables this store needs.  One for every store the framework ships. */
  protected abstract tables(): DynamoDbTableSchema[];

  protected async prepare(operations: DynamoDbOperations): Promise<void> {
    if (!this.autoCreateTables) return;
    for (const table of this.tables()) {
      await this.createTable(operations, table);
      await this.waitForActive(operations, table.tableName);
    }
  }

  protected async release(operations: DynamoDbOperations): Promise<void> {
    await operations.close();
  }

  private async createTable(operations: DynamoDbOperations, table: DynamoDbTableSchema): Promise<void> {
    const keySchema: Array<Record<string, string>> = [{ AttributeName: table.partitionKey, KeyType: 'HASH' }];
    const attributes: Array<Record<string, string>> = [{ AttributeName: table.partitionKey, AttributeType: 'S' }];
    if (table.sortKey) {
      keySchema.push({ AttributeName: table.sortKey.name, KeyType: 'RANGE' });
      attributes.push({ AttributeName: table.sortKey.name, AttributeType: table.sortKey.type });
    }
    try {
      await operations.createTable({
        TableName: table.tableName,
        KeySchema: keySchema,
        // Only key attributes are declared: DynamoDB is schemaless for the rest.
        AttributeDefinitions: attributes,
        BillingMode: this.billingMode,
        ...(this.billingMode === 'PROVISIONED'
          ? {
              ProvisionedThroughput: {
                ReadCapacityUnits: this.provisionedThroughput?.readCapacityUnits ?? 5,
                WriteCapacityUnits: this.provisionedThroughput?.writeCapacityUnits ?? 5,
              },
            }
          : {}),
      });
    } catch (e) {
      // Two stores sharing a client will both try to create their tables, and a
      // redeploy re-runs this — an existing table is the expected case, not a
      // failure.
      if (!isTableAlreadyExists(e)) throw e;
    }
  }

  /** Poll `DescribeTable` until the table is ACTIVE, or give up loudly. */
  private async waitForActive(operations: DynamoDbOperations, tableName: string): Promise<void> {
    const deadline = Date.now() + this.tableReadyTimeoutMs;
    let lastStatus = 'unknown';
    while (Date.now() < deadline) {
      try {
        const described = await operations.describeTable({ TableName: tableName });
        lastStatus = described.Table?.TableStatus ?? 'unknown';
        if (lastStatus === 'ACTIVE') return;
      } catch (e) {
        // A table created moments ago may not be visible yet; anything else is real.
        if (!isTableNotFound(e)) throw e;
        lastStatus = 'not found';
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    this.fail(
      'init',
      new Error(
        `table ${tableName} did not become ACTIVE within ${this.tableReadyTimeoutMs}ms `
        + `(last status: ${lastStatus})`,
      ),
    );
  }
}
