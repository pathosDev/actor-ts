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
import { InMemoryJournal } from '../../../../src/persistence/journals/InMemoryJournal.js';
import { SqliteJournal } from '../../../../src/persistence/journals/SqliteJournal.js';
import { InMemoryQuery } from '../../../../src/persistence/query/InMemoryQuery.js';
import { SqliteQuery } from '../../../../src/persistence/query/SqliteQuery.js';
import {
  offsetCompare,
  offsetGreater,
  offsetGreaterOrEqual,
  offsetStart,
} from '../../../../src/persistence/query/PersistenceQuery.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('Offset comparator', () => {
  test('orders by (timestamp, persistenceId, sequenceNr)', () => {
    const a = { timestamp: 100, persistenceId: 'a', sequenceNr: 1 };
    const b = { timestamp: 100, persistenceId: 'a', sequenceNr: 2 };
    const c = { timestamp: 100, persistenceId: 'b', sequenceNr: 1 };
    const d = { timestamp: 200, persistenceId: 'a', sequenceNr: 1 };
    expect(offsetCompare(a, b)).toBeLessThan(0);
    expect(offsetCompare(b, c)).toBeLessThan(0);
    expect(offsetCompare(c, d)).toBeLessThan(0);
    expect(offsetCompare(a, a)).toBe(0);
    expect(offsetGreater(d, a)).toBe(true);
    expect(offsetGreaterOrEqual(a, a)).toBe(true);
  });

  test('offsetStart sorts before everything', () => {
    const real = { timestamp: 1, persistenceId: 'x', sequenceNr: 1 };
    expect(offsetCompare(offsetStart, real)).toBeLessThan(0);
  });
});

describe('InMemoryQuery — currentEventsByPersistenceId', () => {
  test('round-trip: every appended event comes back in order', async () => {
    const j = new InMemoryJournal();
    await j.append('alice', [{ kind: 'in', amount: 10 }, { kind: 'in', amount: 20 }], 0);
    await j.append('alice', [{ kind: 'out', amount: 5 }], 2);
    const q = new InMemoryQuery(j);

    const events = await q.currentEventsByPersistenceId<{ kind: string; amount: number }>('alice', 1);
    expect(events.map((e) => `${e.sequenceNr}:${e.event.kind}:${e.event.amount}`))
      .toEqual(['1:in:10', '2:in:20', '3:out:5']);
  });

  test('fromSeq filters out earlier events', async () => {
    const j = new InMemoryJournal();
    await j.append('a', [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }], 0);
    const q = new InMemoryQuery(j);
    const events = await q.currentEventsByPersistenceId<{ n: number }>('a', 3);
    expect(events.map((e) => e.event.n)).toEqual([3, 4]);
  });
});

describe('InMemoryQuery — currentEventsByTag', () => {
  test('returns only events tagged with the requested tag, ordered globally', async () => {
    const j = new InMemoryJournal();
    await j.append('alice', [{ msg: 'a1' }], 0, ['accounts']);
    await sleep(2);
    await j.append('bob', [{ msg: 'b1' }], 0, ['accounts', 'vip']);
    await sleep(2);
    await j.append('alice', [{ msg: 'a2' }], 1, ['internal']);
    await sleep(2);
    await j.append('bob', [{ msg: 'b2' }], 1, ['accounts']);

    const q = new InMemoryQuery(j);
    const accounts = await q.currentEventsByTag<{ msg: string }>('accounts', offsetStart);
    expect(accounts.map((te) => te.event.event.msg)).toEqual(['a1', 'b1', 'b2']);

    const vip = await q.currentEventsByTag<{ msg: string }>('vip', offsetStart);
    expect(vip.map((te) => te.event.event.msg)).toEqual(['b1']);
  });

  test('fromOffset skips events at-or-before the cursor', async () => {
    const j = new InMemoryJournal();
    await j.append('a', [{ msg: '1' }], 0, ['t']);
    await sleep(2);
    await j.append('a', [{ msg: '2' }], 1, ['t']);
    const q = new InMemoryQuery(j);

    const all = await q.currentEventsByTag<{ msg: string }>('t', offsetStart);
    expect(all).toHaveLength(2);

    // Use the first event's offset → expect the second to come back.
    const second = await q.currentEventsByTag<{ msg: string }>('t', all[0]!.offset);
    expect(second.map((te) => te.event.event.msg)).toEqual(['1', '2']); // inclusive of cursor (>= semantics)

    // Use the second event's offset → expect just that one back.
    const last = await q.currentEventsByTag<{ msg: string }>('t', all[1]!.offset);
    expect(last.map((te) => te.event.event.msg)).toEqual(['2']);
  });
});

