/**
 * Tests for the push-based PersistenceQuery path (#42).
 *
 * The contract:
 *
 *   - When `journal.events` exists, `eventsByPersistenceId` and
 *     `eventsByTag` deliver events within a few ms of `append`
 *     (vs. up to `pollIntervalMs` for the poll fallback).
 *   - The catch-up read + bus-subscribe race doesn't double-emit
 *     events that arrived during the catch-up window.
 *   - `iterator.return()` unsubscribes from the bus.
 *   - Journals without `.events` keep working via the original
 *     poll loop (regression guard).
 */
import { describe, expect, test } from 'bun:test';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { SqliteJournal } from '../../../../../src/persistence/journals/SqliteJournal.js';
import { SqliteJournalOptions } from '../../../../../src/persistence/journals/SqliteJournalOptions.js';
import { InMemoryQuery } from '../../../../../src/persistence/query/InMemoryQuery.js';
import { offsetStart } from '../../../../../src/persistence/query/PersistenceQuery.js';
import type { Journal } from '../../../../../src/persistence/Journal.js';
import type { PersistentEvent } from '../../../../../src/persistence/JournalTypes.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('Push-based PersistenceQuery — InMemoryJournal', () => {
  test('1. delivers a freshly-appended event in well under 100ms', async () => {
    const journal = new InMemoryJournal();
    const query = new InMemoryQuery(journal);
    const stream = query.eventsByPersistenceId<{ n: number }>('a', 1);
    const it = stream[Symbol.asyncIterator]();

    // Schedule an append AFTER the iterator is already waiting.
    const t0 = Date.now();
    void (async (): Promise<void> => {
      await sleep(10);
      await journal.append('a', [{ n: 42 }], 0);
    })();

    const result = await it.next();
    const elapsed = Date.now() - t0;
    expect(result.done).toBe(false);
    expect((result.value as PersistentEvent<{ n: number }>).event.n).toBe(42);
    expect(elapsed).toBeLessThan(100);

    await it.return!();
  });

  test('2. catch-up race — pre-iterator events + post-iterator events delivered exactly once', async () => {
    const journal = new InMemoryJournal();
    // Pre-iterator append.
    await journal.append('a', [{ n: 1 }, { n: 2 }], 0);
    const query = new InMemoryQuery(journal);
    const stream = query.eventsByPersistenceId<{ n: number }>('a', 1);
    const it = stream[Symbol.asyncIterator]();

    // Concurrently with subscribe + catch-up, append a third event.
    void (async (): Promise<void> => {
      await sleep(5);
      await journal.append('a', [{ n: 3 }], 2);
    })();

    const a = await it.next();
    const b = await it.next();
    const c = await it.next();

    expect((a.value as PersistentEvent<{ n: number }>).event.n).toBe(1);
    expect((b.value as PersistentEvent<{ n: number }>).event.n).toBe(2);
    expect((c.value as PersistentEvent<{ n: number }>).event.n).toBe(3);

    // Make sure no fourth event slipped in.
    let extra: { value: unknown; done: boolean | undefined } | null = null;
    void (async (): Promise<void> => { extra = await it.next(); })();
    await sleep(50);
    expect(extra).toBeNull();

    await it.return!();
  });

  test('3. tag query gets push delivery within 100ms', async () => {
    const journal = new InMemoryJournal();
    const query = new InMemoryQuery(journal);
    const stream = query.eventsByTag<{ msg: string }>('orders', offsetStart);
    const it = stream[Symbol.asyncIterator]();

    const t0 = Date.now();
    void (async (): Promise<void> => {
      await sleep(10);
      await journal.append('a', [{ msg: 'one' }], 0, ['orders']);
    })();

    const result = await it.next();
    const elapsed = Date.now() - t0;
    expect(result.done).toBe(false);
    expect((result.value as { event: PersistentEvent<{ msg: string }> }).event.event.msg).toBe('one');
    expect(elapsed).toBeLessThan(100);

    await it.return!();
  });

  test('4. iterator.return() unsubscribes from the bus', async () => {
    const journal = new InMemoryJournal();
    const initialCount = journal.events!.subscriberCount!();
    const stream = new InMemoryQuery(journal)
      .eventsByPersistenceId<{ n: number }>('a', 1);
    const it = stream[Symbol.asyncIterator]();

    // Force the iterator to actually subscribe — the subscribe happens
    // in the iterator factory itself, so by the time we call next()
    // the listener is registered.
    void it.next();
    await sleep(10);
    expect(journal.events!.subscriberCount!()).toBe(initialCount + 1);

    await it.return!();
    await sleep(10);
    expect(journal.events!.subscriberCount!()).toBe(initialCount);
  });
});

describe('Push-based PersistenceQuery — SqliteJournal', () => {
  test('5. delivers a freshly-appended event in well under 100ms', async () => {
    const journalOptions = SqliteJournalOptions.create()
      .withPath(':memory:');
    const journal = new SqliteJournal(journalOptions);
    // Force-init the DB so the bus + statements are wired up.
    await journal.persistenceIds();
    const query = new InMemoryQuery(journal);
    const stream = query.eventsByPersistenceId<{ k: string }>('z', 1);
    const it = stream[Symbol.asyncIterator]();

    const t0 = Date.now();
    void (async (): Promise<void> => {
      await sleep(10);
      await journal.append('z', [{ k: 'hi' }], 0);
    })();

    const result = await it.next();
    const elapsed = Date.now() - t0;
    expect(result.done).toBe(false);
    expect((result.value as PersistentEvent<{ k: string }>).event.k).toBe('hi');
    expect(elapsed).toBeLessThan(100);

    await it.return!();
    await journal.close();
  });
});

describe('Push-based PersistenceQuery — fallback', () => {
  test('6. journal without `events` capability still works via poll', async () => {
    // Hand-rolled minimal journal — no `events` field; emulates a
    // cross-process backend like Cassandra.
    const events: PersistentEvent<unknown>[] = [];
    const noBusJournal: Journal = {
      async append(pid, evts, expectedSeq, tags) {
        const startSeq = events.length;
        if (startSeq !== expectedSeq) {
          throw new Error(`concurrency: expected ${expectedSeq}, was ${startSeq}`);
        }
        const written = (evts as ReadonlyArray<unknown>).map((e, i) => ({
          persistenceId: pid,
          sequenceNr: startSeq + i + 1,
          event: e,
          timestamp: Date.now(),
          tags: tags ? [...tags] : undefined,
        }));
        events.push(...written as PersistentEvent<unknown>[]);
        return written as never;
      },
      async read(pid, fromSeq, toSeq) {
        return events.filter((e) =>
          e.persistenceId === pid
          && e.sequenceNr >= fromSeq
          && (toSeq === undefined || e.sequenceNr <= toSeq),
        ) as never;
      },
      async highestSeq() { return events.length; },
      async delete() { /* no-op */ },
      async persistenceIds() { return Array.from(new Set(events.map((e) => e.persistenceId))); },
      // no `events` field — push path is unavailable.
    };

    const query = new InMemoryQuery(noBusJournal);
    const stream = query.eventsByPersistenceId<{ n: number }>('a', 1, { pollIntervalMs: 50 });
    const it = stream[Symbol.asyncIterator]();

    void (async (): Promise<void> => {
      await sleep(20);
      await noBusJournal.append('a', [{ n: 7 }], 0);
    })();

    const result = await it.next();
    expect(result.done).toBe(false);
    expect((result.value as PersistentEvent<{ n: number }>).event.n).toBe(7);

    await it.return!();
  });
});
