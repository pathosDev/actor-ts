/**
 * The two live-stream shapes of `InMemoryQuery` that the push-path cases in
 * `TagLookbackWindow.test.ts` do not reach.
 *
 *   - **The poll path.**  `eventsByTag` over a journal with no event bus is
 *     what every production backend takes — relational, Mongo, Cassandra,
 *     DynamoDB — and the #957 lookback window has to work there exactly as it
 *     does on the push path.  The journal here is an `InMemoryJournal` behind a
 *     decorator that hides its bus and can hold one event back from reads, so
 *     "committed after the stream passed its stamp" is a step the test takes.
 *   - **A failed catch-up read.**  The push streams hold bus events back while
 *     the catch-up read runs; a read that rejects must release them as one
 *     that resolves does, or the stream stalls for good.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { setSystemTime } from 'bun:test';
import type { Journal } from '../../../src/persistence/Journal.js';
import type { PersistentEvent } from '../../../src/persistence/JournalTypes.js';
import { InMemoryJournal } from '../../../src/persistence/journals/InMemoryJournal.js';
import { InMemoryQuery } from '../../../src/persistence/query/InMemoryQuery.js';
import { offsetStart, type TaggedEvent } from '../../../src/persistence/query/PersistenceQuery.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * An `InMemoryJournal` seen the way a cross-process backend is: no `events`
 * bus, so the query layer polls.  `hide` keeps one event out of every read
 * until `reveal` — the shape of a write whose commit lags its stamp.
 */
function pollOnlyJournal(inner: InMemoryJournal): Journal & { hide(persistenceId: string, sequenceNr: number): void; reveal(): void } {
  let hidden: { persistenceId: string; sequenceNr: number } | null = null;
  return {
    append: (persistenceId, entries, expectedSeq) => inner.append(persistenceId, entries, expectedSeq),
    read: async <E>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> => {
      const events = await inner.read<E>(persistenceId, fromSeq, toSeq);
      return events.filter((event) => hidden === null
        || event.persistenceId !== hidden.persistenceId || event.sequenceNr !== hidden.sequenceNr);
    },
    highestSeq: (persistenceId) => inner.highestSeq(persistenceId),
    delete: (persistenceId, toSeq) => inner.delete(persistenceId, toSeq),
    persistenceIds: () => inner.persistenceIds(),
    hide(persistenceId: string, sequenceNr: number): void { hidden = { persistenceId, sequenceNr }; },
    reveal(): void { hidden = null; },
  };
}

async function nextEventOf(iterator: AsyncIterator<TaggedEvent<string>>): Promise<string> {
  const next = await iterator.next();
  if (next.done) throw new Error('the stream ended');
  return `${next.value.event.persistenceId}#${next.value.event.sequenceNr}`;
}

afterEach(() => {
  setSystemTime();
});

describe('eventsByTag over a journal with no event bus', () => {
  test('polls: events from before and after iteration starts arrive, and a late commit inside the window arrives once', async () => {
    const inner = new InMemoryJournal();
    const journal = pollOnlyJournal(inner);
    expect(journal.events).toBeUndefined();

    setSystemTime(new Date(100_000));
    await journal.append('a', [{ event: 'a1', tags: ['t'] }], 0);
    // Stamped before `b#1`, committed after the stream has delivered it.
    setSystemTime(new Date(110_000));
    await journal.append('slow', [{ event: 'slow1', tags: ['t'] }], 0);
    journal.hide('slow', 1);

    const iterator = new InMemoryQuery(journal)
      .eventsByTag<string>('t', offsetStart, { pollIntervalMs: 10, lookbackWindowMs: 60_000 })[Symbol.asyncIterator]();
    try {
      expect(await nextEventOf(iterator)).toBe('a#1');

      setSystemTime(new Date(120_000));
      await journal.append('b', [{ event: 'b1', tags: ['t'] }], 0);
      expect(await nextEventOf(iterator)).toBe('b#1');

      journal.reveal();
      expect(await nextEventOf(iterator)).toBe('slow#1');

      setSystemTime(new Date(130_000));
      await journal.append('c', [{ event: 'c1', tags: ['t'] }], 0);
      // Not `slow#1` again, though every poll re-reads the window it lies in.
      expect(await nextEventOf(iterator)).toBe('c#1');
    } finally {
      await iterator.return?.();
    }
  });

  test('a late commit further behind than the window is not re-read: the window bounds the poll path', async () => {
    const inner = new InMemoryJournal();
    const journal = pollOnlyJournal(inner);

    setSystemTime(new Date(100_000));
    await journal.append('slow', [{ event: 'slow1', tags: ['t'] }], 0);
    journal.hide('slow', 1);

    const iterator = new InMemoryQuery(journal)
      .eventsByTag<string>('t', offsetStart, { pollIntervalMs: 10, lookbackWindowMs: 5_000 })[Symbol.asyncIterator]();
    try {
      setSystemTime(new Date(120_000));
      await journal.append('b', [{ event: 'b1', tags: ['t'] }], 0);
      expect(await nextEventOf(iterator)).toBe('b#1');

      journal.reveal();
      setSystemTime(new Date(121_000));
      await journal.append('c', [{ event: 'c1', tags: ['t'] }], 0);
      expect(await nextEventOf(iterator)).toBe('c#1');
    } finally {
      await iterator.return?.();
    }
  });
});

