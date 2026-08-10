import type { Journal } from '../Journal.js';
import {
  JournalConcurrencyError,
  type PersistentEvent,
} from '../JournalTypes.js';
import type { Serializer } from '../../serialization/Serializer.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import { assertValidPersistenceId } from '../storage/PersistenceIdValidator.js';
import { assertValidTags } from '../storage/TagValidator.js';
import {
  buildMongoResource,
  isMongoDuplicateKeyError,
  type MongoCollectionLike,
  type MongoDatabaseLike,
} from './MongoClient.js';
import { MongoStore } from './MongoStore.js';
import {
  MongoJournalOptionsValidator,
  type MongoJournalOptions,
  type MongoJournalOptionsType,
} from './MongoJournalOptions.js';

/** One event document.  `payload` is JSON text — see the class docblock. */
type EventDocument = {
  readonly persistenceId: string;
  readonly sequenceNr: number;
  readonly payload: string;
  readonly tags?: ReadonlyArray<string>;
  readonly timestamp: number;
  readonly [field: string]: unknown;
};

/** Compaction high-water mark, one document per persistence id. */
type MetaDocument = {
  readonly _id: string;
  readonly deletedTo: number;
  readonly [field: string]: unknown;
};

/**
 * Journal backed by MongoDB via the `mongodb` driver.
 *
 * **Optimistic concurrency rests on a unique index.**  `append` reads the
 * current head and then inserts; the unique compound index on
 * `(persistenceId, sequenceNr)` rejects a racing writer with server error
 * 11000, which is translated back into `JournalConcurrencyError`.  That is the
 * same two-layer scheme the relational backends use — the head check for the
 * ordinary case, a conditional write for the race — with the unique index
 * playing the part a primary key plays there.
 *
 * **No transaction, deliberately.**  Appends are contiguous from the head, so
 * two writers that agree on the head both try the *same first* sequence number:
 * the loser's `insertMany` fails on its first document and writes nothing, with
 * `ordered: true` stopping the batch there.  A partial append is therefore not
 * reachable through contention, which is what a transaction would have been for
 * — and skipping it keeps the backend usable on a standalone `mongod`, since
 * MongoDB transactions require a replica set.  A mid-batch *infrastructure*
 * failure (a dropped connection after the second of five events) can still
 * persist a prefix; the stream stays gap-free and the next append continues from
 * the new head, so recovery is consistent, but the caller's error does not mean
 * "nothing was written".  Single-event appends — the common case — are
 * atomic outright.
 *
 * **Payloads are stored as JSON text**, not as native BSON.  It costs the
 * ability to query inside a payload, which the framework never does (it queries
 * by persistence id, sequence number and tags), and it buys exact round-trip
 * fidelity: BSON would reject or mangle a payload with dotted or `$`-prefixed
 * keys, and would quietly change how `undefined` and dates come back.  The
 * other backends store JSON text too, so an event stream means the same thing
 * everywhere.
 *
 * Being a cross-process store, it exposes no in-process event bus, so the query
 * layer polls — same as Postgres and Cassandra.  Tag queries do use an index:
 * see `MongoQuery`.
 */
export class MongoJournal extends MongoStore implements Journal {
  private readonly eventsName: string;
  private readonly metaName: string;

  private readonly _serializer?: Serializer;