describe('InMemoryQuery — eventsByPersistenceId (live)', () => {
  test('emits past events first, then new appends', async () => {
    const j = new InMemoryJournal();
    await j.append('a', [{ n: 1 }, { n: 2 }], 0);
    const q = new InMemoryQuery(j);

    const stream = q.eventsByPersistenceId<{ n: number }>('a', 1, { pollIntervalMs: 50 });
    const got: number[] = [];
    const consumer = (async (): Promise<void> => {
      for await (const ev of stream) {
        got.push(ev.event.n);
        if (got.length === 4) break;
      }
    })();

    // Append two more after the consumer is reading.
    await sleep(80);
    await j.append('a', [{ n: 3 }, { n: 4 }], 2);
    await consumer;
    expect(got).toEqual([1, 2, 3, 4]);
  });

  test('iterator return() cancels the polling loop cleanly', async () => {
    const j = new InMemoryJournal();
    await j.append('a', [{ n: 1 }], 0);
    const q = new InMemoryQuery(j);

    const stream = q.eventsByPersistenceId<{ n: number }>('a', 1, { pollIntervalMs: 50 });
    const it = stream[Symbol.asyncIterator]();
    const first = await it.next();
    expect((first.value as { event: { n: number } }).event.n).toBe(1);
    const closed = await it.return!();
    expect(closed.done).toBe(true);
  });
});

describe('SqliteQuery — currentEventsByTag uses SQL filter', () => {
  test('filters comma-separated tags without false positives', async () => {
    const j = new SqliteJournal({ path: ':memory:' });
    await j.append('a', [{ x: 1 }], 0, ['foo']);
    await sleep(2);
    await j.append('b', [{ x: 2 }], 0, ['foobar']);  // must NOT match 'foo'
    await sleep(2);
    await j.append('c', [{ x: 3 }], 0, ['foo', 'extra']);
    const q = new SqliteQuery(j);

    const foo = await q.currentEventsByTag<{ x: number }>('foo', offsetStart);
    expect(foo.map((te) => te.event.event.x).sort()).toEqual([1, 3]);

    const foobar = await q.currentEventsByTag<{ x: number }>('foobar', offsetStart);
    expect(foobar.map((te) => te.event.event.x)).toEqual([2]);

    await j.close();
  });

  test('per-pid path delegates to journal.read', async () => {
    const j = new SqliteJournal({ path: ':memory:' });
    await j.append('z', [{ k: 1 }, { k: 2 }, { k: 3 }], 0);
    const q = new SqliteQuery(j);

    const events = await q.currentEventsByPersistenceId<{ k: number }>('z', 2);
    expect(events.map((e) => e.event.k)).toEqual([2, 3]);

    await j.close();
  });
});

describe('PersistenceQuery — currentPersistenceIds', () => {
  test('returns every distinct pid known to the journal', async () => {
    const j = new InMemoryJournal();
    await j.append('a', [{}], 0);
    await j.append('b', [{}], 0);
    await j.append('a', [{}], 1);
    const q = new InMemoryQuery(j);
    const ids = await q.currentPersistenceIds();
    expect(ids.sort()).toEqual(['a', 'b']);
  });
});
