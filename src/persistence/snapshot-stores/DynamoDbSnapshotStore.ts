import { type Snapshot } from '../JournalTypes.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import { none, some, type Option } from '../../util/Option.js';
import {
  buildDynamoDbOperations,
  numberAttribute,
  readNumber,
  readString,
  stringAttribute,
  type DynamoDbItem,
  type DynamoDbOperations,
} from '../journals/DynamoDbClient.js';
import { DynamoDbStore, type DynamoDbTableSchema } from '../journals/DynamoDbStore.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import {
  DynamoDbSnapshotStoreOptionsValidator,
  type DynamoDbSnapshotStoreOptions,
  type DynamoDbSnapshotStoreOptionsType,
} from './DynamoDbSnapshotStoreOptions.js';

/** Batch writes are capped at 25 items per request. */
const MAX_BATCH_ITEMS = 25;

/**
 * SnapshotStore backed by Amazon DynamoDB.
 *
 * Partition key `pid`, sort key `seq`, so `loadLatest` is a descending query
 * limited to one item — the cheapest read DynamoDB offers — and re-saving at an
 * existing sequence number simply overwrites the item, no conditional write
 * needed.
 *
 * `PersistenceOptions` (compression, encryption) are ignored, matching the SQL,
 * Cassandra and MongoDB stores; the object-storage store is the one that honours
 * them.
 */
export class DynamoDbSnapshotStore extends DynamoDbStore implements SnapshotStore {
  private readonly tableName: string;
  private readonly keepN: number;

  constructor(options: DynamoDbSnapshotStoreOptions = {}) {
    const resolvedOptions = (options as DynamoDbSnapshotStoreOptionsType);
    new DynamoDbSnapshotStoreOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'DynamoDbSnapshotStore',
      autoCreateTables: resolvedOptions.autoCreateTables,
      billingMode: resolvedOptions.billingMode,
      provisionedThroughput: resolvedOptions.provisionedThroughput,
      tableReadyTimeoutMs: resolvedOptions.tableReadyTimeoutMs,
      ownsClient: resolvedOptions.operations === undefined,
      openClient: () => buildDynamoDbOperations(resolvedOptions),
    });
    this.tableName = resolvedOptions.snapshotsTable ?? 'actor_ts_snapshots';
    this.keepN = resolvedOptions.keepN ?? 3;
  }

  protected tables(): DynamoDbTableSchema[] {
    return [{ tableName: this.tableName, partitionKey: 'pid', sortKey: { name: 'seq', type: 'N' } }];
  }

  async save<S>(persistenceId: string, seq: number, state: S, _options?: PersistenceOptions): Promise<Snapshot<S>> {
    const operations = await this.ensureOpen();
    const now = Date.now();
    try {
      await operations.putItem({
        TableName: this.tableName,
        Item: {
          pid: stringAttribute(persistenceId),
          seq: numberAttribute(seq),
          payload: stringAttribute(encodePayload(state)),
          ts: numberAttribute(now),
        },
      });
      if (this.keepN > 0) await this.prune(operations, persistenceId);
      return { persistenceId, sequenceNr: seq, state, timestamp: now };
    } catch (e) {
      this.fail('save', e);
    }
  }

  async loadLatest<S>(persistenceId: string, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const operations = await this.ensureOpen();
    const found = await operations.query({
      TableName: this.tableName,
      KeyConditionExpression: 'pid = :pid',
      ExpressionAttributeValues: { ':pid': stringAttribute(persistenceId) },
      ScanIndexForward: false,
      Limit: 1,
    });
    const item = found.Items?.[0];
    return item ? some(toSnapshot<S>(item)) : none;
  }

  async loadBefore<S>(persistenceId: string, seq: number, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const operations = await this.ensureOpen();
    const found = await operations.query({
      TableName: this.tableName,
      KeyConditionExpression: 'pid = :pid AND seq < :seq',
      ExpressionAttributeValues: {
        ':pid': stringAttribute(persistenceId),
        ':seq': numberAttribute(seq),
      },
      ScanIndexForward: false,
      Limit: 1,
    });
    const item = found.Items?.[0];
    return item ? some(toSnapshot<S>(item)) : none;
  }

  async delete(persistenceId: string, toSeq: number): Promise<void> {
    const operations = await this.ensureOpen();
    const doomed = await this.queryKeys(operations, {
      KeyConditionExpression: 'pid = :pid AND seq <= :seq',
      ExpressionAttributeValues: {
        ':pid': stringAttribute(persistenceId),
        ':seq': numberAttribute(toSeq),
      },
    });
    await this.batchDelete(operations, doomed);
  }

  /* --------------------------- internals -------------------------------- */

  /**
   * Prune-on-save.  DynamoDB has no `OFFSET`, so the newest `keepN + 1` keys are
   * read descending and everything from the last one down is deleted — one
   * bounded query plus a batch delete, independent of how long the history is.
   */
  private async prune(operations: DynamoDbOperations, persistenceId: string): Promise<void> {
    const newest = await operations.query({
      TableName: this.tableName,
      KeyConditionExpression: 'pid = :pid',
      ExpressionAttributeValues: { ':pid': stringAttribute(persistenceId) },
      ScanIndexForward: false,
      Limit: this.keepN + 1,
      ProjectionExpression: 'pid, seq',
    });
    const items = newest.Items ?? [];
    if (items.length <= this.keepN) return;   // nothing outside the window yet
    const cutoff = readNumber(items[this.keepN]!, 'seq');
    const doomed = await this.queryKeys(operations, {
      KeyConditionExpression: 'pid = :pid AND seq <= :cutoff',
      ExpressionAttributeValues: {
        ':pid': stringAttribute(persistenceId),
        ':cutoff': numberAttribute(cutoff),
      },
    });
    await this.batchDelete(operations, doomed);
  }

  /** Query for keys only, paging to exhaustion. */
  private async queryKeys(
    operations: DynamoDbOperations,
    input: Record<string, unknown>,
  ): Promise<DynamoDbItem[]> {
    const items: DynamoDbItem[] = [];
    let startKey: DynamoDbItem | undefined;
    do {
      const page = await operations.query({
        TableName: this.tableName,
        ProjectionExpression: 'pid, seq',
        ...input,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      });
      items.push(...(page.Items ?? []));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return items;
  }

  /** Delete items 25 at a time, resubmitting whatever DynamoDB throttles. */
  private async batchDelete(operations: DynamoDbOperations, items: ReadonlyArray<DynamoDbItem>): Promise<void> {
    for (let offset = 0; offset < items.length; offset += MAX_BATCH_ITEMS) {
      let requests = items.slice(offset, offset + MAX_BATCH_ITEMS).map((item) => ({
        DeleteRequest: { Key: { pid: item.pid!, seq: item.seq! } },
      }));
      for (let attempt = 0; requests.length > 0 && attempt < 5; attempt++) {
        const result = await operations.batchWriteItem({ RequestItems: { [this.tableName]: requests } });
        requests = (result.UnprocessedItems?.[this.tableName] ?? []) as typeof requests;
        if (requests.length > 0) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
      if (requests.length > 0) {
        this.fail('delete', new Error(`${requests.length} item(s) still unprocessed after 5 batch-write attempts`));
      }
    }
  }
}

function toSnapshot<S>(item: DynamoDbItem): Snapshot<S> {
  return {
    persistenceId: readString(item, 'pid'),
    sequenceNr: readNumber(item, 'seq'),
    state: decodePayload(readString(item, 'payload')) as S,
    timestamp: readNumber(item, 'ts'),
  };
}
