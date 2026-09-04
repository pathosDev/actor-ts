import { type Snapshot } from '../JournalTypes.js';
import type { PersistenceOptionSupport } from '../PersistenceCapabilities.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import { none, some, type Option } from '../../util/Option.js';
import {
  buildMongoResource,
  type MongoCollectionLike,
  type MongoDatabaseLike,
} from '../journals/MongoClient.js';
import { DEFAULT_SNAPSHOTS_TABLE, DEFAULT_SNAPSHOT_KEEP_N } from '../Constants.js';
import { MongoStore } from '../journals/MongoStore.js';
import type { Serializer } from '../../serialization/Serializer.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import {
  MongoSnapshotStoreOptionsValidator,
  type MongoSnapshotStoreOptions,
  type MongoSnapshotStoreOptionsType,
} from './MongoSnapshotStoreOptions.js';

type SnapshotDocument = {
  readonly persistenceId: string;
  readonly sequenceNr: number;
  readonly payload: string;
  readonly timestamp: number;
  readonly [field: string]: unknown;
};

/**
 * SnapshotStore backed by MongoDB.
 *
 * One document per `(persistenceId, sequenceNr)` behind a unique index, so
 * `save` at an existing sequence number overwrites in place and `loadLatest` is
 * an indexed descending read.  Payloads are JSON text for the same reason as in
 * `MongoJournal` — exact round-trip fidelity over queryability the framework
 * does not use.
 *
 * `PersistenceOptions` (compression, encryption) are ignored, matching the SQL
 * and Cassandra stores; the object-storage store is the one that honours them.
 */
export class MongoSnapshotStore extends MongoStore implements SnapshotStore {
  /** The payload is a plain document field — `options` is bound and never read (#960). */
  readonly persistenceOptionSupport: PersistenceOptionSupport = {
    encryption: false,
    compression: false,
    integrity: false,
  };

  private readonly collectionName: string;
  private readonly keepN: number;

  private readonly serializer?: Serializer;

  constructor(options: MongoSnapshotStoreOptions = {}) {
    const resolvedOptions = (options as MongoSnapshotStoreOptionsType);
    new MongoSnapshotStoreOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'MongoSnapshotStore',
      autoCreateIndexes: resolvedOptions.autoCreateIndexes,
      ownsClient: resolvedOptions.client === undefined,
      openClient: () => buildMongoResource(resolvedOptions),
    });
    this.collectionName = resolvedOptions.snapshotsCollection ?? DEFAULT_SNAPSHOTS_TABLE;
    this.keepN = resolvedOptions.keepN ?? DEFAULT_SNAPSHOT_KEEP_N;
    this.serializer = resolvedOptions.serializer;
  }

  protected async createIndexes(database: MongoDatabaseLike): Promise<void> {
    await this.snapshots(database).createIndex({ persistenceId: 1, sequenceNr: 1 }, { unique: true });
  }

  async save<S>(persistenceId: string, seq: number, state: S, _options?: PersistenceOptions): Promise<Snapshot<S>> {
    const { database } = await this.ensureOpen();
    const now = Date.now();
    try {
      await this.snapshots(database).updateOne(
        { persistenceId, sequenceNr: seq },
        { $set: { payload: encodePayload(state, this.serializer), timestamp: now } },
        { upsert: true },
      );
    } catch (e) {
      this.fail('save', e);
    }
    // Best-effort prune — outside the write's catch on purpose.  See the
    // retention note on `SnapshotStore.save`.
    if (this.keepN > 0) {
      try { await this.prune(database, persistenceId); } catch { /* swallow */ }
    }
    return { persistenceId, sequenceNr: seq, state, timestamp: now };
  }

  async loadLatest<S>(persistenceId: string, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const { database } = await this.ensureOpen();
    const [document] = await this.snapshots(database)
      .find({ persistenceId })
      .sort({ sequenceNr: -1 })
      .limit(1)
      .toArray();
    return document ? some(toSnapshot<S>(document, this.serializer)) : none;
  }

  async loadBefore<S>(persistenceId: string, seq: number, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const { database } = await this.ensureOpen();
    const [document] = await this.snapshots(database)
      .find({ persistenceId, sequenceNr: { $lt: seq } })
      .sort({ sequenceNr: -1 })
      .limit(1)
      .toArray();
    return document ? some(toSnapshot<S>(document, this.serializer)) : none;
  }

  async delete(persistenceId: string, toSeq: number): Promise<void> {
    const { database } = await this.ensureOpen();
    await this.snapshots(database).deleteMany({ persistenceId, sequenceNr: { $lte: toSeq } });
  }

  /* --------------------------- internals -------------------------------- */

  private snapshots(database: MongoDatabaseLike): MongoCollectionLike<SnapshotDocument> {
    return database.collection<SnapshotDocument>(this.collectionName);
  }

  /**
   * Prune-on-save.  Rather than fetch every snapshot and delete the tail, skip
   * to the first one that falls outside `keepN` and delete from there down — one
   * bounded read plus one ranged delete, whatever the history length.
   */
  private async prune(database: MongoDatabaseLike, persistenceId: string): Promise<void> {
    const [cutoff] = await this.snapshots(database)
      .find({ persistenceId })
      .sort({ sequenceNr: -1 })
      .skip(this.keepN)
      .limit(1)
      .toArray();
    if (!cutoff) return;   // fewer than keepN snapshots — nothing to prune
    await this.snapshots(database).deleteMany({
      persistenceId,
      sequenceNr: { $lte: Number(cutoff.sequenceNr) },
    });
  }
}

function toSnapshot<S>(document: SnapshotDocument, serializer?: Serializer): Snapshot<S> {
  return {
    persistenceId: document.persistenceId,
    sequenceNr: Number(document.sequenceNr),
    state: decodePayload(document.payload, serializer) as S,
    timestamp: Number(document.timestamp),
  };
}
