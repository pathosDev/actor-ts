/**
 * Tests for the optional `events_by_tag` side table populated by
 * `CassandraJournal` when `useTagIndex: true` (#44).  Every test
 * pair-runs the same workload with and without the index and asserts
 * the two `currentEventsByTag` paths return the same result set —
 * the side-table query is correct iff it agrees with the journal-
 * walking baseline (oracle pattern).
 */
import { describe, expect, test } from 'bun:test';
import { CassandraJournal } from '../../../../src/persistence/journals/CassandraJournal.js';
import { CassandraJournalOptions } from '../../../../src/persistence/journals/CassandraJournalOptions.js';
import { CassandraQuery } from '../../../../src/persistence/query/CassandraQuery.js';
import { offsetStart } from '../../../../src/persistence/query/PersistenceQuery.js';
import { tagIndexDdl } from '../../../../src/persistence/journals/CassandraClient.js';
import { FakeCassandraClient } from './FakeCassandraClient.js';
import { sleep } from '../../../util/AwaitCondition.js';

/**
 * Push the wall clock past the current millisecond, so the next append lands on
 * a strictly greater offset timestamp.
 *
 * The elapsed time *is* the fixture: `Offset` orders by millisecond timestamp
 * and the journal stamps one `Date.now()` per append, so without the gap the
 * corpus has no defined order and the oracle comparison below would be over two
 * arbitrarily ordered result sets.  Nothing to poll for — the clock is the only
 * thing being waited on (#418).
 */
const separateOffsetTimestamps = (): Promise<void> => sleep(2);

type CorpusEvent = { id: number };

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
  await j.append('order-1', [{ event: { id: 1 }, tags: ['type:Order', 'tenant:t1'] }], 0);
  await separateOffsetTimestamps();
  await j.append('order-2', [{ event: { id: 2 }, tags: ['type:Order', 'tenant:t2'] }], 0);
  await separateOffsetTimestamps();
  await j.append('order-3', [{ event: { id: 3 }, tags: ['type:Order', 'tenant:t1', 'archived'] }], 0);
  await separateOffsetTimestamps();
  await j.append('inv-1', [{ event: { id: 4 }, tags: ['type:Invoice', 'tenant:t1'] }], 0);
  await separateOffsetTimestamps();
  await j.append('inv-2', [{ event: { id: 5 }, tags: ['type:Invoice', 'tenant:t2', 'archived'] }], 0);
  await separateOffsetTimestamps();
  await j.append('event-1', [{ event: { id: 6 }, tags: ['type:Event',  'tenant:t1'] }], 0);
}

const ids = (events: ReadonlyArray<{ event: { event: CorpusEvent } }>): number[] =>
  events.map((te) => te.event.event.id).sort((a, b) => a - b);

