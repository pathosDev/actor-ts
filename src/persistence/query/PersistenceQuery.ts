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
   * Live stream of every event tagged with `tag` whose offset is
   * `>= fromOffset`.  Yields events ordered by `(timestamp,
   * persistenceId, sequenceNr)`.  See {@link Offset} for offset
   * semantics — the stream emits the offset alongside the event so
   * the consumer can persist progress.
   */
  eventsByTag<E>(
    tag: string,
    fromOffset: Offset,
    options?: LiveQueryOptions,
  ): AsyncIterable<TaggedEvent<E>>;

  /**
   * One-shot read of every event tagged with `tag` whose offset is
   * `>= fromOffset`.
   */
  currentEventsByTag<E>(
    tag: string,
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
