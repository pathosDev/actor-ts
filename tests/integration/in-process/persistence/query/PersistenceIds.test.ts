/**
 * `allPersistenceIds` + `currentPersistenceIdsPaginated` (#156).
 *
 * The three things worth proving, and where each is proved:
 *
 *   - **Paging is real.** The query layer must ask the journal for pages, not
 *     fetch everything and slice.  A counting journal wrapper makes the number
 *     of round-trips observable, because a materialising implementation would
 *     pass every result assertion in this file.
 *   - **Every backend agrees with the reference.** `persistenceIdPage` defines
 *     the ordering and cursor semantics; SQLite's `ORDER BY … LIMIT`,
 *     Postgres' dialect-expanded form and Cassandra's clustering range are
 *     each checked against it rather than against a hand-written expectation.
 *   - **The live stream emits each id once, and stops.** Both the push path
 *     (journal with an event bus) and the poll path (journal without one).
 */
import { describe, expect, test } from 'bun:test';
import { persistenceIdPage } from '../../../../../src/persistence/Journal.js';
import type { Journal } from '../../../../../src/persistence/Journal.js';
import type { JournalEntry, PersistentEvent } from '../../../../../src/persistence/JournalTypes.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { SqliteJournal } from '../../../../../src/persistence/journals/SqliteJournal.js';
import { SqliteJournalOptions } from '../../../../../src/persistence/journals/SqliteJournalOptions.js';
import { CassandraJournal } from '../../../../../src/persistence/journals/CassandraJournal.js';
import { CassandraJournalOptions } from '../../../../../src/persistence/journals/CassandraJournalOptions.js';
import { PostgresJournal } from '../../../../../src/persistence/journals/PostgresJournal.js';
import { PostgresJournalOptions } from '../../../../../src/persistence/journals/PostgresJournalOptions.js';
import { MsSqlJournal } from '../../../../../src/persistence/journals/MsSqlJournal.js';
import { MsSqlJournalOptions } from '../../../../../src/persistence/journals/MsSqlJournalOptions.js';
import { InMemoryQuery } from '../../../../../src/persistence/query/InMemoryQuery.js';
import { SqliteQuery } from '../../../../../src/persistence/query/SqliteQuery.js';
import { CassandraQuery } from '../../../../../src/persistence/query/CassandraQuery.js';
import { FakeCassandraClient } from '../FakeCassandraClient.js';
import { FakePgPool } from '../FakePgPool.js';
import { FakeMsSqlPool } from '../FakeMsSqlPool.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

/** Ids chosen so sorted order differs from insertion order in every test. */
const CORPUS = ['order-9', 'account-1', 'user-x', 'order-10', 'account-2'];
const SORTED = [...CORPUS].sort();

async function seed(journal: Journal, ids: ReadonlyArray<string> = CORPUS): Promise<void> {
  for (const persistenceId of ids) await journal.append(persistenceId, [{ event: { seeded: true } }], 0);
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const persistenceId of stream) out.push(persistenceId);
  return out;
}

/**
 * Counts `persistenceIdsPaginated` calls and the widest page it was asked for.
 *
 * Delegation rather than a subclass so the wrapper works over any journal; the
 * only method it changes is the one under test.
 */
class CountingJournal implements Journal {
  paginatedCalls = 0;
  fullListCalls = 0;
  readonly requestedCursors: Array<string | undefined> = [];

  constructor(private readonly inner: InMemoryJournal) {}

  append<E>(
    persistenceId: string, entries: ReadonlyArray<JournalEntry<E>>, expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> {
    return this.inner.append(persistenceId, entries, expectedSeq);
  }
  read<E>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    return this.inner.read<E>(persistenceId, fromSeq, toSeq);
  }
  highestSeq(persistenceId: string): Promise<number> { return this.inner.highestSeq(persistenceId); }
  delete(persistenceId: string, toSeq: number): Promise<void> { return this.inner.delete(persistenceId, toSeq); }

  persistenceIds(): Promise<string[]> {
    this.fullListCalls++;
    return this.inner.persistenceIds();
  }

  persistenceIdsPaginated(afterPersistenceId: string | undefined, limit: number): Promise<string[]> {
    this.paginatedCalls++;
    this.requestedCursors.push(afterPersistenceId);
    return this.inner.persistenceIdsPaginated(afterPersistenceId, limit);
  }
}

