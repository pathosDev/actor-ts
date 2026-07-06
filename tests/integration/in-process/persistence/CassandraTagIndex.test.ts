/**
 * Tests for the optional `events_by_tag` side table populated by
 * `CassandraJournal` when `useTagIndex: true` (#44).  Every test
 * pair-runs the same workload with and without the index and asserts
 * the two `currentEventsByTag` paths return the same result set —
 * the side-table query is correct iff it agrees with the journal-
 * walking baseline (oracle pattern).
 */
import { describe, expect, test } from 'bun:test';
import { CassandraJournal, CassandraJournalOptions } from '../../../../src/persistence/journals/CassandraJournal.js';
import { CassandraQuery } from '../../../../src/persistence/query/CassandraQuery.js';
import { offsetStart } from '../../../../src/persistence/query/PersistenceQuery.js';
import { tagIndexDdl } from '../../../../src/persistence/journals/CassandraClient.js';
import { FakeCassandraClient } from './FakeCassandraClient.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

interface CorpusEvent { id: number }

/**
 * Seed both journals with the same fixture corpus so the oracle test
 * compares results across the journal-walking baseline (no tag index)
 * and the side-table override (tag index on).
 *
 * The shape mirrors PersistenceQuery.test.ts's filter corpus so the
 * cross-backend semantics line up:
 *
 *   ev | pid     | tags
 *   ---+---------+------------------------------------
 *   1  | order-1 | type:Order, tenant:t1
 *   2  | order-2 | type:Order, tenant:t2
 *   3  | order-3 | type:Order, tenant:t1, archived
 *   4  | inv-1   | type:Invoice, tenant:t1
 *   5  | inv-2   | type:Invoice, tenant:t2, archived
 *   6  | event-1 | type:Event,  tenant:t1
 */
async function seedCorpus(j: CassandraJournal): Promise<void> {
  await j.append('order-1', [{ id: 1 }], 0, ['type:Order', 'tenant:t1']);
  await sleep(2);
  await j.append('order-2', [{ id: 2 }], 0, ['type:Order', 'tenant:t2']);
  await sleep(2);
  await j.append('order-3', [{ id: 3 }], 0, ['type:Order', 'tenant:t1', 'archived']);
  await sleep(2);
  await j.append('inv-1',   [{ id: 4 }], 0, ['type:Invoice', 'tenant:t1']);
  await sleep(2);
  await j.append('inv-2',   [{ id: 5 }], 0, ['type:Invoice', 'tenant:t2', 'archived']);
  await sleep(2);
  await j.append('event-1', [{ id: 6 }], 0, ['type:Event',  'tenant:t1']);
}

const ids = (events: ReadonlyArray<{ event: { event: CorpusEvent } }>): number[] =>
  events.map((te) => te.event.event.id).sort((a, b) => a - b);

function makeJournal(useTagIndex: boolean): { journal: CassandraJournal; client: FakeCassandraClient } {
  const client = new FakeCassandraClient();
  const journal = new CassandraJournal(
    CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withAutoCreateKeyspace(true)
      .withClient(client)
      .withUseTagIndex(useTagIndex),
  );
  return { journal, client };
}

describe('CassandraJournal — useTagIndex dual-write', () => {
  test('with the index off, no `events_by_tag` rows are written', async () => {
    const { journal, client } = makeJournal(false);
    await seedCorpus(journal);
    expect(client.countRows('ks.events_by_tag')).toBe(0);
    expect(client.countRows('ks.events')).toBeGreaterThan(0);
    await journal.close();
  });

  test('with the index on, every (event, tag) pair lands in `events_by_tag`', async () => {
    const { journal, client } = makeJournal(true);
    await seedCorpus(journal);
    // 6 events, total tags = 2+2+3+2+3+2 = 14 → 14 side-table rows.
    expect(client.countRows('ks.events_by_tag')).toBe(14);
    // Primary table is unaffected — exactly one row per event.
    expect(client.countRows('ks.events')).toBe(6);
    await journal.close();
  });

  test('events without tags don\'t produce side-table rows', async () => {
    const { journal, client } = makeJournal(true);
    await journal.append('untagged', [{ id: 1 }, { id: 2 }], 0);
    expect(client.countRows('ks.events_by_tag')).toBe(0);
    expect(client.countRows('ks.events')).toBe(2);
    await journal.close();
  });

  test('tagIndexDdl returns a runnable CREATE TABLE statement', () => {
    const ddl = tagIndexDdl({ keyspace: 'app' });
    expect(ddl).toMatch(/^CREATE TABLE IF NOT EXISTS app\.events_by_tag/);
    expect(ddl).toMatch(/PRIMARY KEY \(\(tag\), timestamp, persistence_id, sequence_nr\)/);
  });
});

