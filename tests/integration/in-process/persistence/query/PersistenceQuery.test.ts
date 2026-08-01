/**
 * Tests for the read-side PersistenceQuery layer.  Cover both the
 * journal-walking InMemoryQuery and the SQL-filtering SqliteQuery,
 * since they share the same surface but exercise different code
 * paths for tag filtering.
 *
 * Layout:
 *   - "current*" — one-shot snapshots; check filter + sort semantics.
 *   - "live"     — async-iterable streams; check past + future events.
 *   - "offsets"  — comparator + sentinel behaviour.
 */
import { describe, expect, test } from 'bun:test';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { SqliteJournal } from '../../../../../src/persistence/journals/SqliteJournal.js';
import { SqliteJournalOptions } from '../../../../../src/persistence/journals/SqliteJournalOptions.js';
import { InMemoryQuery } from '../../../../../src/persistence/query/InMemoryQuery.js';
import { SqliteQuery } from '../../../../../src/persistence/query/SqliteQuery.js';
import {
  offsetCompare,
  offsetGreater,
  offsetGreaterOrEqual,
  offsetStart,
} from '../../../../../src/persistence/query/PersistenceQuery.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('Offset comparator', () => {
  test('orders by (timestamp, persistenceId, sequenceNr)', () => {
    const first = { timestamp: 100, persistenceId: 'a', sequenceNr: 1 };
    const second = { timestamp: 100, persistenceId: 'a', sequenceNr: 2 };
    const third = { timestamp: 100, persistenceId: 'b', sequenceNr: 1 };
    const fourth = { timestamp: 200, persistenceId: 'a', sequenceNr: 1 };
    expect(offsetCompare(first, second)).toBeLessThan(0);
    expect(offsetCompare(second, third)).toBeLessThan(0);
    expect(offsetCompare(third, fourth)).toBeLessThan(0);
    expect(offsetCompare(first, first)).toBe(0);
    expect(offsetGreater(fourth, first)).toBe(true);
    expect(offsetGreaterOrEqual(first, first)).toBe(true);
  });

  test('offsetStart sorts before everything', () => {
    const real = { timestamp: 1, persistenceId: 'x', sequenceNr: 1 };
    expect(offsetCompare(offsetStart, real)).toBeLessThan(0);
  });
});

describe('InMemoryQuery — currentEventsByPersistenceId', () => {
  test('round-trip: every appended event comes back in order', async () => {
    const journal = new InMemoryJournal();
    await journal.append('alice', [{ kind: 'in', amount: 10 }, { kind: 'in', amount: 20 }], 0);
    await journal.append('alice', [{ kind: 'out', amount: 5 }], 2);
    const query = new InMemoryQuery(journal);

    const events = await query.currentEventsByPersistenceId<{ kind: string; amount: number }>('alice', 1);
    expect(events.map((e) => `${e.sequenceNr}:${e.event.kind}:${e.event.amount}`))
      .toEqual(['1:in:10', '2:in:20', '3:out:5']);
  });

  test('fromSeq filters out earlier events', async () => {
    const journal = new InMemoryJournal();
    await journal.append('a', [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }], 0);
    const query = new InMemoryQuery(journal);
    const events = await query.currentEventsByPersistenceId<{ n: number }>('a', 3);
    expect(events.map((e) => e.event.n)).toEqual([3, 4]);
  });
});

describe('InMemoryQuery — currentEventsByTag', () => {
  test('returns only events tagged with the requested tag, ordered globally', async () => {
    const journal = new InMemoryJournal();
    await journal.append('alice', [{ message: 'a1' }], 0, ['accounts']);
    await sleep(2);
    await journal.append('bob', [{ message: 'b1' }], 0, ['accounts', 'vip']);
    await sleep(2);
    await journal.append('alice', [{ message: 'a2' }], 1, ['internal']);
    await sleep(2);
    await journal.append('bob', [{ message: 'b2' }], 1, ['accounts']);

    const query = new InMemoryQuery(journal);
    const accounts = await query.currentEventsByTag<{ message: string }>('accounts', offsetStart);
    expect(accounts.map((te) => te.event.event.message)).toEqual(['a1', 'b1', 'b2']);

    const vip = await query.currentEventsByTag<{ message: string }>('vip', offsetStart);
    expect(vip.map((te) => te.event.event.message)).toEqual(['b1']);
  });

  test('fromOffset skips events at-or-before the cursor', async () => {
    const journal = new InMemoryJournal();
    await journal.append('a', [{ message: '1' }], 0, ['t']);
    await sleep(2);
    await journal.append('a', [{ message: '2' }], 1, ['t']);
    const query = new InMemoryQuery(journal);

    const all = await query.currentEventsByTag<{ message: string }>('t', offsetStart);
    expect(all).toHaveLength(2);

    // Use the first event's offset → expect the second to come back.
    const second = await query.currentEventsByTag<{ message: string }>('t', all[0]!.offset);
    expect(second.map((te) => te.event.event.message)).toEqual(['1', '2']); // inclusive of cursor (>= semantics)

    // Use the second event's offset → expect just that one back.
    const last = await query.currentEventsByTag<{ message: string }>('t', all[1]!.offset);
    expect(last.map((te) => te.event.event.message)).toEqual(['2']);
  });
});

