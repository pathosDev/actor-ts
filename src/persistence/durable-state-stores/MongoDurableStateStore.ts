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
  buildMongoResource,
  isMongoDuplicateKeyError,
  type MongoCollectionLike,
  type MongoDatabaseLike,
} from '../journals/MongoClient.js';
import { MongoStore } from '../journals/MongoStore.js';
import type { Serializer } from '../../serialization/Serializer.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import {
  MongoDurableStateStoreOptionsValidator,
  type MongoDurableStateStoreOptions,
  type MongoDurableStateStoreOptionsType,
} from './MongoDurableStateStoreOptions.js';

type StateDocument = {
  readonly _id: string;
  readonly revision: number;
  readonly payload: string;
  readonly timestamp: number;
  readonly [field: string]: unknown;
};

/**
 * DurableStateStore backed by MongoDB — the "event-free" cousin of event
 * sourcing, one document per persistence id rewritten in place.
 *
 * The persistence id **is** the document `_id`, so uniqueness comes from the
 * index MongoDB creates for free and there is no secondary index to maintain.
 * Optimistic concurrency rides on the `revision` field:
 *
 *   - `expectedRevision === 0` → `insertOne`.  A collision is server error
 *     11000, which is the natural fit here: MongoDB has no "insert if absent"
 *     that reports zero affected rows, and letting `_id` reject the duplicate is
 *     both shorter and race-free.
 *   - `expectedRevision > 0` → `updateOne({ _id, revision: expected })`.  The
 *     revision is part of the *filter*, so a mismatch matches nothing —
 *     `matchedCount === 0` means the stored revision diverged.  This is the
 *     compare-and-swap the issue's `findOneAndUpdate` sketch describes, in the
 *     form that needs no round-trip for the old document.
 *
 * Either way the current revision is read back so the error reports what the
 * caller actually raced against.
 */
export class MongoDurableStateStore extends MongoStore implements DurableStateStore {
  /** The payload is a plain document field — `options` is bound and never read (#960). */
  readonly persistenceOptionSupport: PersistenceOptionSupport = {
    encryption: false,
    compression: false,
    integrity: false,
  };

  private readonly collectionName: string;

  private readonly serializer?: Serializer;

  constructor(options: MongoDurableStateStoreOptions = {}) {
    const resolvedOptions = (options as MongoDurableStateStoreOptionsType);
    new MongoDurableStateStoreOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'MongoDurableStateStore',
      ownsClient: resolvedOptions.client === undefined,
      openClient: () => buildMongoResource(resolvedOptions),
    });
    this.collectionName = resolvedOptions.collection ?? 'durable_state';
    this.serializer = resolvedOptions.serializer;
  }

  /** Nothing to create: `_id` is indexed and unique by definition. */
  protected async createIndexes(_database: MongoDatabaseLike): Promise<void> { /* no-op */ }

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
    const { database } = await this.ensureOpen();
    const now = Date.now();
    const newRevision = expectedRevision + 1;
    const payload = encodePayload(state, this.serializer);
    try {
      if (expectedRevision === 0) {
        try {
          await this.states(database).insertOne({
            _id: persistenceId, revision: newRevision, payload, timestamp: now,
          });
        } catch (e) {
          if (isMongoDuplicateKeyError(e)) {
            throw new DurableStateConcurrencyError(
              persistenceId, expectedRevision, await this.currentRevision(database, persistenceId),
            );
          }
          throw e;
        }
      } else {
        const result = await this.states(database).updateOne(
          { _id: persistenceId, revision: expectedRevision },
          { $set: { revision: newRevision, payload, timestamp: now } },
        );
        if (result.matchedCount === 0) {
          throw new DurableStateConcurrencyError(
            persistenceId, expectedRevision, await this.currentRevision(database, persistenceId),
          );
        }
      }
      return { persistenceId, revision: newRevision, state, timestamp: now };
    } catch (e) {
      if (e instanceof DurableStateConcurrencyError) throw e;
      this.fail('upsert', e);
    }
  }

  async load<S>(persistenceId: string, _options?: PersistenceOptions): Promise<Option<DurableStateRecord<S>>> {
    const { database } = await this.ensureOpen();
    const document = await this.states(database).findOne({ _id: persistenceId });
    if (!document) return none;
    return some({
      persistenceId,
      revision: Number(document.revision),
      state: decodePayload(document.payload, this.serializer) as S,
      timestamp: Number(document.timestamp),
    });
  }

  async delete(persistenceId: string): Promise<void> {
    const { database } = await this.ensureOpen();
    await this.states(database).deleteOne({ _id: persistenceId });
  }

  /* --------------------------- internals -------------------------------- */

  private states(database: MongoDatabaseLike): MongoCollectionLike<StateDocument> {
    return database.collection<StateDocument>(this.collectionName);
  }

  /** Read the stored revision for conflict reporting; 0 when the document is gone. */
  private async currentRevision(database: MongoDatabaseLike, persistenceId: string): Promise<number> {
    const document = await this.states(database).findOne({ _id: persistenceId });
    return document ? Number(document.revision) : 0;
  }
}
