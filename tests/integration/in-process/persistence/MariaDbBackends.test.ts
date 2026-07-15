import { describe, expect, test } from 'bun:test';
import { MariaDbJournal } from '../../../../src/persistence/journals/MariaDbJournal.js';
import { MariaDbJournalOptions } from '../../../../src/persistence/journals/MariaDbJournalOptions.js';
import { MariaDbSnapshotStore } from '../../../../src/persistence/snapshot-stores/MariaDbSnapshotStore.js';
import { MariaDbSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/MariaDbSnapshotStoreOptions.js';
import { MariaDbDurableStateStore } from '../../../../src/persistence/durable-state-stores/MariaDbDurableStateStore.js';
import { MariaDbDurableStateStoreOptions } from '../../../../src/persistence/durable-state-stores/MariaDbDurableStateStoreOptions.js';
import { JournalConcurrencyError } from '../../../../src/persistence/JournalTypes.js';
import { DurableStateConcurrencyError } from '../../../../src/persistence/DurableStateStore.js';
import { FakeMariaDbPool } from './FakeMariaDbPool.js';

/**
 * Unit-level coverage for the MariaDB backends, driven by an in-process
 * fake `mariadb` pool (see FakeMariaDbPool).  The live Docker suite
 * validates against a real mariadb:latest; this covers the SQL-flow logic
 * dependency-free and runs in the standard `bun test` pass + CI.
 */

describe('MariaDbJournal', () => {
  test('append assigns monotonic sequence numbers starting at 1', async () => {
    const journalOptions = MariaDbJournalOptions.create()
      .withPool(new FakeMariaDbPool());
    const journal = new MariaDbJournal(journalOptions);
    const out = await journal.append('acc-1', ['a', 'b', 'c'], 0);
    expect(out.map((e) => e.sequenceNr)).toEqual([1, 2, 3]);
    expect(out.map((e) => e.event)).toEqual(['a', 'b', 'c']);
  });

  test('read returns events in order with BIGINT fields coerced to number', async () => {
    const journalOptions = MariaDbJournalOptions.create()
      .withPool(new FakeMariaDbPool());
    const journal = new MariaDbJournal(journalOptions);
    await journal.append('acc-1', [{ n: 1 }, { n: 2 }], 0);
    const read = await journal.read<{ n: number }>('acc-1', 1);
    expect(read.map((e) => e.event.n)).toEqual([1, 2]);
    expect(read.every((e) => typeof e.sequenceNr === 'number')).toBe(true);
    expect(read.every((e) => typeof e.timestamp === 'number')).toBe(true);
  });

  test('read honours the inclusive toSeq upper bound', async () => {
    const journalOptions = MariaDbJournalOptions.create()
      .withPool(new FakeMariaDbPool());
    const journal = new MariaDbJournal(journalOptions);
    await journal.append('acc-1', ['a', 'b', 'c', 'd'], 0);
    const read = await journal.read('acc-1', 2, 3);
    expect(read.map((e) => e.sequenceNr)).toEqual([2, 3]);
  });

  test('concurrency mismatch throws JournalConcurrencyError', async () => {
    const journalOptions = MariaDbJournalOptions.create()
      .withPool(new FakeMariaDbPool());
    const journal = new MariaDbJournal(journalOptions);
    await journal.append('acc-1', ['a'], 0);
    await expect(journal.append('acc-1', ['b'], 0)).rejects.toBeInstanceOf(JournalConcurrencyError);
  });

  test('highestSeq reflects the latest append; 0 for unknown pid', async () => {
    const journalOptions = MariaDbJournalOptions.create()
      .withPool(new FakeMariaDbPool());
    const journal = new MariaDbJournal(journalOptions);
    expect(await journal.highestSeq('nope')).toBe(0);
    await journal.append('acc-1', ['a', 'b'], 0);
    expect(await journal.highestSeq('acc-1')).toBe(2);
  });

  test('tags round-trip and delete compacts up to toSeq', async () => {
    const journalOptions = MariaDbJournalOptions.create()
      .withPool(new FakeMariaDbPool());
    const journal = new MariaDbJournal(journalOptions);
    await journal.append('acc-1', ['a', 'b', 'c'], 0, ['t1', 't2']);
    expect((await journal.read('acc-1', 1))[0]!.tags).toEqual(['t1', 't2']);
    await journal.delete('acc-1', 2);
    expect((await journal.read('acc-1', 1)).map((e) => e.sequenceNr)).toEqual([3]);
  });

  test('persistenceIds enumerates distinct ids', async () => {
    const journalOptions = MariaDbJournalOptions.create()
      .withPool(new FakeMariaDbPool());
    const journal = new MariaDbJournal(journalOptions);
    await journal.append('acc-1', ['a'], 0);
    await journal.append('acc-2', ['a'], 0);
    expect((await journal.persistenceIds()).sort()).toEqual(['acc-1', 'acc-2']);
  });
});

describe('MariaDbSnapshotStore', () => {
  test('save then loadLatest round-trips the newest snapshot', async () => {
    const snapshotStoreOptions = MariaDbSnapshotStoreOptions.create()
      .withPool(new FakeMariaDbPool());
    const snapshotStore = new MariaDbSnapshotStore(snapshotStoreOptions);
    await snapshotStore.save('acc-1', 5, { balance: 10 });
    await snapshotStore.save('acc-1', 9, { balance: 42 });
    const latest = (await snapshotStore.loadLatest<{ balance: number }>('acc-1')).toNullable();
    expect(latest?.sequenceNr).toBe(9);
    expect(latest?.state.balance).toBe(42);
  });

  test('save twice at the same seq upserts (ON DUPLICATE KEY UPDATE)', async () => {
    const snapshotStoreOptions = MariaDbSnapshotStoreOptions.create()
      .withPool(new FakeMariaDbPool());
    const snapshotStore = new MariaDbSnapshotStore(snapshotStoreOptions);
    await snapshotStore.save('acc-1', 5, { v: 'a' });
    await snapshotStore.save('acc-1', 5, { v: 'b' });
    expect((await snapshotStore.loadLatest<{ v: string }>('acc-1')).toNullable()?.state.v).toBe('b');
  });

  test('loadBefore returns the newest snapshot strictly below seq', async () => {
    const snapshotStoreOptions = MariaDbSnapshotStoreOptions.create()
      .withPool(new FakeMariaDbPool());
    const snapshotStore = new MariaDbSnapshotStore(snapshotStoreOptions);
    await snapshotStore.save('acc-1', 3, { v: 'a' });
    await snapshotStore.save('acc-1', 7, { v: 'b' });
    expect((await snapshotStore.loadBefore<{ v: string }>('acc-1', 7)).toNullable()?.sequenceNr).toBe(3);
  });

  test('keepN prunes older snapshots on save', async () => {
    const snapshotStoreOptions = MariaDbSnapshotStoreOptions.create()
      .withPool(new FakeMariaDbPool())
      .withKeepN(2);
    const snapshotStore = new MariaDbSnapshotStore(snapshotStoreOptions);
    for (const seq of [1, 2, 3, 4]) await snapshotStore.save('acc-1', seq, { seq });
    expect((await snapshotStore.loadBefore('acc-1', 2)).toNullable()).toBeNull();   // 1 pruned
    expect((await snapshotStore.loadLatest('acc-1')).toNullable()?.sequenceNr).toBe(4);
  });
});

describe('MariaDbDurableStateStore', () => {
  test('insert at revision 0 then load', async () => {
    const durableStateStoreOptions = MariaDbDurableStateStoreOptions.create()
      .withPool(new FakeMariaDbPool());
    const durableStore = new MariaDbDurableStateStore(durableStateStoreOptions);
    expect((await durableStore.upsert('k1', 0, { count: 1 })).revision).toBe(1);
    const loaded = (await durableStore.load<{ count: number }>('k1')).toNullable();
    expect(loaded?.revision).toBe(1);
    expect(loaded?.state.count).toBe(1);
  });

  test('update bumps the revision', async () => {
    const durableStateStoreOptions = MariaDbDurableStateStoreOptions.create()
      .withPool(new FakeMariaDbPool());
    const durableStore = new MariaDbDurableStateStore(durableStateStoreOptions);
    await durableStore.upsert('k1', 0, { count: 1 });
    expect((await durableStore.upsert('k1', 1, { count: 2 })).revision).toBe(2);
    expect((await durableStore.load<{ count: number }>('k1')).toNullable()?.state.count).toBe(2);
  });

  test('stale expectedRevision throws DurableStateConcurrencyError with actual', async () => {
    const durableStateStoreOptions = MariaDbDurableStateStoreOptions.create()
      .withPool(new FakeMariaDbPool());
    const durableStore = new MariaDbDurableStateStore(durableStateStoreOptions);
    await durableStore.upsert('k1', 0, { v: 'a' });
    await durableStore.upsert('k1', 1, { v: 'b' });
    await expect(durableStore.upsert('k1', 1, { v: 'c' })).rejects.toMatchObject({
      name: 'DurableStateConcurrencyError',
      expected: 1,
      actual: 2,
    });
  });

  test('re-insert at revision 0 on an existing key conflicts (ER_DUP_ENTRY)', async () => {
    const durableStateStoreOptions = MariaDbDurableStateStoreOptions.create()
      .withPool(new FakeMariaDbPool());
    const durableStore = new MariaDbDurableStateStore(durableStateStoreOptions);
    await durableStore.upsert('k1', 0, { v: 'a' });
    await expect(durableStore.upsert('k1', 0, { v: 'dup' })).rejects.toBeInstanceOf(DurableStateConcurrencyError);
  });

  test('delete removes the record', async () => {
    const durableStateStoreOptions = MariaDbDurableStateStoreOptions.create()
      .withPool(new FakeMariaDbPool());
    const durableStore = new MariaDbDurableStateStore(durableStateStoreOptions);
    await durableStore.upsert('k1', 0, { v: 'a' });
    await durableStore.delete('k1');
    expect((await durableStore.load('k1')).toNullable()).toBeNull();
  });
});