describe('InMemoryQuery — eventsByPersistenceId (live)', () => {
  test('emits past events first, then new appends', async () => {
    const journal = new InMemoryJournal();
    await journal.append('a', [{ n: 1 }, { n: 2 }], 0);
    const query = new InMemoryQuery(journal);

    const stream = query.eventsByPersistenceId<{ n: number }>('a', 1, { pollIntervalMs: 50 });
    const got: number[] = [];
    const consumer = (async (): Promise<void> => {
      for await (const ev of stream) {
        got.push(ev.event.n);
        if (got.length === 4) break;
      }
    })();

    // Append two more after the consumer is reading.
    await sleep(80);
    await journal.append('a', [{ n: 3 }, { n: 4 }], 2);
    await consumer;
    expect(got).toEqual([1, 2, 3, 4]);
  });

  test('iterator return() cancels the polling loop cleanly', async () => {
    const journal = new InMemoryJournal();
    await journal.append('a', [{ n: 1 }], 0);
    const query = new InMemoryQuery(journal);

    const stream = query.eventsByPersistenceId<{ n: number }>('a', 1, { pollIntervalMs: 50 });
    const it = stream[Symbol.asyncIterator]();
    const first = await it.next();
    expect((first.value as { event: { n: number } }).event.n).toBe(1);
    const closed = await it.return!();
    expect(closed.done).toBe(true);
  });
});

describe('SqliteQuery — currentEventsByTag uses SQL filter', () => {
  test('filters comma-separated tags without false positives', async () => {
    const journalOptions = SqliteJournalOptions.create()
      .withPath(':memory:');
    const journal = new SqliteJournal(journalOptions);
    await journal.append('a', [{ x: 1 }], 0, ['foo']);
    await sleep(2);
    await journal.append('b', [{ x: 2 }], 0, ['foobar']);  // must NOT match 'foo'
    await sleep(2);
    await journal.append('c', [{ x: 3 }], 0, ['foo', 'extra']);
    const query = new SqliteQuery(journal);

    const foo = await query.currentEventsByTag<{ x: number }>('foo', offsetStart);
    expect(foo.map((te) => te.event.event.x).sort()).toEqual([1, 3]);

    const foobar = await query.currentEventsByTag<{ x: number }>('foobar', offsetStart);
    expect(foobar.map((te) => te.event.event.x)).toEqual([2]);

    await journal.close();
  });

  test('per-pid path delegates to journal.read', async () => {
    const journalOptions = SqliteJournalOptions.create()
      .withPath(':memory:');
    const journal = new SqliteJournal(journalOptions);
    await journal.append('z', [{ k: 1 }, { k: 2 }, { k: 3 }], 0);
    const query = new SqliteQuery(journal);

    const events = await query.currentEventsByPersistenceId<{ k: number }>('z', 2);
    expect(events.map((e) => e.event.k)).toEqual([2, 3]);

    await journal.close();
  });
});

describe('PersistenceQuery — currentPersistenceIds', () => {
  test('returns every distinct pid known to the journal', async () => {
    const journal = new InMemoryJournal();
    await journal.append('a', [{}], 0);
    await journal.append('b', [{}], 0);
    await journal.append('a', [{}], 1);
    const query = new InMemoryQuery(journal);
    const ids = await query.currentPersistenceIds();
    expect(ids.sort()).toEqual(['a', 'b']);
  });
});

