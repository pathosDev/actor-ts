import { JournalError } from '../JournalTypes.js';
import type { MongoJournal } from '../journals/MongoJournal.js';
import { decodePayload } from '../storage/PayloadCodec.js';
import { InMemoryQuery } from './InMemoryQuery.js';
import {
  eventMatchesTagFilter,
  normalizeTagFilter,
  refineTaggedRows,
  type Offset,
  type TagFilter,
  type TagFilterSpec,
  type TaggedEvent,
} from './PersistenceQuery.js';

/** The subset of an event document this query reads back. */
type TaggedEventDocument = {
  persistenceId: string;
  sequenceNr: number;
  payload: string;
  tags?: ReadonlyArray<string>;
  timestamp: number;
};

/**
 * MongoDB query.  Inherits the per-persistence-id read path from
 * {@link InMemoryQuery} (which delegates straight to `Journal.read`) and
 * overrides the tag path with an indexed lookup.
 *
 * **Index shape.**  `MongoJournal` maintains a compound index on
 * `{ tags: 1, timestamp: 1 }`.  Because `tags` is an array, MongoDB indexes it
 * as a *multikey* index — one entry per tag per event — so a query on one tag
 * plus a `timestamp` lower bound walks a contiguous range instead of scanning
 * the collection.  That is the same shape as the SQLite/Cassandra tag tables,
 * without needing a second collection to keep in sync.
 *
 * Multi-tag operators are then refined in JS, exactly as the other indexed
 * backends do: the server pre-filters on one tag, and `all` past the first tag,
 * cross-tag `any`, and `not` are applied per row.  Pushing `$all` / `$nin` down
 * would look tidier but only the leading field of a multikey index is selective,
 * so it buys nothing and loses the shared refinement path.
 */
export class MongoQuery extends InMemoryQuery {
  constructor(private readonly mongo: MongoJournal) {
    super(mongo);
  }

  override async currentEventsByTag<E>(
    filter: TagFilter, fromOffset: Offset,
  ): Promise<TaggedEvent<E>[]> {
    const spec = normalizeTagFilter(filter);
    const allTags = spec.all ?? [];
    const anyTags = spec.any ?? [];

    // Strategy 1: pre-filter on the first `all` tag, refine the rest in JS.
    if (allTags.length > 0) {
      return this.fetchAndRefine<E>({ tags: allTags[0]! }, spec, fromOffset);
    }

    // Strategy 2: any-only — one `$in` over the tag set.  The multikey index
    // serves it directly, and an event carrying two of the listed tags still
    // comes back once, so no dedupe is needed (unlike the Cassandra path, which
    // scans one partition per tag).
    if (anyTags.length > 0) {
      return this.fetchAndRefine<E>({ tags: { $in: anyTags } }, spec, fromOffset);
    }

    // Strategy 3: only `not` (or a fully empty filter) — nothing to pre-filter
    // on, so fall back to the journal-walking scan in the base class.  The full
    // filter still goes through so the not-clause is applied.
    return super.currentEventsByTag<E>(spec, fromOffset);
  }

  /** Run the pre-filter, then apply the full filter and the offset in JS. */
  private async fetchAndRefine<E>(
    tagFilter: Record<string, unknown>,
    spec: TagFilterSpec,
    fromOffset: Offset,
  ): Promise<TaggedEvent<E>[]> {
    let documents: TaggedEventDocument[];
    try {
      const { events } = await this.mongo.openForQuery();
      documents = await events
        // The timestamp bound is the index's second field, so it narrows the
        // range walk rather than filtering after the fact.
        .find({ ...tagFilter, timestamp: { $gte: fromOffset.timestamp } })
        .sort({ timestamp: 1, persistenceId: 1, sequenceNr: 1 })
        .toArray() as unknown as TaggedEventDocument[];
    } catch (e) {
      throw new JournalError(`MongoQuery.currentEventsByTag failed: ${(e as Error).message}`, e);
    }
    return refineTaggedRows<TaggedEventDocument, E>(documents, fromOffset, (document) => {
      // An absent or empty array means "untagged", not a zero-length tag list.
      const tags = document.tags && document.tags.length > 0 ? [...document.tags] : undefined;
      if (!eventMatchesTagFilter(tags, spec)) return null;
      return {
        persistenceId: document.persistenceId,
        sequenceNr: Number(document.sequenceNr),
        event: decodePayload(document.payload) as E,
        timestamp: Number(document.timestamp),
        tags,
      };
    });
  }
}
