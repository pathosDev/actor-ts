import type { PersistentEvent } from '../JournalTypes.js';
import { assertValidFilterTags } from '../storage/TagValidator.js';

/**
 * Read-side query layer for the journal.  Designed for projections —
 * processes that materialise a read-model by sweeping events out of
 * the write-side journal and feeding them into a user handler.
 *
 * Two flavours of query:
 *
 *   - **`current*`** — one-shot snapshot of events currently in the
 *     journal at call time.  Resolves to a Promise.  Use this for a
 *     batch backfill or a self-contained report.
 *   - **`events*`** — continuous live stream.  Polls the journal at
 *     `pollIntervalMs` for new events.  Yields an `AsyncIterable` so
 *     consumers can `for await (const ev of stream) ...`.  The stream
 *     stays open until the consumer breaks out of the loop or calls
 *     `return()` on the iterator.
 *
 * **Delivery guarantees:** at-least-once.  A projection that fails
 * mid-event must accept that the event will be redelivered after
 * restart.  Handlers therefore have to be idempotent.
 *
 * **Push where the journal can push (#42).**  A live query subscribes
 * to `journal.events` when the journal exposes one, and polls at
 * `pollIntervalMs` when it does not.  So an in-process journal
 * delivers within a tick while a cross-process one (Cassandra,
 * Postgres) — where an in-process bus could not see another node's
 * writes anyway — keeps the polling loop.  Which of the two is in
 * play is invisible to the consumer: the iteration contract is the
 * same either way.
 */
export interface PersistenceQuery {
  /**
   * Live stream of every event for `persistenceId` whose
   * `sequenceNr >= fromSeq`.  Past events are emitted first
   * (chronological by `sequenceNr`), then new events as they are
   * appended.  The stream never completes on its own — break out of
   * the loop or call `return()` on the iterator to stop polling.
   */
  eventsByPersistenceId<E>(
    persistenceId: string,
    fromSeq: number,
    options?: LiveQueryOptions,
  ): AsyncIterable<PersistentEvent<E>>;

  /**
   * One-shot read of every event for `persistenceId` whose
   * `sequenceNr >= fromSeq` (and `<= toSeq` if given).  Resolves
   * once with the events known at call time.
   */
  currentEventsByPersistenceId<E>(
    persistenceId: string,
    fromSeq: number,
    toSeq?: number,
  ): Promise<PersistentEvent<E>[]>;

  /**
   * Live stream of every event matching `filter` whose offset is
   * `>= fromOffset`.  Yields events ordered by `(timestamp,
   * persistenceId, sequenceNr)`.  See {@link Offset} for offset
   * semantics — the stream emits the offset alongside the event so
   * the consumer can persist progress.
   *
   * `filter` accepts either a single tag string (back-compat shortcut
   * for `{ all: [tag] }`) or a {@link TagFilter} object that combines
   * `all` (intersect), `any` (union), and `not` (exclusion) operators.
   */
  eventsByTag<E>(
    filter: TagFilter,
    fromOffset: Offset,
    options?: LiveQueryOptions,
  ): AsyncIterable<TaggedEvent<E>>;

  /**
   * One-shot read of every event matching `filter` whose offset is
   * `>= fromOffset`.  See {@link TagFilter} for the operator semantics.
   */
  currentEventsByTag<E>(
    filter: TagFilter,
    fromOffset: Offset,
  ): Promise<TaggedEvent<E>[]>;

  /**
   * Snapshot of every persistence id known to the journal, as one
   * array.  Resolves once.
   *
   * Kept, and not deprecated: for a journal with a handful of ids this
   * is simply the convenient shape, and "small journal" is a permanent
   * case rather than a legacy one.  It is, however, the only method
   * here with no bound on what it materialises — at a million ids that
   * is a million strings in one allocation.  Past the point where the
   * array itself is a cost, use {@link currentPersistenceIdsPaginated},
   * which walks the same data one page at a time.
   */
  currentPersistenceIds(): Promise<string[]>;