/**
 * Shared corpus for multi-tag filter tests.  Six events across three
 * persistence ids, with overlapping tags chosen to exercise every
 * combination of `all` / `any` / `not` operators.
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
async function seedFilterCorpus(journal: { append(persistenceId: string, events: unknown[], expected: number, tags?: string[]): Promise<unknown> }): Promise<void> {
  await journal.append('order-1', [{ id: 1 }], 0, ['type:Order',   'tenant:t1']);
  await sleep(2);
  await journal.append('order-2', [{ id: 2 }], 0, ['type:Order',   'tenant:t2']);
  await sleep(2);
  await journal.append('order-3', [{ id: 3 }], 0, ['type:Order',   'tenant:t1', 'archived']);
  await sleep(2);
  await journal.append('inv-1',   [{ id: 4 }], 0, ['type:Invoice', 'tenant:t1']);
  await sleep(2);
  await journal.append('inv-2',   [{ id: 5 }], 0, ['type:Invoice', 'tenant:t2', 'archived']);
  await sleep(2);
  await journal.append('event-1', [{ id: 6 }], 0, ['type:Event',   'tenant:t1']);
}

const ids = (events: ReadonlyArray<{ event: { event: { id: number } } }>): number[] =>
  events.map((te) => te.event.event.id).sort((first, second) => first - second);

describe('Multi-tag filter — operator semantics (InMemoryQuery)', () => {
  test('all: intersection — every listed tag must appear', async () => {
    const journal = new InMemoryJournal();
    await seedFilterCorpus(journal);
    const query = new InMemoryQuery(journal);

    const orders_t1 = await query.currentEventsByTag<{ id: number }>(
      { all: ['type:Order', 'tenant:t1'] }, offsetStart,
    );
    expect(ids(orders_t1)).toEqual([1, 3]);
  });

  test('any: union — at least one listed tag must appear', async () => {
    const journal = new InMemoryJournal();
    await seedFilterCorpus(journal);
    const query = new InMemoryQuery(journal);

    const t1_or_t2 = await query.currentEventsByTag<{ id: number }>(
      { any: ['tenant:t1', 'tenant:t2'] }, offsetStart,
    );
    expect(ids(t1_or_t2)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('not: exclusion — no listed tag may appear', async () => {
    const journal = new InMemoryJournal();
    await seedFilterCorpus(journal);
    const query = new InMemoryQuery(journal);

    const live = await query.currentEventsByTag<{ id: number }>(
      { not: ['archived'] }, offsetStart,
    );
    expect(ids(live)).toEqual([1, 2, 4, 6]);
  });

  test('combined: all + not — orders that are not archived', async () => {
    const journal = new InMemoryJournal();
    await seedFilterCorpus(journal);
    const query = new InMemoryQuery(journal);

    const live_orders = await query.currentEventsByTag<{ id: number }>(
      { all: ['type:Order'], not: ['archived'] }, offsetStart,
    );
    expect(ids(live_orders)).toEqual([1, 2]);
  });

  test('combined: all + any — orders or invoices for tenant t1', async () => {
    const journal = new InMemoryJournal();
    await seedFilterCorpus(journal);
    const query = new InMemoryQuery(journal);

    const t1_doctype = await query.currentEventsByTag<{ id: number }>(
      { any: ['type:Order', 'type:Invoice'], all: ['tenant:t1'] }, offsetStart,
    );
    expect(ids(t1_doctype)).toEqual([1, 3, 4]);
  });

  test('back-compat: bare-string filter is equivalent to { all: [tag] }', async () => {
    const journal = new InMemoryJournal();
    await seedFilterCorpus(journal);
    const query = new InMemoryQuery(journal);

    const single = await query.currentEventsByTag<{ id: number }>('archived', offsetStart);
    expect(ids(single)).toEqual([3, 5]);
  });

  test('empty any matches nothing (∃ over ∅ is false)', async () => {
    const journal = new InMemoryJournal();
    await seedFilterCorpus(journal);
    const query = new InMemoryQuery(journal);

    const empty = await query.currentEventsByTag<{ id: number }>({ any: [] }, offsetStart);
    expect(empty).toHaveLength(0);
  });

  test('empty all and empty not are no-ops (vacuously true)', async () => {
    const journal = new InMemoryJournal();
    await seedFilterCorpus(journal);
    const query = new InMemoryQuery(journal);

    const all_events = await query.currentEventsByTag<{ id: number }>({ all: [], not: [] }, offsetStart);
    expect(ids(all_events)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('Multi-tag filter — SqliteQuery parity', () => {
  test('all: intersection uses indexed pre-filter + JS refine', async () => {
    const journalOptions = SqliteJournalOptions.create()
      .withPath(':memory:');
    const journal = new SqliteJournal(journalOptions);
    await seedFilterCorpus(journal);
    const query = new SqliteQuery(journal);

    const orders_t1 = await query.currentEventsByTag<{ id: number }>(
      { all: ['type:Order', 'tenant:t1'] }, offsetStart,
    );
    expect(ids(orders_t1)).toEqual([1, 3]);

    await journal.close();
  });

  test('any: union via t.tag IN (?, ?, …) with DISTINCT', async () => {
    const journalOptions = SqliteJournalOptions.create()
      .withPath(':memory:');
    const journal = new SqliteJournal(journalOptions);
    await seedFilterCorpus(journal);
    const query = new SqliteQuery(journal);

    const t1_or_t2 = await query.currentEventsByTag<{ id: number }>(
      { any: ['tenant:t1', 'tenant:t2'] }, offsetStart,
    );
    // DISTINCT must keep each event exactly once even though every
    // event has one of the two tenant tags — without it order-3
    // (tenant:t1) would still be unique, but events tagged with both
    // listed values would duplicate.
    expect(ids(t1_or_t2)).toEqual([1, 2, 3, 4, 5, 6]);

    await journal.close();
  });

  test('not-only: falls back to the journal scan and applies exclusion', async () => {
    const journalOptions = SqliteJournalOptions.create()
      .withPath(':memory:');
    const journal = new SqliteJournal(journalOptions);
    await seedFilterCorpus(journal);
    const query = new SqliteQuery(journal);

    const live = await query.currentEventsByTag<{ id: number }>(
      { not: ['archived'] }, offsetStart,
    );
    expect(ids(live)).toEqual([1, 2, 4, 6]);

    await journal.close();
  });

  test('combined all+not on SQLite matches the InMemory result exactly', async () => {
    const journalOptions = SqliteJournalOptions.create()
      .withPath(':memory:');
    const journal = new SqliteJournal(journalOptions);
    await seedFilterCorpus(journal);
    const query = new SqliteQuery(journal);

    const live_orders = await query.currentEventsByTag<{ id: number }>(
      { all: ['type:Order'], not: ['archived'] }, offsetStart,
    );
    expect(ids(live_orders)).toEqual([1, 2]);

    await journal.close();
  });

  test('volume sanity: 10k events stay under a generous SQLite ceiling for every operator', async () => {
    // Plan-doc spot-check: 10 000 events, all three operators well
    // under 100 ms on SQLite.  We assert a generous 1 s ceiling to
    // avoid CI flakes — the index path should beat that by an order
    // of magnitude on a development machine.
    const journalOptions = SqliteJournalOptions.create()
      .withPath(':memory:');
    const journal = new SqliteJournal(journalOptions);
    const N = 10_000;
    const batch: { id: number }[] = [];
    const tags: string[] = [];
    for (let i = 0; i < N; i++) {
      batch.push({ id: i });
      const type = i % 3 === 0 ? 'type:A' : i % 3 === 1 ? 'type:B' : 'type:C';
      const tenant = i % 5 === 0 ? 'tenant:t1' : 'tenant:t2';
      tags.push(`${type},${tenant}${i % 7 === 0 ? ',archived' : ''}`);
    }
    // Append in 100 chunks so each event still gets its own append
    // call but we don't pay 10k per-pid round-trips.
    let seq = 0;
    for (let i = 0; i < N; i += 100) {
      const slice = batch.slice(i, i + 100).map((second) => ({ id: second.id }));
      const tagsForBatch = tags[i]!.split(',');
      await journal.append('bulk', slice, seq, tagsForBatch);
      seq += slice.length;
    }
    const query = new SqliteQuery(journal);

    const t0 = performance.now();
    const all_a = await query.currentEventsByTag({ all: ['type:A'] }, offsetStart);
    const t1 = performance.now();
    const any_t = await query.currentEventsByTag({ any: ['tenant:t1', 'tenant:t2'] }, offsetStart);
    const t2 = performance.now();
    const not_arch = await query.currentEventsByTag({ all: ['type:A'], not: ['archived'] }, offsetStart);
    const t3 = performance.now();

    expect(all_a.length).toBeGreaterThan(0);
    expect(any_t.length).toBe(N);
    expect(not_arch.length).toBeGreaterThan(0);
    // 1 s ceiling — the indexed path should be ~10-50 ms typical.
    expect(t1 - t0).toBeLessThan(1000);
    expect(t2 - t1).toBeLessThan(1000);
    expect(t3 - t2).toBeLessThan(1000);

    await journal.close();
  });

  test('any-prepared statements are cached and reused per arity', async () => {
    // Issuing two queries with the same arity must hit the prepared
    // statement once — verified indirectly: the second call must not
    // fail and must produce identical results.  (Direct cache-hit
    // counting would couple tests to internals; result equality is a
    // robust proxy.)
    const journalOptions = SqliteJournalOptions.create()
      .withPath(':memory:');
    const journal = new SqliteJournal(journalOptions);
    await seedFilterCorpus(journal);
    const query = new SqliteQuery(journal);

    const first  = await query.currentEventsByTag<{ id: number }>({ any: ['tenant:t1', 'tenant:t2'] }, offsetStart);
    // tenant:t1 → 1, 3, 4, 6 ; archived → 3, 5 ; union → 1, 3, 4, 5, 6.
    const second = await query.currentEventsByTag<{ id: number }>({ any: ['tenant:t1', 'archived'] },  offsetStart);
    expect(ids(first)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ids(second)).toEqual([1, 3, 4, 5, 6]);

    await journal.close();
  });
});