/** A journal with no paging push-down and no event bus — exercises both fallbacks. */
class UnpaginatedJournal implements Journal {
  constructor(private readonly inner: InMemoryJournal) {}

  append<E>(
    persistenceId: string, entries: ReadonlyArray<JournalEntry<E>>, expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> {
    return this.inner.append(persistenceId, entries, expectedSeq);
  }
  read<E>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    return this.inner.read<E>(persistenceId, fromSeq, toSeq);
  }
  highestSeq(persistenceId: string): Promise<number> { return this.inner.highestSeq(persistenceId); }
  delete(persistenceId: string, toSeq: number): Promise<void> { return this.inner.delete(persistenceId, toSeq); }
  persistenceIds(): Promise<string[]> { return this.inner.persistenceIds(); }
}

describe('currentPersistenceIdsPaginated — InMemoryQuery', () => {
  test('yields every id ascending, whatever order they were appended in', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const query = new InMemoryQuery(journal);
    expect(await collect(query.currentPersistenceIdsPaginated())).toEqual(SORTED);
  });

  test('an empty journal completes without yielding', async () => {
    const query = new InMemoryQuery(new InMemoryJournal());
    expect(await collect(query.currentPersistenceIdsPaginated())).toEqual([]);
  });

  test('the walk is actually paged — one journal round-trip per page', async () => {
    const journal = new CountingJournal(new InMemoryJournal());
    await seed(journal);
    const query = new InMemoryQuery(journal);

    expect(await collect(query.currentPersistenceIdsPaginated({ pageSize: 2 }))).toEqual(SORTED);
    // 5 ids at 2 per page: [2] [2] [1] — the short third page ends the walk,
    // so no fourth (empty) round-trip.  This is the assertion an
    // implementation that fetched everything and sliced would fail.
    expect(journal.paginatedCalls).toBe(3);
    expect(journal.fullListCalls).toBe(0);
    expect(journal.requestedCursors).toEqual([undefined, SORTED[1], SORTED[3]]);
  });

  test('a page size that exactly divides the id count costs one extra empty page', async () => {
    const journal = new CountingJournal(new InMemoryJournal());
    await seed(journal, ['a', 'b', 'c', 'd']);
    const query = new InMemoryQuery(journal);
    expect(await collect(query.currentPersistenceIdsPaginated({ pageSize: 2 }))).toEqual(['a', 'b', 'c', 'd']);
    // A full page cannot prove exhaustion, so the walk asks once more.
    expect(journal.paginatedCalls).toBe(3);
  });

  test('afterPersistenceId resumes a partial walk without repeating the cursor', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const query = new InMemoryQuery(journal);
    const resumed = await collect(
      query.currentPersistenceIdsPaginated({ afterPersistenceId: SORTED[1], pageSize: 2 }),
    );
    expect(resumed).toEqual(SORTED.slice(2));
  });

  test('a journal without the paging push-down still walks correctly', async () => {
    const journal = new UnpaginatedJournal(new InMemoryJournal());
    await seed(journal);
    const query = new InMemoryQuery(journal);
    expect(await collect(query.currentPersistenceIdsPaginated({ pageSize: 2 }))).toEqual(SORTED);
  });

  test('currentPersistenceIds is unchanged — still the whole list in one array', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const query = new InMemoryQuery(journal);
    expect((await query.currentPersistenceIds()).sort()).toEqual(SORTED);
  });
});