  /**
   * Cursor-paginated snapshot of the persistence ids currently in the
   * journal, ascending, yielded one at a time.  Fetches `pageSize` ids
   * per round-trip, so peak memory is one page rather than the whole
   * set.  Completes when the journal is exhausted — unlike
   * {@link allPersistenceIds} it does not wait for new ids.
   *
   * **The cursor is a persistence id, not an opaque token.**  Resume a
   * partial walk by passing the last id you handled as
   * `afterPersistenceId`.  Encoding it would have bought per-backend
   * freedom that no backend here needs — every one of them enumerates
   * ids through an index keyed on the id itself — at the price of a
   * checkpoint no operator can read and no other process can
   * construct.
   */
  currentPersistenceIdsPaginated(options?: PaginationOptions): AsyncIterable<string>;

  /**
   * Live stream of every persistence id the journal has ever seen, plus
   * each new one as it first appears.  The stream never completes on
   * its own — break out of the loop or call `return()` on the iterator.
   *
   * This is the fan-out primitive: start a per-entity projection as its
   * entity shows up, instead of polling `currentPersistenceIds` and
   * diffing the result yourself.
   *
   * **Once per stream, not once per journal.**  A fresh subscription
   * re-emits every id, so a consumer that must not act twice across a
   * restart needs its own checkpoint — the same at-least-once posture
   * the event queries have.
   *
   * **Memory.**  "Once per stream" is enforced with an in-process set
   * of the ids emitted so far, so a stream over a journal with a
   * million ids holds a million strings for as long as it runs.  A
   * lexicographic watermark would be cheaper and wrong: ids are not
   * created in sorted order, so an id that sorts below the mark would
   * be skipped forever, and a fan-out projection that silently never
   * starts is the worst failure this API could have.  The catch-up
   * sweep is paged, so the peak is the set plus one page — and a
   * one-shot enumeration that needs no set at all is
   * {@link currentPersistenceIdsPaginated}.
   */
  allPersistenceIds(options?: LiveQueryOptions): AsyncIterable<string>;
}

/**
 * Tunables for a live query.  The defaults are deliberately
 * conservative — projections are I/O-bound, not latency-critical.
 */
export type LiveQueryOptions = {
  /** Poll interval in ms.  Default: `1_000` (1 second). */
  readonly pollIntervalMs?: number;
};

/** Tunables for a cursor-paginated one-shot query. */
export type PaginationOptions = {
  /** Ids fetched per round-trip.  Default: {@link defaultPersistenceIdPageSize}. */
  readonly pageSize?: number;
  /**
   * Resume after this persistence id, exclusive — the last id a
   * previous walk handled.  Omit to start at the first id.
   */
  readonly afterPersistenceId?: string;
};

/**
 * Ids per round-trip when the caller does not say.  Large enough that a
 * page walk is not round-trip-bound, small enough that a page is not
 * itself the allocation the pagination exists to avoid.
 */
export const defaultPersistenceIdPageSize = 256;

/**
 * Turn a caller-supplied page size into a usable positive integer.
 *
 * Not merely defensive.  A page size reaches SQL as a **literal**:
 * `SqlDialect.rowLimit` builds the trailing clause from the count
 * because T-SQL's `OFFSET … FETCH NEXT` is not one parameter but a
 * different clause shape, so there is no placeholder to bind.  Flooring
 * to an integer is therefore what keeps a caller's `pageSize` out of
 * the statement text as anything but a number.  The `>= 1` floor is the
 * second half: a zero-sized page ends no paging loop, it just spins.
 * `Infinity` — which the original design sketch suggested passing to
 * mean "no pagination" — falls back to the default rather than
 * producing `LIMIT Infinity`.
 */
export function resolvePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isFinite(pageSize)) {
    return defaultPersistenceIdPageSize;
  }
  return Math.max(1, Math.floor(pageSize));
}

/**
 * Cursor used by tag queries.  Composite by design so two events that
 * share a `timestamp` (which happens whenever a batch of events is
 * persisted in the same `Date.now()` tick) still have a deterministic
 * order — `(timestamp, persistenceId, sequenceNr)` is unique per event.
 *
 * Compare via {@link offsetGreaterOrEqual} / {@link offsetCompare} —
 * the tuple structure makes naive `>=` comparison wrong.
 */
export type Offset = {
  /** Wall-clock time of the event's persist call. */
  readonly timestamp: number;
  /**
   * Tiebreaker when two events share `timestamp`.  Set to the empty
   * string for the "from-the-beginning" sentinel; the comparator
   * treats `''` as "before any real persistence id".
   */
  readonly persistenceId: string;
  /** Tiebreaker within a persistence id when timestamps collide. */
  readonly sequenceNr: number;
};

