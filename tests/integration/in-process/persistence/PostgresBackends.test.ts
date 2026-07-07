import { describe, expect, test } from 'bun:test';
import { PostgresJournal } from '../../../../src/persistence/journals/PostgresJournal.js';
import { PostgresJournalOptions } from '../../../../src/persistence/journals/PostgresJournalOptions.js';
import { PostgresSnapshotStore } from '../../../../src/persistence/snapshot-stores/PostgresSnapshotStore.js';
import { PostgresSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/PostgresSnapshotStoreOptions.js';
import { PostgresDurableStateStore } from '../../../../src/persistence/durable-state-stores/PostgresDurableStateStore.js';
import { PostgresDurableStateStoreOptions } from '../../../../src/persistence/durable-state-stores/PostgresDurableStateStoreOptions.js';
import { JournalConcurrencyError } from '../../../../src/persistence/JournalTypes.js';
import { DurableStateConcurrencyError } from '../../../../src/persistence/DurableStateStore.js';
import { FakePgPool } from './FakePgPool.js';

/**
 * Unit-level coverage for the Postgres backends, driven by an in-process
 * fake `pg` pool (see FakePgPool).  The live Docker suite validates against
 * a real postgres:latest; this covers the SQL-flow logic dependency-free
 * and runs in the standard `bun test` pass + CI.
 */

describe('PostgresJournal', () => {
  test('append assigns monotonic sequence numbers starting at 1', async () => {
    const journalOptions = PostgresJournalOptions.create()
      .withPool(new FakePgPool());
    const j = new PostgresJournal(journalOptions);
    const out = await j.append('acc-1', ['a', 'b', 'c'], 0);
    expect(out.map((e) => e.sequenceNr)).toEqual([1, 2, 3]);
    expect(out.map((e) => e.event)).toEqual(['a', 'b', 'c']);
  });

  test('read returns events in order with coerced numeric fields', async () => {
    const journalOptions = PostgresJournalOptions.create()
      .withPool(new FakePgPool());
    const j = new PostgresJournal(journalOptions);
    await j.append('acc-1', [{ n: 1 }, { n: 2 }], 0);
    const read = await j.read<{ n: number }>('acc-1', 1);
    expect(read.map((e) => e.event.n)).toEqual([1, 2]);
    // BIGINT columns come back as strings from pg — backend must coerce.
    expect(read.every((e) => typeof e.sequenceNr === 'number')).toBe(true);
    expect(read.every((e) => typeof e.timestamp === 'number')).toBe(true);
  });

  test('read honours the inclusive toSeq upper bound', async () => {
    const journalOptions = PostgresJournalOptions.create()
      .withPool(new FakePgPool());
    const j = new PostgresJournal(journalOptions);
    await j.append('acc-1', ['a', 'b', 'c', 'd'], 0);
    const read = await j.read('acc-1', 2, 3);
    expect(read.map((e) => e.sequenceNr)).toEqual([2, 3]);
  });

  test('concurrency mismatch throws JournalConcurrencyError', async () => {
    const journalOptions = PostgresJournalOptions.create()
      .withPool(new FakePgPool());
    const j = new PostgresJournal(journalOptions);
    await j.append('acc-1', ['a'], 0);
    await expect(j.append('acc-1', ['b'], 0)).rejects.toBeInstanceOf(JournalConcurrencyError);
  });

  test('highestSeq reflects the latest append; 0 for unknown pid', async () => {
    const journalOptions = PostgresJournalOptions.create()
      .withPool(new FakePgPool());
    const j = new PostgresJournal(journalOptions);
    expect(await j.highestSeq('nope')).toBe(0);
    await j.append('acc-1', ['a', 'b'], 0);
    expect(await j.highestSeq('acc-1')).toBe(2);
  });

  test('tags round-trip and delete compacts up to toSeq', async () => {
    const journalOptions = PostgresJournalOptions.create()
      .withPool(new FakePgPool());
    const j = new PostgresJournal(journalOptions);
    await j.append('acc-1', ['a', 'b', 'c'], 0, ['t1', 't2']);
    const read = await j.read('acc-1', 1);
    expect(read[0]!.tags).toEqual(['t1', 't2']);
    await j.delete('acc-1', 2);
    expect((await j.read('acc-1', 1)).map((e) => e.sequenceNr)).toEqual([3]);
  });

  test('persistenceIds enumerates distinct ids', async () => {
    const journalOptions = PostgresJournalOptions.create()
      .withPool(new FakePgPool());
    const j = new PostgresJournal(journalOptions);
    await j.append('acc-1', ['a'], 0);
    await j.append('acc-2', ['a'], 0);
    await j.append('acc-1', ['b'], 1);
    expect((await j.persistenceIds()).sort()).toEqual(['acc-1', 'acc-2']);
  });
});

describe('PostgresSnapshotStore', () => {
  test('save then loadLatest round-trips the newest snapshot', async () => {
    const snapshotStoreOptions = PostgresSnapshotStoreOptions.create()
      .withPool(new FakePgPool());
    const s = new PostgresSnapshotStore(snapshotStoreOptions);
    await s.save('acc-1', 5, { balance: 10 });
    await s.save('acc-1', 9, { balance: 42 });
    const latest = (await s.loadLatest<{ balance: number }>('acc-1')).toNullable();
    expect(latest?.sequenceNr).toBe(9);
    expect(latest?.state.balance).toBe(42);
  });

  test('loadBefore returns the newest snapshot strictly below seq', async () => {
    const snapshotStoreOptions = PostgresSnapshotStoreOptions.create()
      .withPool(new FakePgPool());
    const s = new PostgresSnapshotStore(snapshotStoreOptions);
    await s.save('acc-1', 3, { v: 'a' });
    await s.save('acc-1', 7, { v: 'b' });
    const before = (await s.loadBefore<{ v: string }>('acc-1', 7)).toNullable();
    expect(before?.sequenceNr).toBe(3);
  });

  test('keepN prunes older snapshots on save', async () => {
    const snapshotStoreOptions = PostgresSnapshotStoreOptions.create()
      .withPool(new FakePgPool())
      .withKeepN(2);
    const s = new PostgresSnapshotStore(snapshotStoreOptions);
    for (const seq of [1, 2, 3, 4]) await s.save('acc-1', seq, { seq });
    expect((await s.loadBefore('acc-1', 2)).toNullable()).toBeNull();   // 1 pruned
    expect((await s.loadLatest('acc-1')).toNullable()?.sequenceNr).toBe(4);
  });

  test('loadLatest is None for unknown pid', async () => {
    const snapshotStoreOptions = PostgresSnapshotStoreOptions.create()
      .withPool(new FakePgPool());
    const s = new PostgresSnapshotStore(snapshotStoreOptions);
    expect((await s.loadLatest('nope')).toNullable()).toBeNull();
  });
});

describe('PostgresDurableStateStore', () => {
  test('insert at revision 0 then load', async () => {
    const durableStateStoreOptions = PostgresDurableStateStoreOptions.create()
      .withPool(new FakePgPool());
    const d = new PostgresDurableStateStore(durableStateStoreOptions);
    const rec = await d.upsert('k1', 0, { count: 1 });
    expect(rec.revision).toBe(1);
    const loaded = (await d.load<{ count: number }>('k1')).toNullable();
    expect(loaded?.revision).toBe(1);
    expect(loaded?.state.count).toBe(1);
  });

  test('update bumps the revision', async () => {
    const durableStateStoreOptions = PostgresDurableStateStoreOptions.create()
      .withPool(new FakePgPool());
    const d = new PostgresDurableStateStore(durableStateStoreOptions);
    await d.upsert('k1', 0, { count: 1 });
    const rec = await d.upsert('k1', 1, { count: 2 });
    expect(rec.revision).toBe(2);
    expect((await d.load<{ count: number }>('k1')).toNullable()?.state.count).toBe(2);
  });

  test('stale expectedRevision throws DurableStateConcurrencyError with actual', async () => {
    const durableStateStoreOptions = PostgresDurableStateStoreOptions.create()
      .withPool(new FakePgPool());
    const d = new PostgresDurableStateStore(durableStateStoreOptions);
    await d.upsert('k1', 0, { v: 'a' });   // rev 1
    await d.upsert('k1', 1, { v: 'b' });   // rev 2
    await expect(d.upsert('k1', 1, { v: 'c' })).rejects.toMatchObject({
      name: 'DurableStateConcurrencyError',
      expected: 1,
      actual: 2,
    });
  });

  test('re-insert at revision 0 on an existing key conflicts', async () => {
    const durableStateStoreOptions = PostgresDurableStateStoreOptions.create()
      .withPool(new FakePgPool());
    const d = new PostgresDurableStateStore(durableStateStoreOptions);
    await d.upsert('k1', 0, { v: 'a' });
    await expect(d.upsert('k1', 0, { v: 'dup' })).rejects.toBeInstanceOf(DurableStateConcurrencyError);
  });

  test('delete removes the record', async () => {
    const durableStateStoreOptions = PostgresDurableStateStoreOptions.create()
      .withPool(new FakePgPool());
    const d = new PostgresDurableStateStore(durableStateStoreOptions);
    await d.upsert('k1', 0, { v: 'a' });
    await d.delete('k1');
    expect((await d.load('k1')).toNullable()).toBeNull();
  });
});