describe('a push stream whose catch-up read fails', () => {
  /** A journal whose reads wait for `release()` and then reject. */
  function journalWithFailingCatchUp(): { journal: InMemoryJournal; release: () => void } {
    const journal = new InMemoryJournal();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    journal.read = (async () => {
      await gate;
      throw new Error('catch-up read failed');
    }) as typeof journal.read;
    return { journal, release };
  }

  async function quietly<T>(body: () => Promise<T>): Promise<T> {
    const warn = console.warn;
    console.warn = () => {};
    try {
      return await body();
    } finally {
      console.warn = warn;
    }
  }

  test('eventsByTag still delivers the events published during the failed read, and later ones', async () => {
    await quietly(async () => {
      const { journal, release } = journalWithFailingCatchUp();
      await journal.append('p', [{ event: 'p1', tags: ['t'] }], 0);
      const iterator = new InMemoryQuery(journal).eventsByTag<string>('t', offsetStart)[Symbol.asyncIterator]();
      const delivered: string[] = [];
      const pump = (async (): Promise<void> => {
        for (;;) {
          const next = await iterator.next();
          if (next.done) return;
          delivered.push(next.value.event.event);
        }
      })();
      await journal.append('p', [{ event: 'p2', tags: ['t'] }], 1);
      release();
      await awaitCondition(() => delivered.length >= 1, { timeoutMs: 2_000, label: 'p2 released after the failed read' });
      await journal.append('p', [{ event: 'p3', tags: ['t'] }], 2);
      await awaitCondition(() => delivered.length >= 2, { timeoutMs: 2_000, label: 'p3 delivered live' });
      await iterator.return?.();
      await pump;
      expect(delivered).toEqual(['p2', 'p3']);
    });
  });

  test('eventsByPersistenceId still delivers the events published during the failed read, and later ones', async () => {
    await quietly(async () => {
      const { journal, release } = journalWithFailingCatchUp();
      await journal.append('p', [{ event: 'p1' }], 0);
      const iterator = new InMemoryQuery(journal).eventsByPersistenceId<string>('p', 1)[Symbol.asyncIterator]();
      const delivered: string[] = [];
      const pump = (async (): Promise<void> => {
        for (;;) {
          const next = await iterator.next();
          if (next.done) return;
          delivered.push(next.value.event);
        }
      })();
      await journal.append('p', [{ event: 'p2' }], 1);
      release();
      await awaitCondition(() => delivered.length >= 1, { timeoutMs: 2_000, label: 'p2 released after the failed read' });
      await journal.append('p', [{ event: 'p3' }], 2);
      await awaitCondition(() => delivered.length >= 2, { timeoutMs: 2_000, label: 'p3 delivered live' });
      await iterator.return?.();
      await pump;
      expect(delivered).toEqual(['p2', 'p3']);
    });
  });
});
