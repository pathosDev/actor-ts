/**
 * `RelationalQuery` and its two named subclasses (#391) — the read side of the
 * tags join table `RelationalJournal` has always written.
 *
 * Two different things are worth proving here, and the second is the one that
 * actually distinguishes this from the status quo:
 *
 *   - **The answers match the reference.** Every filter shape is asserted
 *     against `InMemoryQuery` over the same corpus rather than against a
 *     hand-written expectation, so a wrong result cannot be baked into both.
 *   - **The index is what produced them.** Before #391 a projection over
 *     Postgres or MariaDB fell through to the journal-walking scan and still
 *     returned the right events — every result assertion in this file would
 *     have passed.  The statement-log assertions are what tell the two apart.
 *
 * What the fakes can and cannot show is documented on `TagJoinQuery.ts`; the
 * live Docker suite is what checks the statements against a real server.
 */
import { describe, expect, test } from 'bun:test';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { PostgresJournal } from '../../../../../src/persistence/journals/PostgresJournal.js';
import { PostgresJournalOptions } from '../../../../../src/persistence/journals/PostgresJournalOptions.js';
import { MariaDbJournal } from '../../../../../src/persistence/journals/MariaDbJournal.js';
import { MariaDbJournalOptions } from '../../../../../src/persistence/journals/MariaDbJournalOptions.js';
import { InMemoryQuery } from '../../../../../src/persistence/query/InMemoryQuery.js';
import { PostgresQuery } from '../../../../../src/persistence/query/PostgresQuery.js';
import { MariaDbQuery } from '../../../../../src/persistence/query/MariaDbQuery.js';
import { RelationalQuery } from '../../../../../src/persistence/query/RelationalQuery.js';
import {
  offsetStart,
  type Offset,
  type TagFilter,
  type TaggedEvent,
} from '../../../../../src/persistence/query/PersistenceQuery.js';
import { JournalError } from '../../../../../src/persistence/JournalTypes.js';
import type { PgQueryResult } from '../../../../../src/persistence/journals/PostgresClient.js';
import { FakePgPool } from '../FakePgPool.js';
import { FakeMariaDbPool } from '../FakeMariaDbPool.js';
import { isTagJoinQuery } from '../TagJoinQuery.js';

/**
 * The `sleep(2)` between appends is the fixture, not a wait: `Offset` orders by
 * millisecond timestamp, and `RelationalJournal` stamps one `Date.now()` per
 * append call, so without the gap the corpus has no defined order.  Load only
 * ever makes the gap larger, which is harmless (#418).
 */
const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

type Seedable = {
  append(
    persistenceId: string,
    entries: ReadonlyArray<{ event: unknown; tags?: string[] }>,
    expectedSeq: number,
  ): Promise<unknown>;
};

/** Same corpus the `InMemoryQuery` / `SqliteQuery` suites use, so results compare. */
async function seedFilterCorpus(journal: Seedable): Promise<void> {
  await journal.append('order-1', [{ event: { id: 1 }, tags: ['type:Order', 'tenant:t1'] }], 0);
  await sleep(2);
  await journal.append('order-2', [{ event: { id: 2 }, tags: ['type:Order', 'tenant:t2'] }], 0);
  await sleep(2);
  await journal.append('order-3', [{ event: { id: 3 }, tags: ['type:Order', 'tenant:t1', 'archived'] }], 0);
  await sleep(2);
  await journal.append('invoice-1', [{ event: { id: 4 }, tags: ['type:Invoice', 'tenant:t1'] }], 0);
  await sleep(2);
  await journal.append('invoice-2', [{ event: { id: 5 }, tags: ['type:Invoice', 'tenant:t2', 'archived'] }], 0);
  await sleep(2);
  await journal.append('event-1', [{ event: { id: 6 }, tags: ['type:Event', 'tenant:t1'] }], 0);
}

const ids = (events: ReadonlyArray<TaggedEvent<{ id: number }>>): number[] =>
  events.map((tagged) => tagged.event.event.id).sort((first, second) => first - second);

/** The same filter over the in-memory reference — the expectation every case is checked against. */
async function reference(filter: TagFilter, fromOffset: Offset = offsetStart): Promise<number[]> {
  const journal = new InMemoryJournal();
  await seedFilterCorpus(journal);
  return ids(await new InMemoryQuery(journal).currentEventsByTag<{ id: number }>(filter, fromOffset));
}

