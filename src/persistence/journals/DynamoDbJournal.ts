import { DYNAMODB_MAX_BATCH_ITEMS, DYNAMODB_MAX_TRANSACTION_ITEMS, DYNAMODB_STORAGE_IDENTITY_KEY } from '../Constants.js';
import type { Journal } from '../Journal.js';
import {
  JournalConcurrencyError,
  JournalError,
  type JournalEntry,
  type PersistentEvent,
} from '../JournalTypes.js';
import type { Serializer } from '../../serialization/Serializer.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import { assertValidPersistenceId } from '../storage/PersistenceIdValidator.js';
import { assertValidEntryTags } from '../storage/TagValidator.js';
import {
  buildDynamoDbOperations,
  isConditionalCheckFailed,
  numberAttribute,
  readNumber,
  readString,
  readStringSet,
  stringAttribute,
  stringSetAttribute,
  type DynamoDbItem,
  type DynamoDbOperations,
} from './DynamoDbClient.js';
import { DynamoDbStore, type DynamoDbTableSchema } from './DynamoDbStore.js';
import {
  DynamoDbJournalOptionsValidator,
  type DynamoDbJournalOptions,
  type DynamoDbJournalOptionsType,
} from './DynamoDbJournalOptions.js';

/**
 * Sort-key value reserved for the per-persistence-id metadata item.  Real
 * sequence numbers start at 1, so 0 can never collide with an event — which is
 * what lets the compaction high-water mark live in the same table and be read
 * with a plain `GetItem` instead of needing a second table.
 */
const META_SEQ = 0;

/**
 * Journal backed by Amazon DynamoDB.
 *
 * **Optimistic concurrency is a conditional write, and it is stronger than the
 * relational backends'.**  `append` sends every event in one
 * `TransactWriteItems`, each `Put` carrying
 * `ConditionExpression: attribute_not_exists(pid)` — "only if this
 * `(pid, seq)` item does not exist".  A racing writer therefore cannot win a
 * partial append: the transaction is atomic across all items, so either the
 * whole batch lands or none of it does, and the cancellation is translated into
 * `JournalConcurrencyError`.  The preceding head read is only an optimization
 * *for the write's safety* — it turns the common stale-append into one cheap
 * query instead of a rejected transaction — but its **value** is load-bearing
 * everywhere else, which is why it is a strong read (below).
 *
 * That atomicity is why this backend needs no equivalent of MongoDB's
 * "a mid-batch failure can persist a prefix" caveat.
 *
 * **Every read that feeds recovery or a sequence-number decision is strong.**
 * DynamoDB defaults to eventually-consistent reads, and a stale one here is not
 * "slightly old data": a head read served by a lagging replica reports a stream
 * that has *rewound*, so the next `append` is rejected against a sequence number
 * that already exists and `PersistentActor` attributes it to a second writer;
 * a stale replay page truncates history, which nothing downstream can detect
 * because `assertTrustworthyHistory` has no independent statement of where the
 * stream ends.  So `read`, `readHead` and `delete`'s doomed-key query all set
 * `ConsistentRead: true`.  `persistenceIds`' scan does not, deliberately and
 * with a comment saying why — an unexplained weak read is how #736 arose.
 *
 * The cost is real and is not paid once per recovery: `read` and `highestSeq`
 * are also the query layer's catch-up path and projection tooling's, so a strong
 * read doubles the consumed capacity of those too.  It is the right trade —
 * a projection that silently misses the newest events is its own defect — but it
 * is a trade, and the DynamoDB docs page states it.
 *
 * **The high-water mark is an item, not a table.**  Compaction stores
 * `deletedTo` at the reserved sort key 0, updated with
 * `ConditionExpression: attribute_not_exists(deletedTo) OR deletedTo < :value`,
 * which is `GREATEST` / `$max` expressed as a condition: a lower value is
 * rejected, and the rejection is expected rather than an error.
 *
 * **Reads and deletes page.**  DynamoDB returns at most 1 MB per `Query`, so a
 * recovery over a long stream loops on `LastEvaluatedKey`; skipping that is the
 * classic way to silently truncate a replay.
 *
 * Being a remote, cross-process store, it exposes no in-process event bus, so
 * the query layer polls.  There is no indexed tag path yet — see the class
 * docs for what that would take.
 */
