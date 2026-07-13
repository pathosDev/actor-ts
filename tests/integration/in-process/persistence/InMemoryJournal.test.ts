import { describe, expect, test } from 'bun:test';
import { InMemoryJournal } from '../../../../src/persistence/journals/InMemoryJournal.js';
import { JournalConcurrencyError } from '../../../../src/persistence/JournalTypes.js';

describe('InMemoryJournal.append', () => {
  test('assigns monotonic sequence numbers starting at 1', async () => {
    const j = new InMemoryJournal();
    const out = await j.append('p', ['a', 'b', 'c'], 0);
    expect(out.map(event => event.sequenceNr)).toEqual([1, 2, 3]);
    expect(out.map(event => event.event)).toEqual(['a', 'b', 'c']);
    expect(out.every(event => event.persistenceId === 'p')).toBe(true);
  });

  test('continues sequence across batches', async () => {
    const j = new InMemoryJournal();
    await j.append('p', ['a'], 0);
    const out = await j.append('p', ['b', 'c'], 1);
    expect(out.map(event => event.sequenceNr)).toEqual([2, 3]);
  });

  test('different persistenceIds have independent streams', async () => {
    const j = new InMemoryJournal();
    await j.append('a', ['x'], 0);
    await j.append('b', ['y', 'z'], 0);
    expect(await j.highestSeq('a')).toBe(1);
    expect(await j.highestSeq('b')).toBe(2);
  });

  test('concurrency mismatch throws JournalConcurrencyError', async () => {
    const j = new InMemoryJournal();
    await j.append('p', ['a'], 0);
    await expect(j.append('p', ['b'], 0)).rejects.toBeInstanceOf(JournalConcurrencyError);
  });

  test('optional tags are attached to every event in the batch', async () => {
    const j = new InMemoryJournal();
    const out = await j.append('p', ['a', 'b'], 0, ['orders', 'vip']);
    for (const event of out) expect([...(event.tags ?? [])]).toEqual(['orders', 'vip']);
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
    await j.append('p', ['a', 'b', 'c', 'd'], 0);
    const out = await j.read('p', 1);
    expect(out.map(event => event.event)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('respects fromSeq and toSeq (inclusive)', async () => {
    const j = new InMemoryJournal();
    await j.append('p', ['a', 'b', 'c', 'd'], 0);
    const out = await j.read('p', 2, 3);
    expect(out.map(event => event.event)).toEqual(['b', 'c']);
  });

  test('empty for unknown pid', async () => {
    const j = new InMemoryJournal();
    expect(await j.read('nope', 1)).toEqual([]);
  });

  test('empty when fromSeq > highest', async () => {
    const j = new InMemoryJournal();
    await j.append('p', ['a'], 0);
    expect(await j.read('p', 10)).toEqual([]);
  });
});

describe('InMemoryJournal.highestSeq', () => {
  test('returns 0 for unknown pid', async () => {
    expect(await new InMemoryJournal().highestSeq('nope')).toBe(0);
  });

  test('matches last-appended seq', async () => {
    const j = new InMemoryJournal();
    await j.append('p', ['a', 'b', 'c'], 0);
    expect(await j.highestSeq('p')).toBe(3);
  });
});

describe('InMemoryJournal.delete', () => {
  test('removes events up to and including toSeq', async () => {
    const j = new InMemoryJournal();
    await j.append('p', ['a', 'b', 'c', 'd'], 0);
    await j.delete('p', 2);
    const rest = await j.read('p', 1);
    expect(rest.map(event => event.event)).toEqual(['c', 'd']);
  });

  test('highestSeq is unchanged after delete (continuous numbering)', async () => {
    // Compaction deletes old events but sequence numbers don't rewind.
    const j = new InMemoryJournal();
    await j.append('p', ['a', 'b', 'c'], 0);
    await j.delete('p', 2);
    expect(await j.highestSeq('p')).toBe(3);
  });

  test('no-op for unknown pid', async () => {
    const j = new InMemoryJournal();
    await expect(j.delete('nope', 5)).resolves.toBeUndefined();
  });
});

describe('InMemoryJournal.persistenceIds + close', () => {
  test('persistenceIds lists all streams', async () => {
    const j = new InMemoryJournal();
    await j.append('a', [1], 0); await j.append('b', [2], 0); await j.append('c', [3], 0);
    expect((await j.persistenceIds()).sort()).toEqual(['a', 'b', 'c']);
  });

  test('close clears everything', async () => {
    const j = new InMemoryJournal();
    await j.append('p', ['x'], 0);
    await j.close();
    expect(await j.highestSeq('p')).toBe(0);
    expect(await j.persistenceIds()).toEqual([]);
  });
});
