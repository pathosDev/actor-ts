import type { Journal } from '../Journal.js';
import type { PersistentEvent } from '../JournalTypes.js';
import {
  offsetCompare,
  offsetGreater,
  offsetOfEvent,
  type LiveQueryOptions,
  type Offset,
  type PersistenceQuery,
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
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    return liveStream<PersistentEvent<E>>(pollIntervalMs, async (lastEmitted) => {
      const fromInclusive = lastEmitted ? lastEmitted.sequenceNr + 1 : fromSeq;
      const events = await journal.read<E>(pid, fromInclusive);
      return events;
    });
  }

  /* ------------------------------ by tag -------------------------------- */

  async currentEventsByTag<E>(
    tag: string, fromOffset: Offset,
  ): Promise<TaggedEvent<E>[]> {
    const out: TaggedEvent<E>[] = [];
    const pids = await this.journal.persistenceIds();
    for (const pid of pids) {
      const events = await this.journal.read<E>(pid, 1);
      for (const ev of events) {
        if (!ev.tags?.includes(tag)) continue;
        const offset = offsetOfEvent(ev);
        if (offsetCompare(offset, fromOffset) < 0) continue;
        out.push({ event: ev, offset });
      }
    }
    out.sort((a, b) => offsetCompare(a.offset, b.offset));
    return out;
  }

  eventsByTag<E>(
    tag: string, fromOffset: Offset, options: LiveQueryOptions = {},
  ): AsyncIterable<TaggedEvent<E>> {
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    const self = this;
    return liveStream<TaggedEvent<E>>(pollIntervalMs, async (lastEmitted) => {
      const cursor = lastEmitted ? lastEmitted.offset : fromOffset;
      // Strict ">" here so we don't redeliver the last emitted event;
      // currentEventsByTag uses ">=" because it's the first call.
      const all = await self.currentEventsByTag<E>(tag, cursor);
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