function makeJournal(useTagIndex: boolean): { journal: CassandraJournal; client: FakeCassandraClient } {
  const client = new FakeCassandraClient();
  const journalOptions = CassandraJournalOptions.create()
    .withContactPoints(['fake'])
    .withKeyspace('ks')
    .withAutoCreateKeyspace(true)
    .withClient(client)
    .withUseTagIndex(useTagIndex);
  const journal = new CassandraJournal(journalOptions);
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
    await journal.append('untagged', [{ event: { id: 1 } }, { event: { id: 2 } }], 0);
    expect(client.countRows('ks.events_by_tag')).toBe(0);
    expect(client.countRows('ks.events')).toBe(2);
    await journal.close();
  });

  test('a mixed batch indexes each event under its OWN tags (#631)', async () => {
    const { journal, client } = makeJournal(true);
    // One atomic append, three different tag sets.  The dual-write used to
    // fan the batch's single tag list over every event, so the side table
    // held rows claiming `paymentCaptured` was tagged 'order'.
    await journal.append('checkout-1', [
      { event: { id: 1 }, tags: ['order', 'audit'] },
      { event: { id: 2 }, tags: ['payment'] },
      { event: { id: 3 } },
    ], 0);
    // 2 + 1 + 0 pairs.  Collapsing to the first event's tags would write 6.
    expect(client.countRows('ks.events_by_tag')).toBe(3);
    expect(client.countRows('ks.events')).toBe(3);

    // And the index answers by tag with exactly the right event.
    const query = new CassandraQuery(journal);
    const byPayment = await query.currentEventsByTag<CorpusEvent>({ all: ['payment'] }, offsetStart);
    expect(byPayment.map((e) => e.event.event.id)).toEqual([2]);
    const byOrder = await query.currentEventsByTag<CorpusEvent>({ all: ['order'] }, offsetStart);
    expect(byOrder.map((e) => e.event.event.id)).toEqual([1]);
    await journal.close();
  });

  test('delete compacts the side table, not just the events table (#654)', async () => {
    const { journal, client } = makeJournal(true);
    await seedCorpus(journal);
    expect(client.countRows('ks.events_by_tag')).toBe(14);

    // Compact three of the six streams away entirely.
    await journal.delete('order-1', 1);   // 2 tags
    await journal.delete('order-3', 1);   // 3 tags
    await journal.delete('inv-2', 1);     // 3 tags

    // The side table carries the FULL payload of every (event, tag) pair, so
    // a row left behind is retained data and not merely a stale index entry —
    // which is why this asserts the physical row count rather than only what
    // the query returns.  14 - (2 + 3 + 3) = 6.
    expect(client.countRows('ks.events_by_tag')).toBe(6);
    expect(client.countRows('ks.events')).toBe(3);

    // The untouched streams keep every one of their rows.
    const query = new CassandraQuery(journal);
    const remaining = await query.currentEventsByTag<CorpusEvent>({ all: ['type:Order'] }, offsetStart);
    expect(ids(remaining)).toEqual([2]);
    const stillTagged = await query.currentEventsByTag<CorpusEvent>({ all: ['tenant:t1'] }, offsetStart);
    expect(ids(stillTagged)).toEqual([4, 6]);
    await journal.close();
  });

  test('a partial delete leaves the surviving events\' tag rows alone', async () => {
    const { journal, client } = makeJournal(true);
    await journal.append('multi', [
      { event: { id: 1 }, tags: ['keep', 'drop'] },
      { event: { id: 2 }, tags: ['keep'] },
    ], 0);
    expect(client.countRows('ks.events_by_tag')).toBe(3);

    // Only the first event is compacted — the delete must reach exactly its
    // two rows and stop, which a range delete on `tag` alone could not do.
    await journal.delete('multi', 1);
    expect(client.countRows('ks.events_by_tag')).toBe(1);

    const query = new CassandraQuery(journal);
    expect(ids(await query.currentEventsByTag<CorpusEvent>('keep', offsetStart))).toEqual([2]);
    expect(await query.currentEventsByTag<CorpusEvent>('drop', offsetStart)).toEqual([]);
    await journal.close();
  });

  test('with the index off, delete touches only the events table', async () => {
    // The read-back the tag cleanup needs costs a SELECT per partition, so it
    // must not run for a journal that never dual-wrote anything.
    const { journal, client } = makeJournal(false);
    await seedCorpus(journal);
    await journal.delete('order-1', 1);
    expect(client.countRows('ks.events')).toBe(5);
    expect(client.countRows('ks.events_by_tag')).toBe(0);
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
    const query = new CassandraQuery(journal);

    const orders_t1 = await query.currentEventsByTag<CorpusEvent>(
      { all: ['type:Order', 'tenant:t1'] }, offsetStart,
    );
    expect(ids(orders_t1)).toEqual([1, 3]);

    await journal.close();
  });

  test('any-union: dedupes events tagged with more than one listed value', async () => {
    const { journal } = makeJournal(true);
    await seedCorpus(journal);
    const query = new CassandraQuery(journal);

    // tenant:t1 covers {1, 3, 4, 6}; archived covers {3, 5}.  Union
    // must be {1, 3, 4, 5, 6} — event 3 (in both partitions) shows
    // up exactly once.
    const result = await query.currentEventsByTag<CorpusEvent>(
      { any: ['tenant:t1', 'archived'] }, offsetStart,
    );
    expect(ids(result)).toEqual([1, 3, 4, 5, 6]);

    await journal.close();
  });

  test('combined all+not on the side table matches the InMemory result', async () => {
    const { journal } = makeJournal(true);
    await seedCorpus(journal);
    const query = new CassandraQuery(journal);

    const live_orders = await query.currentEventsByTag<CorpusEvent>(
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
    const query = new CassandraQuery(journal);

    const single = await query.currentEventsByTag<CorpusEvent>('tenant:t1', offsetStart);
    expect(ids(single)).toEqual([1, 3, 4, 6]);

    await journal.close();
  });
});