/** Sentinel: read every event from the start of recorded history. */
export const offsetStart: Offset = {
  timestamp: 0,
  persistenceId: '',
  sequenceNr: 0,
};

export function offsetCompare(a: Offset, b: Offset): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.persistenceId !== b.persistenceId) {
    return a.persistenceId < b.persistenceId ? -1 : 1;
  }
  return a.sequenceNr - b.sequenceNr;
}

export function offsetGreaterOrEqual(a: Offset, b: Offset): boolean {
  return offsetCompare(a, b) >= 0;
}

export function offsetGreater(a: Offset, b: Offset): boolean {
  return offsetCompare(a, b) > 0;
}

/** Build an offset from an event — the event's "natural" position. */
export function offsetOfEvent<E>(ev: PersistentEvent<E>): Offset {
  return {
    timestamp: ev.timestamp,
    persistenceId: ev.persistenceId,
    sequenceNr: ev.sequenceNr,
  };
}

/**
 * Event paired with the {@link Offset} a consumer must persist to
 * resume after a crash.  See `eventsByTag`.
 */
export type TaggedEvent<E = unknown> = {
  readonly event: PersistentEvent<E>;
  readonly offset: Offset;
};

/**
 * Tag-filter spec for `eventsByTag` / `currentEventsByTag`.  A bare
 * string is shorthand for `{ all: [tag] }`; the object form combines
 * three operators that all apply to the same query:
 *
 *   - `all`  — intersection: every listed tag must appear on the event.
 *   - `any`  — union:        at least one listed tag must appear.
 *   - `not`  — exclusion:    no listed tag may appear on the event.
 *
 * **Empty-list semantics (∀ / ∃ / ∄ over the given list):**
 *
 *   - `all: []` and `not: []` impose no constraint (vacuously true).
 *   - `any: []` matches **nothing** (no event has a tag in the empty
 *     set) — the only "footgun" worth calling out.
 *
 * Operators compose by AND: `{ all: ['type:Order'], not: ['archived'] }`
 * matches order events that are not archived.  Backends that ship a
 * tag index (SQLite, Cassandra) push as much of the filter as they
 * can into the storage layer and JS-refine the rest; the InMemory
 * reference does the whole match in JS.
 */
export type TagFilter = string | TagFilterSpec;

/**
 * Object form of {@link TagFilter}.  Each operator is optional; an
 * empty `{}` matches every event.  See `TagFilter` for the empty-list
 * semantics.
 */
export type TagFilterSpec = {
  readonly all?: ReadonlyArray<string>;
  readonly any?: ReadonlyArray<string>;
  readonly not?: ReadonlyArray<string>;
};

/**
 * Normalise a {@link TagFilter} into the canonical {@link TagFilterSpec}
 * form.  A bare string `t` becomes `{ all: [t] }`; an object is
 * shallow-copied so callers can't mutate it after the fact.
 *
 * **And validated** (#738).  This is the one function every backend's tag
 * query routes through — `InMemoryQuery` normalises in both `eventsByTag` and
 * `currentEventsByTag`, and `MongoQuery`, `SqliteQuery`, `CassandraQuery` and
 * `RelationalQuery` each override only `currentEventsByTag` and normalise
 * there — so it is the read side's equivalent of the journal boundary that
 * `assertValidTags` guards on the write side.  Putting the check here rather
 * than in `MongoQuery` is what makes it hold for a backend added later.
 *
 * What it enforces is deliberately narrower than the write-side rules;
 * {@link assertValidFilterTags} carries the reasoning for each rule that does
 * and does not transfer.  A bare string goes through the same check, since it
 * is shorthand for `all[0]` and would otherwise be a way around the length
 * bound.
 */