describe('allPersistenceIds — push path (journal with an event bus)', () => {
  test('emits the existing ids, then each new one as it first appears', async () => {
    const journal = new InMemoryJournal();
    await seed(journal, ['account-1', 'account-2']);
    const query = new InMemoryQuery(journal);

    const seen: string[] = [];
    const stream = query.allPersistenceIds();
    const iterator = stream[Symbol.asyncIterator]();
    const consumer = (async (): Promise<void> => {
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) return;
        seen.push(next.value);
      }
    })();

    await awaitCondition(() => seen.length === 2, {
      label: 'the catch-up sweep delivered both pre-existing ids',
    });
    await journal.append('account-3', [{ event: {} }], 0);
    await awaitCondition(() => seen.length === 3, { label: 'the new id arrived over the bus' });

    await iterator.return!();
    await consumer;
    expect(seen).toEqual(['account-1', 'account-2', 'account-3']);
  });

  test('an id is emitted once however many events it accumulates', async () => {
    const journal = new InMemoryJournal();
    const query = new InMemoryQuery(journal);
    const seen: string[] = [];
    const iterator = query.allPersistenceIds()[Symbol.asyncIterator]();
    const consumer = (async (): Promise<void> => {
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) return;
        seen.push(next.value);
      }
    })();

    await journal.append('busy', [{ event: {} }], 0);
    await journal.append('busy', [{ event: {} }], 1);
    await journal.append('busy', [{ event: {} }], 2);
    await journal.append('quiet', [{ event: {} }], 0);
    await awaitCondition(() => seen.length === 2, { label: 'both ids were emitted' });

    await iterator.return!();
    await consumer;
    expect(seen).toEqual(['busy', 'quiet']);
  });

  test('an id sorting before everything already emitted is still delivered', async () => {
    // The reason the stream keeps a set instead of a lexicographic watermark:
    // ids are not created in sorted order, and a watermark would drop this one
    // silently — the fan-out projection for it would simply never start.
    const journal = new InMemoryJournal();
    await seed(journal, ['zebra']);
    const query = new InMemoryQuery(journal);
    const seen: string[] = [];
    const iterator = query.allPersistenceIds()[Symbol.asyncIterator]();
    const consumer = (async (): Promise<void> => {
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) return;
        seen.push(next.value);
      }
    })();

    await awaitCondition(() => seen.length === 1, { label: 'the catch-up sweep delivered zebra' });
    await journal.append('aardvark', [{ event: {} }], 0);
    await awaitCondition(() => seen.length === 2, { label: 'the lexicographically-earlier id arrived' });

    await iterator.return!();
    await consumer;
    expect(seen).toEqual(['zebra', 'aardvark']);
  });

  test('return() ends the stream', async () => {
    const journal = new InMemoryJournal();
    await seed(journal, ['a']);
    const iterator = new InMemoryQuery(journal).allPersistenceIds()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe('a');
    expect((await iterator.return!()).done).toBe(true);
    expect((await iterator.next()).done).toBe(true);
  });
});