type Backend = {
  readonly name: string;
  /** A seeded journal, its query, and the pool's statement log. */
  open(): Promise<{
    query: RelationalQuery;
    log: string[];
    close(): Promise<void>;
  }>;
};

const BACKENDS: ReadonlyArray<Backend> = [
  {
    name: 'PostgresQuery',
    open: async () => {
      const pool = new FakePgPool();
      const journal = new PostgresJournal(PostgresJournalOptions.create().withPool(pool));
      await seedFilterCorpus(journal);
      return { query: new PostgresQuery(journal), log: pool.log, close: () => journal.close() };
    },
  },
  {
    name: 'MariaDbQuery',
    open: async () => {
      const pool = new FakeMariaDbPool();
      const journal = new MariaDbJournal(MariaDbJournalOptions.create().withPool(pool));
      await seedFilterCorpus(journal);
      return { query: new MariaDbQuery(journal), log: pool.log, close: () => journal.close() };
    },
  },
];

describe.each(BACKENDS.map((backend) => [backend.name, backend] as const))(
  'Multi-tag filter — %s parity with the in-memory reference',
  (_name, backend) => {
    test('all: intersection — indexed pre-filter on the first tag, JS refine for the rest', async () => {
      const { query, close } = await backend.open();
      const filter = { all: ['type:Order', 'tenant:t1'] };
      expect(ids(await query.currentEventsByTag<{ id: number }>(filter, offsetStart)))
        .toEqual(await reference(filter));
      await close();
    });

    test('any: union via t.tag IN (…), DISTINCT collapsing multi-tag hits', async () => {
      const { query, close } = await backend.open();
      const filter = { any: ['tenant:t1', 'tenant:t2'] };
      const found = await query.currentEventsByTag<{ id: number }>(filter, offsetStart);
      expect(ids(found)).toEqual(await reference(filter));
      // Every event carries exactly one tenant tag, so DISTINCT is not what
      // makes this six long — the next case is the one that needs it.
      expect(found).toHaveLength(6);
      await close();
    });

    test('any: an event matching two listed tags is returned once', async () => {
      const { query, close } = await backend.open();
      // order-3 is tagged `type:Order` AND `archived`; without DISTINCT the
      // join emits one row per matching tag row and it would come back twice.
      const filter = { any: ['type:Order', 'archived'] };
      const found = await query.currentEventsByTag<{ id: number }>(filter, offsetStart);
      expect(ids(found)).toEqual(await reference(filter));
      expect(ids(found)).toEqual([1, 2, 3, 5]);
      await close();
    });

    test('not-only: falls back to the journal scan and still applies the exclusion', async () => {
      const { query, close } = await backend.open();
      const filter = { not: ['archived'] };
      expect(ids(await query.currentEventsByTag<{ id: number }>(filter, offsetStart)))
        .toEqual(await reference(filter));
      await close();
    });

    test('combined all+not', async () => {
      const { query, close } = await backend.open();
      const filter = { all: ['type:Order'], not: ['archived'] };
      expect(ids(await query.currentEventsByTag<{ id: number }>(filter, offsetStart)))
        .toEqual(await reference(filter));
      await close();
    });

    test('combined all+any', async () => {
      const { query, close } = await backend.open();
      const filter = { any: ['type:Order', 'type:Invoice'], all: ['tenant:t1'] };
      expect(ids(await query.currentEventsByTag<{ id: number }>(filter, offsetStart)))
        .toEqual(await reference(filter));
      await close();
    });

    test('bare-string filter is equivalent to { all: [tag] }', async () => {
      const { query, close } = await backend.open();
      expect(ids(await query.currentEventsByTag<{ id: number }>('archived', offsetStart)))
        .toEqual(await reference('archived'));
      await close();
    });

    test('empty any matches nothing, and has no tag to index on', async () => {
      const { query, log, close } = await backend.open();
      log.length = 0;
      expect(await query.currentEventsByTag<{ id: number }>({ any: [] }, offsetStart)).toHaveLength(0);
      // `∃ over ∅` is false, so the answer is empty — but an empty `any` gives
      // the index nothing to seed a range walk with, so this is the scan path
      // rejecting every row rather than a query that returned none.
      expect(log.some(isTagJoinQuery)).toBe(false);
      await close();
    });

    test('fromOffset drops everything at or before the cursor', async () => {
      const { query, close } = await backend.open();
      const all = await query.currentEventsByTag<{ id: number }>('type:Order', offsetStart);
      expect(ids(all)).toEqual([1, 2, 3]);
      // Resume from the second event's own offset: `currentEventsByTag` is
      // inclusive, so the cursor's own event comes back and the first does not.
      const resumed = await query.currentEventsByTag<{ id: number }>('type:Order', all[1]!.offset);
      expect(ids(resumed)).toEqual([2, 3]);
      await close();
    });

    test('the tag path is the JOIN, not the journal walk', async () => {
      const { query, log, close } = await backend.open();
      log.length = 0;
      await query.currentEventsByTag<{ id: number }>({ all: ['type:Order'] }, offsetStart);
      // One statement, and it is the index read.  The fallback would have shown
      // up as a `SELECT DISTINCT persistence_id` followed by one read per id —
      // which is the whole defect #391 is about.
      expect(log).toHaveLength(1);
      expect(isTagJoinQuery(log[0]!)).toBe(true);
      expect(log[0]).not.toMatch(/SELECT DISTINCT persistence_id/i);
      await close();
    });

    test('only the not-only shape still walks the journal', async () => {
      const { query, log, close } = await backend.open();
      log.length = 0;
      await query.currentEventsByTag<{ id: number }>({ not: ['archived'] }, offsetStart);
      expect(log.some(isTagJoinQuery)).toBe(false);
      expect(log[0]).toMatch(/SELECT DISTINCT persistence_id/i);
      await close();
    });

    test('the per-arity statement cache reuses one statement across polls', async () => {
      const { query, log, close } = await backend.open();
      log.length = 0;
      const filter = { any: ['tenant:t1', 'tenant:t2'] };
      await query.currentEventsByTag<{ id: number }>(filter, offsetStart);
      await query.currentEventsByTag<{ id: number }>(filter, offsetStart);
      expect(log).toHaveLength(2);
      expect(log[0]).toBe(log[1]!);
      await close();
    });

    test('BIGINT columns are widened, not passed through as strings or bigints', async () => {
      const { query, close } = await backend.open();
      const found = await query.currentEventsByTag<{ id: number }>('type:Order', offsetStart);
      for (const tagged of found) {
        expect(typeof tagged.event.sequenceNr).toBe('number');
        expect(typeof tagged.event.timestamp).toBe('number');
        expect(typeof tagged.offset.timestamp).toBe('number');
      }
      await close();
    });

    test('the CSV tags column round-trips onto the event', async () => {
      const { query, close } = await backend.open();
      const found = await query.currentEventsByTag<{ id: number }>('archived', offsetStart);
      const archived = found.find((tagged) => tagged.event.event.id === 3);
      expect(archived?.event.tags).toEqual(['type:Order', 'tenant:t1', 'archived']);
      await close();
    });
  },
);