export function normalizeTagFilter(filter: TagFilter): TagFilterSpec {
  if (typeof filter === 'string') {
    assertValidFilterTags('all', [filter]);
    return { all: [filter] };
  }
  if (filter === null || typeof filter !== 'object') {
    // Erased-type hole of its own: a filter that is neither a string nor an
    // object reads `.all` / `.any` / `.not` as `undefined`, which is the spec
    // that matches *every* event — so a malformed filter would widen a query
    // rather than fail it.
    throw new Error(
      `invalid tag filter: expected a tag string or a { all, any, not } object, got ${
        filter === null ? 'null' : typeof filter}`,
    );
  }
  assertValidFilterTags('all', filter.all);
  assertValidFilterTags('any', filter.any);
  assertValidFilterTags('not', filter.not);
  return {
    all: filter.all,
    any: filter.any,
    not: filter.not,
  };
}

/**
 * A stable string key identifying a {@link TagFilter}, for use as a projection
 * cursor key.
 *
 * A bare string maps to **itself**, unchanged — that matters more than it
 * looks: the by-tag projection uses this as its `OffsetStore` key, so any other
 * mapping would orphan every cursor already persisted and silently replay each
 * deployed projection from the beginning.
 *
 * Object filters get a canonical form with each operator's tags sorted, so two
 * filters that mean the same thing share one cursor however they were written.
 * Not a hash: a readable key is worth more than a short one in an offset table
 * an operator has to inspect.
 */
export function tagFilterCursorKey(filter: TagFilter): string {
  if (typeof filter === 'string') return filter;
  const operator = (name: string, tags: ReadonlyArray<string> | undefined): string =>
    tags !== undefined && tags.length > 0 ? `${name}(${[...tags].sort().join(',')})` : '';
  const parts = [
    operator('all', filter.all),
    operator('any', filter.any),
    operator('not', filter.not),
  ].filter(part => part.length > 0);
  // `{}` matches everything; give it a name rather than an empty key, which
  // would collide with a projection whose tag was the empty string.
  return parts.length > 0 ? parts.join('+') : 'all-events';
}

/**
 * Test whether `eventTags` satisfies `filter`.  Used by every
 * `PersistenceQuery` implementation as the in-memory refinement step
 * after the storage layer's coarse pre-filter.  Empty `all` / `not`
 * are no-ops; empty `any` matches nothing (see {@link TagFilter}).
 */
export function eventMatchesTagFilter(
  eventTags: ReadonlyArray<string> | undefined,
  filter: TagFilterSpec,
): boolean {
  const tags = eventTags ?? [];
  if (filter.all && filter.all.length > 0) {
    for (const tag of filter.all) {
      if (!tags.includes(tag)) return false;
    }
  }
  if (filter.any !== undefined) {
    if (filter.any.length === 0) return false; // ∃ over ∅ ≡ false
    let anyMatch = false;
    for (const tag of filter.any) {
      if (tags.includes(tag)) { anyMatch = true; break; }
    }
    if (!anyMatch) return false;
  }
  if (filter.not && filter.not.length > 0) {
    for (const tag of filter.not) {
      if (tags.includes(tag)) return false;
    }
  }
  return true;
}

/**
 * Turn pre-filtered storage rows into ordered `TaggedEvent`s.
 *
 * Every indexed tag query has the same tail: the storage layer can only
 * pre-filter on one tag and a coarse `timestamp >= …` bound, so the caller
 * refines each row in JS, drops rows that fall before the requested offset —
 * a per-row compare is unavoidable, because `Offset` breaks timestamp ties on
 * `(persistenceId, sequenceNr)` and the coarse SQL bound cannot — and sorts
 * the survivors.  That tail is shared here; the row *shape* is not, since
 * Cassandra returns a CQL set of tags and already-wide numbers while SQLite
 * returns a CSV string.
 *
 * `mapMatching` therefore does the backend-specific work and returns `null`
 * for a row the full filter rejects.  Keeping the reject decision inside the
 * callback is what lets a backend skip parsing the payload of a row it is
 * about to discard.
 */
export function refineTaggedRows<Row, E>(
  rows: ReadonlyArray<Row>,
  fromOffset: Offset,
  mapMatching: (row: Row) => PersistentEvent<E> | null,
): TaggedEvent<E>[] {
  const refined: TaggedEvent<E>[] = [];
  for (const row of rows) {
    const event = mapMatching(row);
    if (event === null) continue;
    const offset = offsetOfEvent(event);
    if (offsetCompare(offset, fromOffset) < 0) continue;
    refined.push({ event, offset });
  }
  refined.sort((a, b) => offsetCompare(a.offset, b.offset));
  return refined;
}
