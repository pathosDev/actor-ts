import type { Journal } from '../Journal.js';
import type { JournalEventBus } from '../JournalEventBus.js';
import type { PersistentEvent } from '../JournalTypes.js';
import {
  eventMatchesTagFilter,
  normalizeTagFilter,
  offsetCompare,
  offsetGreater,
  offsetOfEvent,
  type LiveQueryOptions,
  type Offset,
  type PersistenceQuery,
  type TagFilter,
  type TagFilterSpec,
  type TaggedEvent,
} from './PersistenceQuery.js';

/**
 * Reference query implementation that walks any `Journal` via its
 * public read API.  No backend-specific tag index — scans every
 * persistence id on each poll and filters in-process.  Correct for
 * any journal, but only fast for the in-memory one (where the scan
 * is just a Map walk).
 *
 * Backends that ship a "real" tag index (SQLite via the tags column,
 * Cassandra via secondary table) provide their own
 * {@link PersistenceQuery} implementation that overrides the tag
 * paths — see `SqliteQuery` and `CassandraQuery`.
 *
 * **Push delivery (#42).**  When the journal exposes a
 * `JournalEventBus` (`journal.events`), the live `eventsByX` queries
 * subscribe to it for sub-poll-interval delivery.  The polling loop
 * stays as a fallback for cross-process journals (e.g. Cassandra)
 * where in-process notifications can't reach every subscriber.
 */
export class InMemoryQuery implements PersistenceQuery {
  constructor(protected readonly journal: Journal) {}

  /* ------------------------------ by pid -------------------------------- */

  async currentEventsByPersistenceId<E>(
    pid: string, fromSeq: number, toSeq?: number,
  ): Promise<PersistentEvent<E>[]> {
    return this.journal.read<E>(pid, fromSeq, toSeq);
  }

  eventsByPersistenceId<E>(
    pid: string, fromSeq: number, options: LiveQueryOptions = {},
  ): AsyncIterable<PersistentEvent<E>> {
    const journal = this.journal;
    const bus = journal.events;
    if (bus) {
      return pushStreamByPid<E>(journal, pid, fromSeq, bus);
    }
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    return liveStream<PersistentEvent<E>>(pollIntervalMs, async (lastEmitted) => {
      const fromInclusive = lastEmitted ? lastEmitted.sequenceNr + 1 : fromSeq;
      const events = await journal.read<E>(pid, fromInclusive);
      return events;
    });
  }

  /* ------------------------------ by tag -------------------------------- */

  async currentEventsByTag<E>(
    filter: TagFilter, fromOffset: Offset,
  ): Promise<TaggedEvent<E>[]> {
    const spec = normalizeTagFilter(filter);
    const out: TaggedEvent<E>[] = [];
    const pids = await this.journal.persistenceIds();
    for (const pid of pids) {
      const events = await this.journal.read<E>(pid, 1);
      for (const ev of events) {
        if (!eventMatchesTagFilter(ev.tags, spec)) continue;
        const offset = offsetOfEvent(ev);
        if (offsetCompare(offset, fromOffset) < 0) continue;
        out.push({ event: ev, offset });
      }
    }
    out.sort((a, b) => offsetCompare(a.offset, b.offset));
    return out;
  }

  eventsByTag<E>(
    filter: TagFilter, fromOffset: Offset, options: LiveQueryOptions = {},
  ): AsyncIterable<TaggedEvent<E>> {
    const spec = normalizeTagFilter(filter);
    const bus = this.journal.events;
    if (bus) {
      return pushStreamByTag<E>(this, spec, fromOffset, bus);
    }
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    const self = this;
    return liveStream<TaggedEvent<E>>(pollIntervalMs, async (lastEmitted) => {
      const cursor = lastEmitted ? lastEmitted.offset : fromOffset;
      // Strict ">" here so we don't redeliver the last emitted event;
      // currentEventsByTag uses ">=" because it's the first call.
      const all = await self.currentEventsByTag<E>(spec, cursor);
      return lastEmitted
        ? all.filter((te) => offsetGreater(te.offset, cursor))
        : all;
    });
  }

  /* ----------------------------- pids ----------------------------------- */

  async currentPersistenceIds(): Promise<string[]> {
    return this.journal.persistenceIds();
  }
}

/* ============================== push streams ============================== */

/**
 * Push-driven stream by persistenceId.  Subscribes to the bus FIRST
 * so events appended during the catch-up read aren't missed; then
 * does the catch-up read; then drains buffered bus events filtering
 * out any whose `sequenceNr` was already covered by the catch-up.
 *
 * This dance is what makes the contract "every event with seq >=
 * fromSeq, exactly once" hold in the face of concurrent appends.
 */