describe('RelationalQuery — statement construction', () => {
  test('a configured events table name reaches both sides of the JOIN', async () => {
    const pool = new FakePgPool();
    const journalOptions = PostgresJournalOptions.create()
      .withPool(pool)
      .withEventsTable('ledger');
    const journal = new PostgresJournal(journalOptions);
    await seedFilterCorpus(journal);
    pool.log.length = 0;

    const found = await new PostgresQuery(journal)
      .currentEventsByTag<{ id: number }>('type:Order', offsetStart);
    expect(ids(found)).toEqual([1, 2, 3]);
    expect(pool.log[0]).toContain('FROM ledger_tags t JOIN ledger e');

    await journal.close();
  });

  test('Postgres numbers its placeholders, MariaDB does not', async () => {
    const pgPool = new FakePgPool();
    const pgJournal = new PostgresJournal(PostgresJournalOptions.create().withPool(pgPool));
    await seedFilterCorpus(pgJournal);
    pgPool.log.length = 0;
    await new PostgresQuery(pgJournal)
      .currentEventsByTag({ any: ['tenant:t1', 'tenant:t2'] }, offsetStart);
    expect(pgPool.log[0]).toContain('t.tag IN ($1, $2) AND t.timestamp >= $3');
    await pgJournal.close();

    const mariaPool = new FakeMariaDbPool();
    const mariaJournal = new MariaDbJournal(MariaDbJournalOptions.create().withPool(mariaPool));
    await seedFilterCorpus(mariaJournal);
    mariaPool.log.length = 0;
    await new MariaDbQuery(mariaJournal)
      .currentEventsByTag({ any: ['tenant:t1', 'tenant:t2'] }, offsetStart);
    expect(mariaPool.log[0]).toContain('t.tag IN (?, ?) AND t.timestamp >= ?');
    await mariaJournal.close();
  });

  test('the DISTINCT statement orders on the select list, which Postgres requires', async () => {
    const pool = new FakePgPool();
    const journal = new PostgresJournal(PostgresJournalOptions.create().withPool(pool));
    await seedFilterCorpus(journal);
    pool.log.length = 0;
    await new PostgresQuery(journal).currentEventsByTag({ any: ['tenant:t1'] }, offsetStart);
    // `SELECT DISTINCT … ORDER BY t.timestamp` is an error on Postgres, so the
    // any-path must order on the `e.` columns it actually selects.
    expect(pool.log[0]).toContain('SELECT DISTINCT e.persistence_id');
    expect(pool.log[0]).toContain('ORDER BY e.timestamp ASC, e.persistence_id ASC, e.sequence_nr ASC');
    await journal.close();
  });

  test('the single-tag statement orders along the tags primary key', async () => {
    const pool = new FakePgPool();
    const journal = new PostgresJournal(PostgresJournalOptions.create().withPool(pool));
    await seedFilterCorpus(journal);
    pool.log.length = 0;
    await new PostgresQuery(journal).currentEventsByTag('type:Order', offsetStart);
    expect(pool.log[0]).toContain('ORDER BY t.timestamp ASC, t.persistence_id ASC, t.sequence_nr ASC');
    await journal.close();
  });

  test('a driver failure is reported as a JournalError naming the concrete query', async () => {
    class RefusingPool extends FakePgPool {
      override async query(text: string, values: ReadonlyArray<unknown> = []): Promise<PgQueryResult> {
        if (isTagJoinQuery(text.replace(/\s+/g, ' ').trim())) {
          throw new Error('relation "events_tags" does not exist');
        }
        return super.query(text, values);
      }
    }
    const journal = new PostgresJournal(PostgresJournalOptions.create().withPool(new RefusingPool()));
    await seedFilterCorpus(journal);

    const attempt = new PostgresQuery(journal).currentEventsByTag('type:Order', offsetStart);
    await expect(attempt).rejects.toThrow(JournalError);
    await expect(attempt).rejects.toThrow(/^PostgresQuery\.currentEventsByTag failed:/);

    await journal.close();
  });

  test('the dialect-neutral base names itself when used directly', async () => {
    class RefusingPool extends FakePgPool {
      override async query(text: string, values: ReadonlyArray<unknown> = []): Promise<PgQueryResult> {
        if (isTagJoinQuery(text.replace(/\s+/g, ' ').trim())) throw new Error('boom');
        return super.query(text, values);
      }
    }
    // Any `RelationalJournal` works — the class exists so #532's remaining SQL
    // backends need no fourth and fifth copy of this file.
    const journal = new PostgresJournal(PostgresJournalOptions.create().withPool(new RefusingPool()));
    await seedFilterCorpus(journal);

    const attempt = new RelationalQuery(journal).currentEventsByTag('type:Order', offsetStart);
    await expect(attempt).rejects.toThrow(/^RelationalQuery\.currentEventsByTag failed:/);

    await journal.close();
  });
});

describe('RelationalQuery — compaction', () => {
  test('a deleted event disappears from the index path too', async () => {
    const pool = new FakePgPool();
    const journal = new PostgresJournal(PostgresJournalOptions.create().withPool(pool));
    await seedFilterCorpus(journal);
    const query = new PostgresQuery(journal);

    expect(ids(await query.currentEventsByTag<{ id: number }>('type:Order', offsetStart)))
      .toEqual([1, 2, 3]);

    // `delete` drops the tag rows before the events, so the inner join can
    // never surface an event whose row is already gone.
    await journal.delete('order-2', 1);
    expect(ids(await query.currentEventsByTag<{ id: number }>('type:Order', offsetStart)))
      .toEqual([1, 3]);

    await journal.close();
  });
});