  constructor(options: MongoJournalOptions = {}) {
    const resolvedOptions = (options as MongoJournalOptionsType);
    new MongoJournalOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'MongoJournal',
      autoCreateIndexes: resolvedOptions.autoCreateIndexes,
      ownsClient: resolvedOptions.client === undefined,
      openClient: () => buildMongoResource(resolvedOptions),
    });
    this.eventsName = resolvedOptions.eventsCollection ?? 'events';
    this.metaName = `${this.eventsName}_meta`;
    this._serializer = resolvedOptions.serializer;
  }

  /** The configured payload serializer — read by `MongoQuery` so tag reads decode like the journal. */
  get serializer(): Serializer | undefined { return this._serializer; }

  protected async createIndexes(database: MongoDatabaseLike): Promise<void> {
    // Unique, and load-bearing: this index IS the concurrency backstop.
    await this.eventDocuments(database).createIndex({ persistenceId: 1, sequenceNr: 1 }, { unique: true });
    // Multikey over the `tags` array, ordered by timestamp so `MongoQuery` walks
    // a contiguous range rather than scanning.
    await this.eventDocuments(database).createIndex({ tags: 1, timestamp: 1 });
  }

  async append<E>(
    persistenceId: string,
    events: ReadonlyArray<E>,
    expectedSeq: number,
    tags?: ReadonlyArray<string>,
  ): Promise<PersistentEvent<E>[]> {
    if (events.length === 0) return [];
    assertValidPersistenceId(persistenceId, 'MongoJournal.append');
    assertValidTags(tags);
    const { database } = await this.ensureOpen();
    const now = Date.now();
    try {
      const actualSeq = await this.readHead(database, persistenceId);
      if (actualSeq !== expectedSeq) {
        throw new JournalConcurrencyError(persistenceId, expectedSeq, actualSeq);
      }
      const written: PersistentEvent<E>[] = [];
      const documents: EventDocument[] = [];
      let seq = actualSeq;
      for (const event of events) {
        seq++;
        documents.push({
          persistenceId,
          sequenceNr: seq,
          payload: encodePayload(event, this._serializer),
          ...(tags && tags.length ? { tags: [...tags] } : {}),
          timestamp: now,
        });
        written.push({
          persistenceId,
          sequenceNr: seq,
          event,
          timestamp: now,
          tags: tags ? [...tags] : undefined,
        });
      }
      // `ordered: true` so the batch stops at the first rejected document —
      // which, for a losing writer, is the first document.
      await this.eventDocuments(database).insertMany(documents, { ordered: true });
      return written;
    } catch (e) {
      if (e instanceof JournalConcurrencyError) throw e;
      // A concurrent writer claimed the same (persistenceId, sequenceNr)
      // between our head read and the insert.  Report the now-current head so
      // the caller can re-read and retry.
      if (isMongoDuplicateKeyError(e)) {
        const actual = await this.highestSeq(persistenceId).catch(() => expectedSeq);
        throw new JournalConcurrencyError(persistenceId, expectedSeq, actual);
      }
      this.fail('append', e);
    }
  }

  async read<E>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    const { database } = await this.ensureOpen();
    try {
      const documents = await this.eventDocuments(database)
        .find({
          persistenceId,
          sequenceNr: toSeq === undefined ? { $gte: fromSeq } : { $gte: fromSeq, $lte: toSeq },
        })
        .sort({ sequenceNr: 1 })
        .toArray();
      return documents.map((document) => toPersistentEvent<E>(document, this._serializer));
    } catch (e) {
      this.fail('read', e);
    }
  }

  async highestSeq(persistenceId: string): Promise<number> {
    const { database } = await this.ensureOpen();
    try {
      return await this.readHead(database, persistenceId);
    } catch (e) {
      this.fail('highestSeq', e);
    }
  }

  async delete(persistenceId: string, toSeq: number): Promise<void> {
    const { database } = await this.ensureOpen();
    try {
      await this.eventDocuments(database).deleteMany({ persistenceId, sequenceNr: { $lte: toSeq } });
      // Record the high-water mark so `highestSeq` and the append concurrency
      // check don't rewind once the highest events are compacted away.  `$max`
      // is the monotonic update — it writes only when the new value is greater,
      // which is exactly `GREATEST` in the SQL dialects.
      await this.meta(database).updateOne(
        { _id: persistenceId },
        { $max: { deletedTo: toSeq } },
        { upsert: true },
      );
    } catch (e) {
      this.fail('delete', e);
    }
  }

  async persistenceIds(): Promise<string[]> {
    const { database } = await this.ensureOpen();
    try {
      return (await this.eventDocuments(database).distinct('persistenceId')) as string[];
    } catch (e) {
      this.fail('persistenceIds', e);
    }
  }

  /* --------------------------- internals -------------------------------- */

  /**
   * The events collection.  Not named `events`: `Journal` declares an optional
   * `events?: JournalEventBus` field, and a method of that name would shadow it.
   */
  private eventDocuments(database: MongoDatabaseLike): MongoCollectionLike<EventDocument> {
    return database.collection<EventDocument>(this.eventsName);
  }

  private meta(database: MongoDatabaseLike): MongoCollectionLike<MetaDocument> {
    return database.collection<MetaDocument>(this.metaName);
  }

  /** Highest sequence number ever written — the events head or the compaction mark. */
  private async readHead(database: MongoDatabaseLike, persistenceId: string): Promise<number> {
    const [head] = await this.eventDocuments(database)
      .find({ persistenceId })
      .sort({ sequenceNr: -1 })
      .limit(1)
      .toArray();
    const mark = await this.meta(database).findOne({ _id: persistenceId });
    return Math.max(Number(head?.sequenceNr ?? 0), Number(mark?.deletedTo ?? 0));
  }

  /**
   * Open the store and hand the query layer the collection it needs — the one
   * seam `MongoQuery` needs into an otherwise private surface.
   */
  async openForQuery(): Promise<{ readonly events: MongoCollectionLike<EventDocument> }> {
    const { database } = await this.ensureOpen();
    return { events: this.eventDocuments(database) };
  }
}

/** Shared row mapping — also used by `MongoQuery`. */
export function toPersistentEvent<E>(document: {
  persistenceId: string;
  sequenceNr: number | unknown;
  payload: string;
  tags?: ReadonlyArray<string>;
  timestamp: number | unknown;
}, serializer?: Serializer): PersistentEvent<E> {
  return {
    persistenceId: document.persistenceId,
    sequenceNr: Number(document.sequenceNr),
    event: decodePayload(document.payload, serializer) as E,
    timestamp: Number(document.timestamp),
    // An absent or empty tag array means "untagged", matching every other
    // backend, rather than an empty list.
    tags: document.tags && document.tags.length > 0 ? [...document.tags] : undefined,
  };
}
