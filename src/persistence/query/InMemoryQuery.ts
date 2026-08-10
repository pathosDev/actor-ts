import { persistenceIdPage } from '../Journal.js';
import type { Journal } from '../Journal.js';
import type { JournalEventBus } from '../JournalEventBus.js';
import type { PersistentEvent } from '../JournalTypes.js';
import {
  eventMatchesTagFilter,
  normalizeTagFilter,
  offsetCompare,
  offsetGreater,
  offsetOfEvent,
  defaultPersistenceIdPageSize,
  resolvePageSize,
  type LiveQueryOptions,
  type Offset,
  type PaginationOptions,
  type PersistenceQuery,
  type TagFilter,
  type TagFilterSpec,
  type TaggedEvent,
} from './PersistenceQuery.js';

/** Reads one ascending page of ids after a cursor — see `readPersistenceIdPage`. */
type PersistenceIdPageReader = (
  afterPersistenceId: string | undefined,
  limit: number,
) => Promise<string[]>;

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
 * `JournalEventBus` (`journal.events`), the live queries — `eventsByX`
 * and `allPersistenceIds` — subscribe to it for sub-poll-interval
 * delivery.  The polling loop stays as a fallback for cross-process
 * journals (e.g. Cassandra) where in-process notifications can't
 * reach every subscriber.
 *
 * **Id pagination (#156).**  Unlike the tag path, the paginated id
 * walk is *not* overridden per backend: every page goes through
 * {@link InMemoryQuery.readPersistenceIdPage}, which forwards to
 * `Journal.persistenceIdsPaginated` when the backend has a sorted key
 * over ids and cuts the page out of the full list when it does not.
 * Putting the seam on the journal rather than the query keeps the four
 * query classes identical here, and — since they all inherit from this
 * one — is also what makes the feature arrive on every backend at once.
 */
export class InMemoryQuery implements PersistenceQuery {
  constructor(protected readonly journal: Journal) {}

  /* ------------------------------ by persistenceId -------------------------------- */

  async currentEventsByPersistenceId<E>(
    persistenceId: string, fromSeq: number, toSeq?: number,
  ): Promise<PersistentEvent<E>[]> {
    return this.journal.read<E>(persistenceId, fromSeq, toSeq);
  }

  eventsByPersistenceId<E>(
    persistenceId: string, fromSeq: number, options: LiveQueryOptions = {},
  ): AsyncIterable<PersistentEvent<E>> {
    const journal = this.journal;
    const bus = journal.events;
    if (bus) {
      return pushStreamByPersistenceId<E>(journal, persistenceId, fromSeq, bus);
    }
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    return liveStream<PersistentEvent<E>>(pollIntervalMs, async (lastEmitted) => {
      const fromInclusive = lastEmitted ? lastEmitted.sequenceNr + 1 : fromSeq;
      const events = await journal.read<E>(persistenceId, fromInclusive);
      return events;
    });
  }

  /* ------------------------------ by tag -------------------------------- */

  async currentEventsByTag<E>(
    filter: TagFilter, fromOffset: Offset,
  ): Promise<TaggedEvent<E>[]> {
    const spec = normalizeTagFilter(filter);
    const out: TaggedEvent<E>[] = [];
    const persistenceIds = await this.journal.persistenceIds();
    for (const persistenceId of persistenceIds) {
      const events = await this.journal.read<E>(persistenceId, 1);
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

  /* ----------------------------- persistenceIds ----------------------------------- */

  async currentPersistenceIds(): Promise<string[]> {
    // Deliberately *not* re-expressed on top of the paginated walk: that
    // would trade one round-trip for ⌈n / pageSize⌉ and re-sort a list the
    // caller asked for as-is.  The two methods answer different questions.
    return this.journal.persistenceIds();
  }

  async *currentPersistenceIdsPaginated(
    options: PaginationOptions = {},
  ): AsyncIterable<string> {
    const pageSize = resolvePageSize(options.pageSize);
    let afterPersistenceId = options.afterPersistenceId;
    for (;;) {
      const page = await this.readPersistenceIdPage(afterPersistenceId, pageSize);
      yield* page;
      // A short page is the journal saying "that was the last of them".  A
      // full one may or may not be, so it costs one more (empty) round-trip.
      if (page.length < pageSize) return;
      afterPersistenceId = page[page.length - 1];
    }
  }

  allPersistenceIds(options: LiveQueryOptions = {}): AsyncIterable<string> {
    const readPage: PersistenceIdPageReader = (afterPersistenceId, limit) =>
      this.readPersistenceIdPage(afterPersistenceId, limit);
    const bus = this.journal.events;
    if (bus) {
      return pushStreamOfPersistenceIds(readPage, defaultPersistenceIdPageSize, bus);
    }
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    return pollStreamOfPersistenceIds(readPage, defaultPersistenceIdPageSize, pollIntervalMs);
  }

  /**
   * One page of ids, pushed down to the journal when it can do it and cut out
   * of the full list when it cannot.
   *
   * `protected` so a backend subclass that overrides the *query* side (the way
   * `SqliteQuery` overrides the tag path) has one place to redirect, rather
   * than having to re-implement both public id methods to change where a page
   * comes from.
   */
  protected async readPersistenceIdPage(
    afterPersistenceId: string | undefined,
    limit: number,
  ): Promise<string[]> {
    const paginated = this.journal.persistenceIdsPaginated;
    if (paginated) return paginated.call(this.journal, afterPersistenceId, limit);
    return persistenceIdPage(await this.journal.persistenceIds(), afterPersistenceId, limit);
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
function pushStreamByPersistenceId<E>(
  journal: Journal, persistenceId: string, fromSeq: number, bus: JournalEventBus,
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
          const resolveNext = pendingResolve;
          pendingResolve = null;
          resolveNext({ value: ev, done: false });
        } else {
          queue.push(ev);
        }
      };

      const onPublish = (ev: PersistentEvent<unknown>): void => {
        if (ev.persistenceId !== persistenceId) return;
        if (ev.sequenceNr < fromSeq) return; // historical, irrelevant
        emit(ev as PersistentEvent<E>);
      };
      const unsubscribe = bus.subscribe(onPublish);

      // Catch-up read happens off-mainline — we kick it asynchronously
      // and let any bus events that arrived in the meantime queue.
      void journal.read<E>(persistenceId, fromSeq).then((events) => {
        for (const ev of events) emit(ev);
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('pushStreamByPersistenceId: catch-up read failed', err);
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
            const resolveNext = pendingResolve;
            pendingResolve = null;
            resolveNext({ value: undefined, done: true });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

/**
 * Push-driven stream by tag-filter.  Same shape as `pushStreamByPersistenceId`
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
          const resolveNext = pendingResolve;
          pendingResolve = null;
          resolveNext({ value: te, done: false });
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
            const resolveNext = pendingResolve;
            pendingResolve = null;
            resolveNext({ value: undefined, done: true });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

/**
 * Push-driven stream of persistence ids.  Same subscribe-then-catch-up dance
 * as `pushStreamByPersistenceId`, and for the same reason: an id whose first
 * event lands while the sweep is running has to arrive through the bus, and
 * that only works if the subscription predates the sweep.
 *
 * Dedup is the `emitted` set rather than a cursor, because the bus hands ids
 * back in *append* order while the sweep walks them in *sorted* order — there
 * is no single scalar that both are monotonic in.
 */
function pushStreamOfPersistenceIds(
  readPage: PersistenceIdPageReader, pageSize: number, bus: JournalEventBus,
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      const queue: string[] = [];
      let pendingResolve: ((v: IteratorResult<string>) => void) | null = null;
      let cancelled = false;
      const emitted = new Set<string>();

      const emit = (persistenceId: string): void => {
        if (cancelled) return;
        if (emitted.has(persistenceId)) return;
        emitted.add(persistenceId);
        if (pendingResolve) {
          const resolveNext = pendingResolve;
          pendingResolve = null;
          resolveNext({ value: persistenceId, done: false });
        } else {
          queue.push(persistenceId);
        }
      };

      const onPublish = (ev: PersistentEvent<unknown>): void => { emit(ev.persistenceId); };
      const unsubscribe = bus.subscribe(onPublish);

      // Catch-up sweep off-mainline: bus events arriving while it runs queue
      // up behind the `emitted` guard instead of being lost or duplicated.
      void (async (): Promise<void> => {
        let afterPersistenceId: string | undefined;
        while (!cancelled) {
          const page = await readPage(afterPersistenceId, pageSize);
          for (const persistenceId of page) emit(persistenceId);
          if (page.length < pageSize) return;
          afterPersistenceId = page[page.length - 1];
        }
      })().catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('pushStreamOfPersistenceIds: catch-up read failed', err);
      });

      return {
        next(): Promise<IteratorResult<string>> {
          if (cancelled) return Promise.resolve({ value: undefined, done: true });
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          return new Promise<IteratorResult<string>>((resolve) => {
            pendingResolve = resolve;
          });
        },
        return(): Promise<IteratorResult<string>> {
          cancelled = true;
          unsubscribe();
          if (pendingResolve) {
            const resolveNext = pendingResolve;
            pendingResolve = null;
            resolveNext({ value: undefined, done: true });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

/**
 * Polling fallback for `allPersistenceIds`, for journals with no event bus.
 *
 * Hand-rolled rather than built on {@link liveStream} for one reason that
 * matters at the scale this API exists for: `liveStream` collects a whole
 * fetch into an array and splices it into its buffer with `push(...next)`,
 * and a spread of a million ids is a `RangeError`, not a slow path.  Here the
 * sweep is consumed a page at a time, so the buffer never holds more than
 * `pageSize` entries however large the journal is.
 */
function pollStreamOfPersistenceIds(
  readPage: PersistenceIdPageReader, pageSize: number, pollIntervalMs: number,
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      const emitted = new Set<string>();
      let cancelled = false;
      let pendingTimer: { resolve: () => void; timer: ReturnType<typeof setTimeout> } | null = null;
      let buffer: string[] = [];
      let afterPersistenceId: string | undefined;
      /** False once the current sweep hit a short page; a wait restarts it. */
      let sweeping = true;

      function wait(ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
          const timer = setTimeout(() => { pendingTimer = null; resolve(); }, ms);
          pendingTimer = { resolve, timer };
        });
      }

      return {
        async next(): Promise<IteratorResult<string>> {
          while (!cancelled) {
            if (buffer.length > 0) return { value: buffer.shift()!, done: false };
            if (sweeping) {
              const page = await readPage(afterPersistenceId, pageSize);
              if (page.length > 0) afterPersistenceId = page[page.length - 1];
              if (page.length < pageSize) sweeping = false;
              for (const persistenceId of page) {
                if (emitted.has(persistenceId)) continue;
                emitted.add(persistenceId);
                buffer.push(persistenceId);
              }
              continue;
            }
            // Sweep exhausted: rewind the cursor and go round again after the
            // poll interval.  A new id can sort anywhere, so the next sweep
            // has to start from the beginning — `emitted` is what keeps that
            // from re-yielding everything.
            afterPersistenceId = undefined;
            sweeping = true;
            await wait(pollIntervalMs);
          }
          return { value: undefined, done: true };
        },
        async return(): Promise<IteratorResult<string>> {
          cancelled = true;
          if (pendingTimer) {
            clearTimeout(pendingTimer.timer);
            pendingTimer.resolve();
            pendingTimer = null;
          }
          buffer = [];
          return { value: undefined, done: true };
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