describe('allPersistenceIds — poll path (journal without an event bus)', () => {
  test('emits pre-existing ids and picks up a later one on the next sweep', async () => {
    const journal = new UnpaginatedJournal(new InMemoryJournal());
    await seed(journal, ['account-1']);
    const query = new InMemoryQuery(journal);

    const seen: string[] = [];
    const iterator = query.allPersistenceIds({ pollIntervalMs: 20 })[Symbol.asyncIterator]();
    const consumer = (async (): Promise<void> => {
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) return;
        seen.push(next.value);
      }
    })();

    await awaitCondition(() => seen.length === 1, { label: 'the first sweep delivered account-1' });
    await journal.append('account-2', [{ event: {} }], 0);
    await awaitCondition(() => seen.length === 2, {
      timeoutMs: 4_000, label: 'a later sweep picked up account-2',
    });

    await iterator.return!();
    await consumer;
    expect(seen).toEqual(['account-1', 'account-2']);
  });

  test('a repeated sweep does not re-emit ids it already delivered', async () => {
    const journal = new UnpaginatedJournal(new InMemoryJournal());
    await seed(journal, ['a', 'b']);
    const query = new InMemoryQuery(journal);
    const seen: string[] = [];
    const iterator = query.allPersistenceIds({ pollIntervalMs: 5 })[Symbol.asyncIterator]();
    const consumer = (async (): Promise<void> => {
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) return;
        seen.push(next.value);
      }
    })();

    await awaitCondition(() => seen.length === 2, { label: 'both ids were delivered' });
    // Let several more sweeps run; a stream that re-emitted would grow here.
    await awaitCondition(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return true;
    }, { label: 'several poll intervals elapsed' });
    await iterator.return!();
    await consumer;
    expect(seen).toEqual(['a', 'b']);
  });

  test('return() clears the pending poll timer instead of waiting it out', async () => {
    const journal = new UnpaginatedJournal(new InMemoryJournal());
    const iterator = new InMemoryQuery(journal)
      .allPersistenceIds({ pollIntervalMs: 60_000 })[Symbol.asyncIterator]();
    // Empty journal: the first `next()` parks on the poll timer forever.
    const pending = iterator.next();
    const started = performance.now();
    await iterator.return!();
    expect((await pending).done).toBe(true);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe('Backend parity — the push-downs agree with persistenceIdPage', () => {
  test('SqliteJournal pages through ORDER BY … LIMIT', async () => {
    const journal = new SqliteJournal(SqliteJournalOptions.create().withPath(':memory:'));
    await seed(journal);
    const query = new SqliteQuery(journal);

    expect(await collect(query.currentPersistenceIdsPaginated({ pageSize: 2 }))).toEqual(SORTED);
    expect(await journal.persistenceIdsPaginated(undefined, 2)).toEqual(persistenceIdPage(CORPUS, undefined, 2));
    expect(await journal.persistenceIdsPaginated(SORTED[1], 2)).toEqual(persistenceIdPage(CORPUS, SORTED[1], 2));
    expect(await journal.persistenceIdsPaginated(SORTED[4], 2)).toEqual([]);

    await journal.close();
  });

  test('PostgresJournal pages through the dialect-expanded statement', async () => {
    const pool = new FakePgPool();
    const journal = new PostgresJournal(PostgresJournalOptions.create().withPool(pool));
    await seed(journal);

    expect(await journal.persistenceIdsPaginated(undefined, 2)).toEqual(persistenceIdPage(CORPUS, undefined, 2));
    expect(await journal.persistenceIdsPaginated(SORTED[1], 2)).toEqual(persistenceIdPage(CORPUS, SORTED[1], 2));
    // The cursor is bound; only the row cap is interpolated.
    expect(pool.log).toContain(
      'SELECT DISTINCT persistence_id FROM events WHERE persistence_id > $1 ORDER BY persistence_id ASC LIMIT 2',
    );
    await journal.close();
  });

  test('MsSqlJournal caps rows with FETCH NEXT rather than LIMIT', async () => {
    const pool = new FakeMsSqlPool();
    const journal = new MsSqlJournal(MsSqlJournalOptions.create().withPool(pool));
    await seed(journal);

    expect(await journal.persistenceIdsPaginated(undefined, 2)).toEqual(persistenceIdPage(CORPUS, undefined, 2));
    expect(await journal.persistenceIdsPaginated(SORTED[1], 3)).toEqual(persistenceIdPage(CORPUS, SORTED[1], 3));
    expect(pool.log.some((sql) => /OFFSET 0 ROWS FETCH NEXT 3 ROWS ONLY$/.test(sql))).toBe(true);
    await journal.close();
  });

  test('CassandraJournal pages through the all_persistence_ids clustering range', async () => {
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(new FakeCassandraClient());
    const journal = new CassandraJournal(journalOptions);
    await seed(journal);
    const query = new CassandraQuery(journal);

    expect(await collect(query.currentPersistenceIdsPaginated({ pageSize: 2 }))).toEqual(SORTED);
    expect(await journal.persistenceIdsPaginated(undefined, 2)).toEqual(persistenceIdPage(CORPUS, undefined, 2));
    expect(await journal.persistenceIdsPaginated(SORTED[2], 10)).toEqual(persistenceIdPage(CORPUS, SORTED[2], 10));

    await journal.close();
  });

  test('allPersistenceIds over a cross-process journal uses the poll path', async () => {
    // SqliteJournal exposes no `events` bus, so this is the polling branch —
    // and it still has to complete its catch-up sweep and then keep running.
    const journal = new SqliteJournal(SqliteJournalOptions.create().withPath(':memory:'));
    await seed(journal, ['a', 'b']);
    const query = new SqliteQuery(journal);
    const seen: string[] = [];
    const iterator = query.allPersistenceIds({ pollIntervalMs: 20 })[Symbol.asyncIterator]();
    const consumer = (async (): Promise<void> => {
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) return;
        seen.push(next.value);
      }
    })();

    await awaitCondition(() => seen.length === 2, { label: 'the sweep delivered both ids' });
    await journal.append('c', [{ event: {} }], 0);
    await awaitCondition(() => seen.length === 3, {
      timeoutMs: 4_000, label: 'a later sweep picked up the third id',
    });

    await iterator.return!();
    await consumer;
    expect(seen).toEqual(['a', 'b', 'c']);
    await journal.close();
  });
});
