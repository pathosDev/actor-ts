import { afterEach, describe, expect, test } from 'bun:test';
import { SqliteJournal } from '../../../../src/persistence/journals/SqliteJournal.js';
import { SqliteJournalOptions } from '../../../../src/persistence/journals/SqliteJournalOptions.js';
import { JournalConcurrencyError } from '../../../../src/persistence/JournalTypes.js';
import { SqliteSnapshotStore } from '../../../../src/persistence/snapshot-stores/SqliteSnapshotStore.js';
import { SqliteSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/SqliteSnapshotStoreOptions.js';

/** Journals and snapshot stores we create per test, auto-closed after. */
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.shift()!();
});

function newJournal(): SqliteJournal {
  const sqliteJournalOptions = SqliteJournalOptions.create()
    .withPath(':memory:');
  const journal = new SqliteJournal(sqliteJournalOptions);
  cleanups.push(() => journal.close());
  return journal;
}

function newSnapshots(): SqliteSnapshotStore {
  const sqliteSnapshotStoreOptions = SqliteSnapshotStoreOptions.create()
    .withPath(':memory:');
  const snapshotStore = new SqliteSnapshotStore(sqliteSnapshotStoreOptions);
  cleanups.push(() => snapshotStore.close());
  return snapshotStore;
}

describe('SqliteJournal', () => {
  test('append + read round-trips structured events', async () => {
    const journal = newJournal();
    await journal.append('acct-1', [{ kind: 'deposited', amount: 100 }], 0);
    await journal.append('acct-1', [{ kind: 'withdrew', amount: 30 }], 1);
    const events = await journal.read<{ kind: string; amount: number }>('acct-1', 1);
    expect(events.length).toBe(2);
    expect(events[0]!.event.kind).toBe('deposited');
    expect(events[1]!.event.amount).toBe(30);
  });

  test('assigns monotonic sequence numbers per persistenceId', async () => {
    const journal = newJournal();
    await journal.append('a', ['x', 'y'], 0);
    await journal.append('b', ['z'], 0);
    expect(await journal.highestSeq('a')).toBe(2);
    expect(await journal.highestSeq('b')).toBe(1);
  });

  test('concurrency mismatch throws and does not write partial rows', async () => {
    const journal = newJournal();
    await journal.append('p', ['first'], 0);
    await expect(journal.append('p', ['bad'], 0)).rejects.toBeInstanceOf(JournalConcurrencyError);
    const events = await journal.read('p', 1);
    expect(events.length).toBe(1);
  });

  test('tags round-trip through CSV encoding', async () => {
    const journal = newJournal();
    await journal.append('p', ['e1', 'e2'], 0, ['orders', 'vip']);
    const events = await journal.read('p', 1);
    for (const e of events) expect([...(e.tags ?? [])]).toEqual(['orders', 'vip']);
  });

  test('read range is inclusive on both ends', async () => {
    const journal = newJournal();
    await journal.append('p', ['a', 'b', 'c', 'd'], 0);
    const slice = await journal.read('p', 2, 3);
    expect(slice.map(e => e.event)).toEqual(['b', 'c']);
  });

  test('delete removes events up to and including toSeq', async () => {
    const journal = newJournal();
    await journal.append('p', ['a', 'b', 'c'], 0);
    await journal.delete('p', 2);
    const rest = await journal.read('p', 1);
    expect(rest.map(e => e.event)).toEqual(['c']);
  });

  test('persistenceIds lists distinct streams', async () => {
    const journal = newJournal();
    await journal.append('a', ['x'], 0);
    await journal.append('b', ['y'], 0);
    expect((await journal.persistenceIds()).sort()).toEqual(['a', 'b']);
  });

  test('survives close with clear error afterwards', async () => {
    const sqliteJournalOptions = SqliteJournalOptions.create()
      .withPath(':memory:');
    const journal = new SqliteJournal(sqliteJournalOptions);
    await journal.append('p', ['x'], 0);
    await journal.close();
    await expect(journal.highestSeq('p')).rejects.toThrow(/closed/);
  });
});

describe('SqliteSnapshotStore', () => {
  test('saves + loads latest', async () => {
    const snapshotStore = newSnapshots();
    await snapshotStore.save('p', 5, { balance: 10 });
    await snapshotStore.save('p', 8, { balance: 20 });
    const latest = (await snapshotStore.loadLatest<{ balance: number }>('p')).toNullable();
    expect(latest?.sequenceNr).toBe(8);
    expect(latest?.state.balance).toBe(20);
  });

  test('loadBefore picks the right snapshot', async () => {
    const snapshotStore = newSnapshots();
    await snapshotStore.save('p', 1, 'a'); await snapshotStore.save('p', 4, 'b'); await snapshotStore.save('p', 8, 'c');
    expect((await snapshotStore.loadBefore('p', 5)).toNullable()?.sequenceNr).toBe(4);
  });

  test('keepN prunes older snapshots automatically', async () => {
    const sqliteSnapshotStoreOptions = SqliteSnapshotStoreOptions.create()
      .withPath(':memory:')
      .withKeepN(2);
    const snapshotStore = new SqliteSnapshotStore(sqliteSnapshotStoreOptions);
    cleanups.push(() => snapshotStore.close());
    await snapshotStore.save('p', 1, {}); await snapshotStore.save('p', 2, {}); await snapshotStore.save('p', 3, {});
    const before4 = await snapshotStore.loadBefore('p', 4);
    const before3 = await snapshotStore.loadBefore('p', 3);
    const before2 = await snapshotStore.loadBefore('p', 2);
    expect(before4.toNullable()?.sequenceNr).toBe(3);
    expect(before3.toNullable()?.sequenceNr).toBe(2);
    // Seq 1 got pruned because keepN=2.
    expect(before2.isNone()).toBe(true);
  });

  test('delete removes snapshots up to toSeq', async () => {
    const snapshotStore = newSnapshots();
    await snapshotStore.save('p', 1, {}); await snapshotStore.save('p', 2, {});
    await snapshotStore.delete('p', 1);
    expect((await snapshotStore.loadLatest('p')).toNullable()?.sequenceNr).toBe(2);
    expect((await snapshotStore.loadBefore('p', 2)).isNone()).toBe(true);
  });
});