describe('CassandraQuery — currentEventsByTag with side-table index', () => {
  test('single-tag query: side-table result matches the journal-walking baseline', async () => {
    const { journal: indexed } = makeJournal(true);
    const { journal: baseline } = makeJournal(false);
    await seedCorpus(indexed);
    await seedCorpus(baseline);

    const indexedQ  = new CassandraQuery(indexed);
    const baselineQ = new CassandraQuery(baseline);
    const expected = await baselineQ.currentEventsByTag<CorpusEvent>('archived', offsetStart);
    const actual   = await indexedQ.currentEventsByTag<CorpusEvent>('archived', offsetStart);

    expect(ids(actual)).toEqual(ids(expected));
    expect(ids(actual)).toEqual([3, 5]);

    await indexed.close(); await baseline.close();
  });

  test('all-intersection: walks one partition + JS-refines additional tags', async () => {
    const { journal } = makeJournal(true);
    await seedCorpus(journal);
    const q = new CassandraQuery(journal);

    const orders_t1 = await q.currentEventsByTag<CorpusEvent>(
      { all: ['type:Order', 'tenant:t1'] }, offsetStart,
    );
    expect(ids(orders_t1)).toEqual([1, 3]);

    await journal.close();
  });

  test('any-union: dedupes events tagged with more than one listed value', async () => {
    const { journal } = makeJournal(true);
    await seedCorpus(journal);
    const q = new CassandraQuery(journal);

    // tenant:t1 covers {1, 3, 4, 6}; archived covers {3, 5}.  Union
    // must be {1, 3, 4, 5, 6} — event 3 (in both partitions) shows
    // up exactly once.
    const result = await q.currentEventsByTag<CorpusEvent>(
      { any: ['tenant:t1', 'archived'] }, offsetStart,
    );
    expect(ids(result)).toEqual([1, 3, 4, 5, 6]);

    await journal.close();
  });

  test('combined all+not on the side table matches the InMemory result', async () => {
    const { journal } = makeJournal(true);
    await seedCorpus(journal);
    const q = new CassandraQuery(journal);

    const live_orders = await q.currentEventsByTag<CorpusEvent>(
      { all: ['type:Order'], not: ['archived'] }, offsetStart,
    );
    expect(ids(live_orders)).toEqual([1, 2]);

    await journal.close();
  });

  test('only-not falls back to the journal-walking scan', async () => {
    // not-only queries don't have a positive tag to seed the side-
    // table walk; the fallback path must still produce the correct
    // result — same as the index-off journal would.
    const { journal: indexed } = makeJournal(true);
    const { journal: baseline } = makeJournal(false);
    await seedCorpus(indexed);
    await seedCorpus(baseline);

    const expected = await new CassandraQuery(baseline)
      .currentEventsByTag<CorpusEvent>({ not: ['archived'] }, offsetStart);
    const actual   = await new CassandraQuery(indexed)
      .currentEventsByTag<CorpusEvent>({ not: ['archived'] }, offsetStart);

    expect(ids(actual)).toEqual(ids(expected));
    expect(ids(actual)).toEqual([1, 2, 4, 6]);

    await indexed.close(); await baseline.close();
  });

  test('back-compat: bare-string filter shape still works', async () => {
    const { journal } = makeJournal(true);
    await seedCorpus(journal);
    const q = new CassandraQuery(journal);

    const single = await q.currentEventsByTag<CorpusEvent>('tenant:t1', offsetStart);
    expect(ids(single)).toEqual([1, 3, 4, 6]);

    await journal.close();
  });
});