function pushStreamByPid<E>(
  journal: Journal, pid: string, fromSeq: number, bus: JournalEventBus,
): AsyncIterable<PersistentEvent<E>> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<PersistentEvent<E>> {
      const queue: PersistentEvent<E>[] = [];
      let pendingResolve: ((v: IteratorResult<PersistentEvent<E>>) => void) | null = null;
      let cancelled = false;
      let lastEmittedSeq = fromSeq - 1;

      const emit = (ev: PersistentEvent<E>): void => {
        if (cancelled) return;
        if (ev.sequenceNr <= lastEmittedSeq) return; // dedup vs. catch-up
        lastEmittedSeq = ev.sequenceNr;
        if (pendingResolve) {
          const r = pendingResolve;
          pendingResolve = null;
          r({ value: ev, done: false });
        } else {
          queue.push(ev);
        }
      };

      const onPublish = (ev: PersistentEvent<unknown>): void => {
        if (ev.persistenceId !== pid) return;
        if (ev.sequenceNr < fromSeq) return; // historical, irrelevant
        emit(ev as PersistentEvent<E>);
      };
      const unsubscribe = bus.subscribe(onPublish);

      // Catch-up read happens off-mainline — we kick it asynchronously
      // and let any bus events that arrived in the meantime queue.
      void journal.read<E>(pid, fromSeq).then((events) => {
        for (const ev of events) emit(ev);
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('pushStreamByPid: catch-up read failed', err);
      });

      return {
        next(): Promise<IteratorResult<PersistentEvent<E>>> {
          if (cancelled) return Promise.resolve({ value: undefined, done: true });
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          return new Promise<IteratorResult<PersistentEvent<E>>>((resolve) => {
            pendingResolve = resolve;
          });
        },
        return(): Promise<IteratorResult<PersistentEvent<E>>> {
          cancelled = true;
          unsubscribe();
          if (pendingResolve) {
            const r = pendingResolve;
            pendingResolve = null;
            r({ value: undefined, done: true });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

/**
 * Push-driven stream by tag-filter.  Same shape as `pushStreamByPid`
 * but dedup is on the composite `Offset` instead of a single sequence
 * number, and the catch-up scans every persistenceId for events
 * satisfying the filter.
 */
function pushStreamByTag<E>(
  query: InMemoryQuery, spec: TagFilterSpec, fromOffset: Offset, bus: JournalEventBus,
): AsyncIterable<TaggedEvent<E>> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<TaggedEvent<E>> {
      const queue: TaggedEvent<E>[] = [];
      let pendingResolve: ((v: IteratorResult<TaggedEvent<E>>) => void) | null = null;
      let cancelled = false;
      let lastEmittedOffset: Offset | null = null;

      const emit = (te: TaggedEvent<E>): void => {
        if (cancelled) return;
        // Dedup against the catch-up window.
        if (offsetCompare(te.offset, fromOffset) < 0) return;
        if (lastEmittedOffset && offsetCompare(te.offset, lastEmittedOffset) <= 0) return;
        lastEmittedOffset = te.offset;
        if (pendingResolve) {
          const r = pendingResolve;
          pendingResolve = null;
          r({ value: te, done: false });
        } else {
          queue.push(te);
        }
      };

      const onPublish = (ev: PersistentEvent<unknown>): void => {
        if (!eventMatchesTagFilter(ev.tags, spec)) return;
        emit({ event: ev as PersistentEvent<E>, offset: offsetOfEvent(ev) });
      };
      const unsubscribe = bus.subscribe(onPublish);

      void query.currentEventsByTag<E>(spec, fromOffset).then((all) => {
        for (const te of all) emit(te);
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('pushStreamByTag: catch-up read failed', err);
      });

      return {
        next(): Promise<IteratorResult<TaggedEvent<E>>> {
          if (cancelled) return Promise.resolve({ value: undefined, done: true });
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          return new Promise<IteratorResult<TaggedEvent<E>>>((resolve) => {
            pendingResolve = resolve;
          });
        },
        return(): Promise<IteratorResult<TaggedEvent<E>>> {
          cancelled = true;
          unsubscribe();
          if (pendingResolve) {
            const r = pendingResolve;
            pendingResolve = null;
            r({ value: undefined, done: true });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

/* ============================== poll fallback ============================== */

/**
 * Generic live-poll loop used by every query method.  `fetchSince`
 * is called with the last emitted item — initially `null`, then with
 * the item the previous batch ended on.  Implementations decide how
 * to translate that into a fresh batch (sequence-based vs offset-based).
 *
 * Cancellation: the consumer breaking out of `for await` triggers
 * `return()` on the iterator, which sets `cancelled = true` and
 * resolves the timer immediately so we exit the loop on the next
 * iteration.
 */
function liveStream<T>(
  pollIntervalMs: number,
  fetchSince: (lastEmitted: T | null) => Promise<T[]>,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let cancelled = false;
      let pendingTimer: { resolve: () => void; timer: ReturnType<typeof setTimeout> } | null = null;
      let buffer: T[] = [];
      let lastEmitted: T | null = null;

      async function pump(): Promise<void> {
        const next = await fetchSince(lastEmitted);
        if (next.length > 0) {
          buffer.push(...next);
          lastEmitted = next[next.length - 1]!;
        }
      }

      function wait(ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
          const timer = setTimeout(() => { pendingTimer = null; resolve(); }, ms);
          pendingTimer = { resolve, timer };
        });
      }

      return {
        async next(): Promise<IteratorResult<T>> {
          while (!cancelled) {
            if (buffer.length > 0) {
              const value = buffer.shift()!;
              return { value, done: false };
            }
            await pump();
            if (buffer.length === 0) await wait(pollIntervalMs);
          }
          return { value: undefined, done: true };
        },
        async return(): Promise<IteratorResult<T>> {
          cancelled = true;
          if (pendingTimer) {
            clearTimeout(pendingTimer.timer);
            pendingTimer.resolve();
            pendingTimer = null;
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}
