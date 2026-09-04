import { DEFAULT_SNAPSHOT_KEEP_N, DYNAMODB_MAX_BATCH_ITEMS, DYNAMODB_STORAGE_IDENTITY_KEY } from '../Constants.js';
import { type Snapshot } from '../JournalTypes.js';
import type { PersistenceOptionSupport } from '../PersistenceCapabilities.js';
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
import type { Serializer } from '../../serialization/Serializer.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import {
  DEFAULT_DYNAMODB_SNAPSHOTS_TABLE,
  DynamoDbSnapshotStoreOptionsValidator,
  type DynamoDbSnapshotStoreOptions,
  type DynamoDbSnapshotStoreOptionsType,
} from './DynamoDbSnapshotStoreOptions.js';

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
 *
 * **The two loads are strong reads; the two prune/delete queries are not.**  A
 * stale `loadLatest` is not merely "an older snapshot, so a longer replay": once
 * the journal has been compacted past the newest snapshot, folding from an older
 * one starts the replay at a point the surviving events no longer adjoin, and
 * `assertTrustworthyHistory` aborts recovery with a `JournalIntegrityError` over
 * a store that is perfectly intact.  The retention queries stay eventually
 * consistent because a stale read there can only shift the keep-window
 * *downwards*, i.e. under-delete, which loses nothing and lies about nothing —
 * unlike the journal's compaction, this store raises no mark that a surviving
 * row would contradict.
 */
export class DynamoDbSnapshotStore extends DynamoDbStore implements SnapshotStore {
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
  private readonly keepN: number;

  private readonly serializer?: Serializer;

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
    this.tableName = resolvedOptions.snapshotsTable ?? DEFAULT_DYNAMODB_SNAPSHOTS_TABLE;
    this.keepN = resolvedOptions.keepN ?? DEFAULT_SNAPSHOT_KEEP_N;
    this.serializer = resolvedOptions.serializer;
  }

  protected tables(): DynamoDbTableSchema[] {
    return [{ tableName: this.tableName, partitionKey: 'pid', sortKey: { name: 'seq', type: 'N' } }];
  }

  async storageIdentity(): Promise<string> {
    return this.storageIdentityFromTable(this.tableName, {
      pid: stringAttribute(DYNAMODB_STORAGE_IDENTITY_KEY),
      seq: numberAttribute(0),
    });
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
          payload: stringAttribute(encodePayload(state, this.serializer)),
          ts: numberAttribute(now),
        },
      });
    } catch (e) {
      this.fail('save', e);
    }
    // Best-effort prune — outside the write's catch on purpose.  See the
    // retention note on `SnapshotStore.save`.
    if (this.keepN > 0) {
      try { await this.prune(operations, persistenceId); } catch { /* swallow */ }
    }
    return { persistenceId, sequenceNr: seq, state, timestamp: now };
  }

  async loadLatest<S>(persistenceId: string, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const operations = await this.ensureOpen();
    const found = await operations.query({
      TableName: this.tableName,
      KeyConditionExpression: 'pid = :pid',
      ExpressionAttributeValues: { ':pid': stringAttribute(persistenceId) },
      ScanIndexForward: false,
      Limit: 1,
      // This picks the point recovery folds from, so a stale answer is a wrong
      // starting point rather than a slower one — see the class docs.
      ConsistentRead: true,
    });
    const item = found.Items?.[0];
    return item ? some(toSnapshot<S>(item, this.serializer)) : none;
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
      // Same as `loadLatest`: DevTools time travel folds from whatever this
      // returns, and a stale answer changes the state it reconstructs.
      ConsistentRead: true,
    });
    const item = found.Items?.[0];
    return item ? some(toSnapshot<S>(item, this.serializer)) : none;
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
   *
   * Left eventually consistent, unlike the two loads: a replica missing the
   * newest snapshots yields a *lower* cutoff, so the window over-keeps rather
   * than over-deletes.  The next `save` prunes again.
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

  /**
   * Query for keys only, paging to exhaustion.
   *
   * Feeds `delete` and `prune`, both of which only ever remove rows — so the
   * eventually-consistent read is deliberate here too: a stale page under-deletes,
   * and a snapshot that outlives its retention window is still a truthful
   * snapshot of state that really existed.
   */
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
    for (let offset = 0; offset < items.length; offset += DYNAMODB_MAX_BATCH_ITEMS) {
      let requests = items.slice(offset, offset + DYNAMODB_MAX_BATCH_ITEMS).map((item) => ({
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

function toSnapshot<S>(item: DynamoDbItem, serializer?: Serializer): Snapshot<S> {
  return {
    persistenceId: readString(item, 'pid'),
    sequenceNr: readNumber(item, 'seq'),
    state: decodePayload(readString(item, 'payload'), serializer) as S,
    timestamp: readNumber(item, 'ts'),
  };
}
