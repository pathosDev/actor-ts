import { describe, expect, test } from 'bun:test';
import { InMemoryJournal } from '../../../../src/persistence/journals/InMemoryJournal.js';
import { JournalConcurrencyError } from '../../../../src/persistence/JournalTypes.js';

describe('InMemoryJournal.append', () => {
  test('assigns monotonic sequence numbers starting at 1', async () => {
    const j = new InMemoryJournal();
    const out = await j.append('p', [{ event: 'a' }, { event: 'b' }, { event: 'c' }], 0);
    expect(out.map(event => event.sequenceNr)).toEqual([1, 2, 3]);
    expect(out.map(event => event.event)).toEqual(['a', 'b', 'c']);
    expect(out.every(event => event.persistenceId === 'p')).toBe(true);
  });

  test('continues sequence across batches', async () => {
    const j = new InMemoryJournal();
    await j.append('p', [{ event: 'a' }], 0);
    const out = await j.append('p', [{ event: 'b' }, { event: 'c' }], 1);
    expect(out.map(event => event.sequenceNr)).toEqual([2, 3]);
  });

  test('different persistenceIds have independent streams', async () => {
    const j = new InMemoryJournal();
    await j.append('a', [{ event: 'x' }], 0);
    await j.append('b', [{ event: 'y' }, { event: 'z' }], 0);
    expect(await j.highestSeq('a')).toBe(1);
    expect(await j.highestSeq('b')).toBe(2);
  });

  test('concurrency mismatch throws JournalConcurrencyError', async () => {
    const j = new InMemoryJournal();
    await j.append('p', [{ event: 'a' }], 0);
    await expect(j.append('p', [{ event: 'b' }], 0)).rejects.toBeInstanceOf(JournalConcurrencyError);
  });

  test('each event of the batch keeps its own tags', async () => {
    // Tags belong to an event, not to the append that carried it (#631):
    // a batch used to be stamped with one list, so `b` came back tagged
    // `orders,vip` and `archived` was lost.
    const j = new InMemoryJournal();
    const out = await j.append('p', [
      { event: 'a', tags: ['orders', 'vip'] },
      { event: 'b', tags: ['archived'] },
      { event: 'c' },
    ], 0);
    expect(out.map((event) => event.tags)).toEqual([['orders', 'vip'], ['archived'], undefined]);
    const read = await j.read('p', 1);
    expect(read.map((event) => event.tags)).toEqual([['orders', 'vip'], ['archived'], undefined]);
  });

  test('empty batch is a no-op but still honours the seq contract', async () => {
    const j = new InMemoryJournal();
    const out = await j.append('p', [], 0);
    expect(out).toEqual([]);
    expect(await j.highestSeq('p')).toBe(0);
  });
});

describe('InMemoryJournal.read', () => {
  test('returns events in ascending seq', async () => {
    const j = new InMemoryJournal();
    await j.append('p', [{ event: 'a' }, { event: 'b' }, { event: 'c' }, { event: 'd' }], 0);
    const out = await j.read('p', 1);
    expect(out.map(event => event.event)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('respects fromSeq and toSeq (inclusive)', async () => {
    const j = new InMemoryJournal();
    await j.append('p', [{ event: 'a' }, { event: 'b' }, { event: 'c' }, { event: 'd' }], 0);
    const out = await j.read('p', 2, 3);
    expect(out.map(event => event.event)).toEqual(['b', 'c']);
  });

  test('empty for unknown pid', async () => {
    const j = new InMemoryJournal();
    expect(await j.read('nope', 1)).toEqual([]);
  });

  test('empty when fromSeq > highest', async () => {
    const j = new InMemoryJournal();
    await j.append('p', [{ event: 'a' }], 0);
    expect(await j.read('p', 10)).toEqual([]);
  });
});

describe('InMemoryJournal.highestSeq', () => {
  test('returns 0 for unknown pid', async () => {
    expect(await new InMemoryJournal().highestSeq('nope')).toBe(0);
  });

  test('matches last-appended seq', async () => {
    const j = new InMemoryJournal();
    await j.append('p', [{ event: 'a' }, { event: 'b' }, { event: 'c' }], 0);
    expect(await j.highestSeq('p')).toBe(3);
  });
});

describe('InMemoryJournal.delete', () => {
  test('removes events up to and including toSeq', async () => {
    const j = new InMemoryJournal();
    await j.append('p', [{ event: 'a' }, { event: 'b' }, { event: 'c' }, { event: 'd' }], 0);
    await j.delete('p', 2);
    const rest = await j.read('p', 1);
    expect(rest.map(event => event.event)).toEqual(['c', 'd']);
  });

  test('highestSeq is unchanged after delete (continuous numbering)', async () => {
    // Compaction deletes old events but sequence numbers don't rewind.
    const j = new InMemoryJournal();
    await j.append('p', [{ event: 'a' }, { event: 'b' }, { event: 'c' }], 0);
    await j.delete('p', 2);
    expect(await j.highestSeq('p')).toBe(3);
  });

  test('no-op for unknown pid', async () => {
    const j = new InMemoryJournal();
    await expect(j.delete('nope', 5)).resolves.toBeUndefined();
  });
});

describe('InMemoryJournal.append — empty batch', () => {
  test('is a no-op and does not run the concurrency check', async () => {
    const j = new InMemoryJournal();
    await j.append('p', [{ event: 'a' }, { event: 'b' }], 0);
    // Nothing is written, so there is nothing to conflict over — matches the
    // SQLite / Cassandra / relational journals, which all return early.
    expect(await j.append('p', [], 0)).toEqual([]);
    expect(await j.highestSeq('p')).toBe(2);
    expect((await j.read('p', 1)).length).toBe(2);
  });

  test('leaves an untouched pid unknown', async () => {
    const j = new InMemoryJournal();
    expect(await j.append('fresh', [], 0)).toEqual([]);
    expect(await j.highestSeq('fresh')).toBe(0);
  });
});

describe('InMemoryJournal.persistenceIds + close', () => {
  test('persistenceIds lists all streams', async () => {
    const j = new InMemoryJournal();
    await j.append('a', [{ event: 1 }], 0); await j.append('b', [{ event: 2 }], 0); await j.append('c', [{ event: 3 }], 0);
    expect((await j.persistenceIds()).sort()).toEqual(['a', 'b', 'c']);
  });

  test('close clears everything', async () => {
    const j = new InMemoryJournal();
    await j.append('p', [{ event: 'x' }], 0);
    await j.close();
    expect(await j.highestSeq('p')).toBe(0);
    expect(await j.persistenceIds()).toEqual([]);
  });
});