export class DynamoDbJournal extends DynamoDbStore implements Journal {
  private readonly tableName: string;

  private readonly serializer?: Serializer;

  constructor(options: DynamoDbJournalOptions = {}) {
    const resolvedOptions = (options as DynamoDbJournalOptionsType);
    new DynamoDbJournalOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'DynamoDbJournal',
      autoCreateTables: resolvedOptions.autoCreateTables,
      billingMode: resolvedOptions.billingMode,
      provisionedThroughput: resolvedOptions.provisionedThroughput,
      tableReadyTimeoutMs: resolvedOptions.tableReadyTimeoutMs,
      ownsClient: resolvedOptions.operations === undefined,
      openClient: () => buildDynamoDbOperations(resolvedOptions),
    });
    this.tableName = resolvedOptions.eventsTable ?? 'actor_ts_events';
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

  async append<E>(
    persistenceId: string,
    entries: ReadonlyArray<JournalEntry<E>>,
    expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> {
    if (entries.length === 0) return [];
    assertValidPersistenceId(persistenceId, 'DynamoDbJournal.append');
    assertValidEntryTags(entries);
    if (entries.length > DYNAMODB_MAX_TRANSACTION_ITEMS) {
      // Chunking would break atomicity, which is the property this backend's
      // concurrency rests on — so refuse clearly instead of silently degrading.
      throw new JournalError(
        `DynamoDbJournal.append: DynamoDB caps an atomic transaction at ${DYNAMODB_MAX_TRANSACTION_ITEMS} items, `
        + `got ${entries.length} events.  Persist them in smaller batches.`,
      );
    }
    const operations = await this.ensureOpen();
    const now = Date.now();
    try {
      const actualSeq = await this.readHead(operations, persistenceId);
      if (actualSeq !== expectedSeq) {
        throw new JournalConcurrencyError(persistenceId, expectedSeq, actualSeq);
      }
      const written: PersistentEvent<E>[] = [];
      const transactItems: Array<Record<string, unknown>> = [];
      let seq = actualSeq;
      for (const entry of entries) {
        seq++;
        const tags = entry.tags;
        transactItems.push({
          Put: {
            TableName: this.tableName,
            Item: {
              pid: stringAttribute(persistenceId),
              seq: numberAttribute(seq),
              payload: stringAttribute(encodePayload(entry.event, this.serializer)),
              ts: numberAttribute(now),
              // A DynamoDB set cannot be empty, so an untagged event simply has
              // no `tags` attribute.
              ...(tags && tags.length ? { tags: stringSetAttribute(tags) } : {}),
            },
            ConditionExpression: 'attribute_not_exists(pid)',
          },
        });
        written.push({
          persistenceId,
          sequenceNr: seq,
          event: entry.event,
          timestamp: now,
          tags: tags ? [...tags] : undefined,
        });
      }
      await operations.transactWriteItems({ TransactItems: transactItems });
      return written;
    } catch (e) {
      if (e instanceof JournalConcurrencyError) throw e;
      // A concurrent writer claimed one of our sequence numbers between the head
      // read and the transaction.  Nothing was written — the transaction is
      // all-or-nothing — so report the now-current head and let the caller retry.
      if (isConditionalCheckFailed(e)) {
        const actual = await this.highestSeq(persistenceId).catch(() => expectedSeq);
        throw new JournalConcurrencyError(persistenceId, expectedSeq, actual);
      }
      this.fail('append', e);
    }
  }

  async read<E>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    const operations = await this.ensureOpen();
    try {
      // The lower bound is raised past the metadata item so it never surfaces as
      // an event, whatever the caller asked for.
      const lowerBound = Math.max(fromSeq, META_SEQ + 1);
      const upperBound = toSeq ?? Number.MAX_SAFE_INTEGER;
      if (upperBound < lowerBound) return [];
      const items = await this.queryAllPages(operations, {
        TableName: this.tableName,
        KeyConditionExpression: 'pid = :pid AND seq BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pid': stringAttribute(persistenceId),
          ':from': numberAttribute(lowerBound),
          ':to': numberAttribute(upperBound),
        },
        // Recovery folds whatever this returns, and a missing *tail* is
        // undetectable downstream: `assertTrustworthyHistory` catches a hole, a
        // wrong order and an out-of-window event, but nothing states where the
        // stream should end.  An eventually-consistent page therefore truncates
        // a replay in silence, and the actor resumes on superseded state.
        ConsistentRead: true,
      });
      return items.map((item) => ({
        persistenceId: readString(item, 'pid'),
        sequenceNr: readNumber(item, 'seq'),
        event: decodePayload(readString(item, 'payload'), this.serializer) as E,
        timestamp: readNumber(item, 'ts'),
        tags: readStringSet(item, 'tags'),
      }));
    } catch (e) {
      this.fail('read', e);
    }
  }

  async highestSeq(persistenceId: string): Promise<number> {
    const operations = await this.ensureOpen();
    try {
      return await this.readHead(operations, persistenceId);
    } catch (e) {
      this.fail('highestSeq', e);
    }
  }

  async delete(persistenceId: string, toSeq: number): Promise<void> {
    const operations = await this.ensureOpen();
    try {
      const doomed = await this.queryAllPages(operations, {
        TableName: this.tableName,
        KeyConditionExpression: 'pid = :pid AND seq BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pid': stringAttribute(persistenceId),
          ':from': numberAttribute(META_SEQ + 1),
          ':to': numberAttribute(toSeq),
        },
        // Only the keys are needed to delete.
        ProjectionExpression: 'pid, seq',
        // The mark below is raised over the whole range regardless of what came
        // back, so a stale page here leaves events alive *below* a mark that says
        // they are gone.  Same class of defect the `UnprocessedItems` retry loop
        // in `batchDelete` exists to prevent, reached by a different route.
        ConsistentRead: true,
      });
      await this.batchDelete(operations, doomed);
      await this.raiseDeletedTo(operations, persistenceId, toSeq);
    } catch (e) {
      this.fail('delete', e);
    }
  }

  /** The mark half of `delete`, without the query-and-batch-delete in front of it. */
  async raiseCompactionMark(persistenceId: string, throughSeq: number): Promise<void> {
    const operations = await this.ensureOpen();
    try {
      await this.raiseDeletedTo(operations, persistenceId, throughSeq);
    } catch (e) {
      this.fail('raiseCompactionMark', e);
    }
  }

  /**
   * No `persistenceIdsPaginated` counterpart, deliberately.  Paging needs a
   * *sorted* index over the ids, and a DynamoDB table has no order across
   * partition keys at all — `Scan` hands rows back in hash order, and its
   * `LastEvaluatedKey` cursor is not comparable to a persistence id.  Slicing
   * a scan by page would therefore return arbitrary, overlapping subsets; the
   * query layer's fallback (scan once, sort, cut) is the honest shape, and
   * leaving the method off is what selects it.
   */
  async persistenceIds(): Promise<string[]> {
    const operations = await this.ensureOpen();
    try {
      // A full table scan: DynamoDB can only enumerate partition keys this way.
      // Documented as the expensive operation it is — the framework itself only
      // calls it from projection tooling, not on the hot path.
      const found = new Set<string>();
      let startKey: DynamoDbItem | undefined;
      do {
        // No `ConsistentRead` here, and that is the deliberate exception rather
        // than the oversight it looks like: a strong scan doubles the capacity of
        // the store's most expensive call, and no sequence-number decision hangs
        // on the result — an id surfacing one call later costs a projection a
        // poll interval, whereas a truncated stream costs correctness.
        const page = await operations.scan({
          TableName: this.tableName,
          ProjectionExpression: 'pid',
          // The identity item (#1358) lives in this table under a sentinel
          // key — it is metadata, not a stream, so enumeration skips it.
          FilterExpression: 'pid <> :storageIdentitySentinel',
          ExpressionAttributeValues: {
            ':storageIdentitySentinel': stringAttribute(DYNAMODB_STORAGE_IDENTITY_KEY),
          },
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        });
        for (const item of page.Items ?? []) found.add(readString(item, 'pid'));
        startKey = page.LastEvaluatedKey;
      } while (startKey);
      return [...found];
    } catch (e) {
      this.fail('persistenceIds', e);
    }
  }

  /* --------------------------- internals -------------------------------- */

  /** Highest sequence number ever written — the events head or the compaction mark. */
  private async readHead(operations: DynamoDbOperations, persistenceId: string): Promise<number> {
    const head = await operations.query({
      TableName: this.tableName,
      KeyConditionExpression: 'pid = :pid AND seq > :meta',
      ExpressionAttributeValues: {
        ':pid': stringAttribute(persistenceId),
        ':meta': numberAttribute(META_SEQ),
      },
      // Descending, one item: the sort key makes this the cheapest read there is.
      ScanIndexForward: false,
      Limit: 1,
      ProjectionExpression: 'seq',
      // Strong for the same reason the mark below is, and it has to be the same
      // reason: this value is `append`'s `expectedSeq` comparand and the bound
      // `assertTrustworthySnapshot` believes, so a head from a lagging replica
      // makes an intact stream look rewound — the next `persist` is then read as
      // a second writer and the entity is stopped, and a legitimate snapshot is
      // accused of tampering.  Reading the mark strongly and the head weakly
      // only hides the first case, on streams that have been compacted.
      ConsistentRead: true,
    });
    const headSeq = head.Items?.[0] ? readNumber(head.Items[0], 'seq') : 0;
    const mark = await operations.getItem({
      TableName: this.tableName,
      Key: { pid: stringAttribute(persistenceId), seq: numberAttribute(META_SEQ) },
      // A stale mark would let the head rewind, so this read must be strong.
      ConsistentRead: true,
    });
    const deletedTo = mark.Item ? readNumber(mark.Item, 'deletedTo') : 0;
    return Math.max(headSeq, deletedTo);
  }

  /** Monotonic `deletedTo` — a lower value is rejected, and that is not an error. */
  private async raiseDeletedTo(
    operations: DynamoDbOperations,
    persistenceId: string,
    toSeq: number,
  ): Promise<void> {
    try {
      await operations.updateItem({
        TableName: this.tableName,
        Key: { pid: stringAttribute(persistenceId), seq: numberAttribute(META_SEQ) },
        UpdateExpression: 'SET deletedTo = :value',
        ConditionExpression: 'attribute_not_exists(deletedTo) OR deletedTo < :value',
        ExpressionAttributeValues: { ':value': numberAttribute(toSeq) },
      });
    } catch (e) {
      // The condition failing means the stored mark is already at least as high,
      // which is exactly what monotonic means — not a failure to report.
      if (!isConditionalCheckFailed(e)) throw e;
    }
  }

  /** Run a query to exhaustion — DynamoDB pages at 1 MB. */
  private async queryAllPages(
    operations: DynamoDbOperations,
    input: Record<string, unknown>,
  ): Promise<DynamoDbItem[]> {
    const items: DynamoDbItem[] = [];
    let startKey: DynamoDbItem | undefined;
    do {
      const page = await operations.query({
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
      // `UnprocessedItems` is DynamoDB shedding load, not an error — it has to be
      // retried or the delete silently leaves rows behind.
      for (let attempt = 0; requests.length > 0 && attempt < 5; attempt++) {
        const result = await operations.batchWriteItem({ RequestItems: { [this.tableName]: requests } });
        const unprocessed = result.UnprocessedItems?.[this.tableName] ?? [];
        requests = unprocessed as typeof requests;
        if (requests.length > 0) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
      if (requests.length > 0) {
        throw new Error(`${requests.length} item(s) still unprocessed after 5 batch-write attempts`);
      }
    }
  }
}
