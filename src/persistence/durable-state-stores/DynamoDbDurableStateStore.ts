import { DYNAMODB_STORAGE_IDENTITY_KEY } from '../Constants.js';
import {
  DurableStateConcurrencyError,
  type DurableStateRecord,
  type DurableStateStore,
} from '../DurableStateStore.js';
import { JournalError } from '../JournalTypes.js';
import type { PersistenceOptionSupport } from '../PersistenceCapabilities.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import { none, some, type Option } from '../../util/Option.js';
import {
  buildDynamoDbOperations,
  isConditionalCheckFailed,
  numberAttribute,
  readNumber,
  readString,
  stringAttribute,
  type DynamoDbOperations,
} from '../journals/DynamoDbClient.js';
import { DynamoDbStore, type DynamoDbTableSchema } from '../journals/DynamoDbStore.js';
import type { Serializer } from '../../serialization/Serializer.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import {
  DEFAULT_DYNAMODB_DURABLE_STATE_TABLE,
  DynamoDbDurableStateStoreOptionsValidator,
  type DynamoDbDurableStateStoreOptions,
  type DynamoDbDurableStateStoreOptionsType,
} from './DynamoDbDurableStateStoreOptions.js';

/**
 * DurableStateStore backed by Amazon DynamoDB — the "event-free" cousin of event
 * sourcing, one item per persistence id rewritten in place.
 *
 * This is the contract DynamoDB fits best of the three: compare-and-swap is a
 * native conditional write, needing neither a transaction nor a read-back.
 *
 *   - `expectedRevision === 0` → `PutItem` with
 *     `ConditionExpression: attribute_not_exists(pid)`.
 *   - `expectedRevision > 0` → `UpdateItem` with
 *     `ConditionExpression: revision = :expected`.
 *
 * Both surface a collision as `ConditionalCheckFailedException`, and the current
 * revision is then read back so the error reports what the caller actually raced
 * against.  `revision` goes through an expression attribute name because it is
 * short enough to collide with a DynamoDB reserved word in future API versions —
 * cheap insurance in a place that would otherwise fail at runtime only.
 */
export class DynamoDbDurableStateStore extends DynamoDbStore implements DurableStateStore {
  /**
   * The payload is a plain item attribute — `options` is bound and never
   * read (#960).  DynamoDB's own server-side encryption is a table setting
   * the store neither configures nor observes, so it cannot be claimed here.
   */
  readonly persistenceOptionSupport: PersistenceOptionSupport = {
    encryption: false,
    compression: false,
    integrity: false,
  };

  private readonly tableName: string;

  private readonly serializer?: Serializer;

  constructor(options: DynamoDbDurableStateStoreOptions = {}) {
    const resolvedOptions = (options as DynamoDbDurableStateStoreOptionsType);
    new DynamoDbDurableStateStoreOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'DynamoDbDurableStateStore',
      autoCreateTables: resolvedOptions.autoCreateTables,
      billingMode: resolvedOptions.billingMode,
      provisionedThroughput: resolvedOptions.provisionedThroughput,
      tableReadyTimeoutMs: resolvedOptions.tableReadyTimeoutMs,
      ownsClient: resolvedOptions.operations === undefined,
      openClient: () => buildDynamoDbOperations(resolvedOptions),
    });
    this.tableName = resolvedOptions.table ?? DEFAULT_DYNAMODB_DURABLE_STATE_TABLE;
    this.serializer = resolvedOptions.serializer;
  }

  /** One item per persistence id, so the partition key alone is the whole schema. */
  protected tables(): DynamoDbTableSchema[] {
    return [{ tableName: this.tableName, partitionKey: 'pid' }];
  }

  async storageIdentity(): Promise<string> {
    // No sort key on this table — the sentinel partition key alone is the item.
    return this.storageIdentityFromTable(this.tableName, {
      pid: stringAttribute(DYNAMODB_STORAGE_IDENTITY_KEY),
    });
  }

  async upsert<S>(
    persistenceId: string,
    expectedRevision: number,
    state: S,
    _options?: PersistenceOptions,
  ): Promise<DurableStateRecord<S>> {
    // A bogus revision is a caller bug, not a lost race — reporting it as a
    // concurrency conflict would invite an endless retry loop.
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new JournalError(
        `${this.storeName}.upsert: expectedRevision must be a non-negative integer, got ${expectedRevision}`,
      );
    }
    const operations = await this.ensureOpen();
    const now = Date.now();
    const newRevision = expectedRevision + 1;
    const payload = encodePayload(state, this.serializer);
    try {
      if (expectedRevision === 0) {
        await operations.putItem({
          TableName: this.tableName,
          Item: {
            pid: stringAttribute(persistenceId),
            revision: numberAttribute(newRevision),
            payload: stringAttribute(payload),
            ts: numberAttribute(now),
          },
          ConditionExpression: 'attribute_not_exists(pid)',
        });
      } else {
        await operations.updateItem({
          TableName: this.tableName,
          Key: { pid: stringAttribute(persistenceId) },
          UpdateExpression: 'SET #rev = :new, payload = :payload, ts = :ts',
          ConditionExpression: '#rev = :expected',
          ExpressionAttributeNames: { '#rev': 'revision' },
          ExpressionAttributeValues: {
            ':new': numberAttribute(newRevision),
            ':expected': numberAttribute(expectedRevision),
            ':payload': stringAttribute(payload),
            ':ts': numberAttribute(now),
          },
        });
      }
      return { persistenceId, revision: newRevision, state, timestamp: now };
    } catch (e) {
      if (isConditionalCheckFailed(e)) {
        throw new DurableStateConcurrencyError(
          persistenceId, expectedRevision, await this.currentRevision(operations, persistenceId),
        );
      }
      this.fail('upsert', e);
    }
  }

  async load<S>(persistenceId: string, _options?: PersistenceOptions): Promise<Option<DurableStateRecord<S>>> {
    const operations = await this.ensureOpen();
    const found = await operations.getItem({
      TableName: this.tableName,
      Key: { pid: stringAttribute(persistenceId) },
      // A durable-state read feeds a CAS write, so an eventually-consistent read
      // would let a caller compute its next revision from a stale one.
      ConsistentRead: true,
    });
    if (!found.Item) return none;
    return some({
      persistenceId,
      revision: readNumber(found.Item, 'revision'),
      state: decodePayload(readString(found.Item, 'payload'), this.serializer) as S,
      timestamp: readNumber(found.Item, 'ts'),
    });
  }

  async delete(persistenceId: string): Promise<void> {
    const operations = await this.ensureOpen();
    await operations.deleteItem({
      TableName: this.tableName,
      Key: { pid: stringAttribute(persistenceId) },
    });
  }

  /* --------------------------- internals -------------------------------- */

  /** Read the stored revision for conflict reporting; 0 when the item is gone. */
  private async currentRevision(operations: DynamoDbOperations, persistenceId: string): Promise<number> {
    const found = await operations.getItem({
      TableName: this.tableName,
      Key: { pid: stringAttribute(persistenceId) },
      ConsistentRead: true,
    });
    return found.Item ? readNumber(found.Item, 'revision') : 0;
  }
}
