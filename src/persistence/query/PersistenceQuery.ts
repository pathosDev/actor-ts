import type { PersistentEvent } from '../JournalTypes.js';

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
 * **Pull-only.**  The first iteration polls.  Push-based subscribe
 * (via the system's `EventStream`) is intentionally deferred — see
 * issue #36 / the roadmap plan.
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
   * Snapshot of every persistence id known to the journal.  Resolves
   * once.  Useful for fan-out projections that subscribe to one
   * stream per id; pair with `eventsByPersistenceId` for the
   * continuous read.
   */
  currentPersistenceIds(): Promise<string[]>;
}

/**
 * Tunables for a live query.  The defaults are deliberately
 * conservative — projections are I/O-bound, not latency-critical.
 */
export interface LiveQueryOptions {
  /** Poll interval in ms.  Default: `1_000` (1 second). */
  readonly pollIntervalMs?: number;
  /** Max events to buffer per poll.  Default: `100`. */
  readonly batchSize?: number;
  /**
   * Optional clock — useful for tests that want to control
   * time-based offset progression.  Defaults to `Date.now`.
   */
  readonly clock?: () => number;
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
export interface Offset {
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
}

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
export interface TaggedEvent<E = unknown> {
  readonly event: PersistentEvent<E>;
  readonly offset: Offset;
}

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
export interface TagFilterSpec {
  readonly all?: ReadonlyArray<string>;
  readonly any?: ReadonlyArray<string>;
  readonly not?: ReadonlyArray<string>;
}

/**
 * Normalise a {@link TagFilter} into the canonical {@link TagFilterSpec}
 * form.  A bare string `t` becomes `{ all: [t] }`; an object is
 * shallow-copied so callers can't mutate it after the fact.
 */
export function normalizeTagFilter(filter: TagFilter): TagFilterSpec {
  if (typeof filter === 'string') return { all: [filter] };
  return {
    all: filter.all,
    any: filter.any,
    not: filter.not,
  };
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
    for (const t of filter.all) {
      if (!tags.includes(t)) return false;
    }
  }
  if (filter.any !== undefined) {
    if (filter.any.length === 0) return false; // ∃ over ∅ ≡ false
    let anyMatch = false;
    for (const t of filter.any) {
      if (tags.includes(t)) { anyMatch = true; break; }
    }
    if (!anyMatch) return false;
  }
  if (filter.not && filter.not.length > 0) {
    for (const t of filter.not) {
      if (tags.includes(t)) return false;
    }
  }
  return true;
}
