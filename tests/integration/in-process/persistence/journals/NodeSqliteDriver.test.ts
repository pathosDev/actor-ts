import { afterEach, describe, expect, test } from 'bun:test';
import { setRuntimeOverride } from '../../../../../src/runtime/detect.js';
import {
  NodeSqliteDriver,
  getSqliteDriver,
  resetSqliteDriverCache,
} from '../../../../../src/runtime/sqlite/index.js';
import { SqliteJournal } from '../../../../../src/persistence/journals/SqliteJournal.js';
import { SqliteJournalOptions } from '../../../../../src/persistence/journals/SqliteJournalOptions.js';
import { SqliteSnapshotStore } from '../../../../../src/persistence/snapshot-stores/SqliteSnapshotStore.js';
import { SqliteSnapshotStoreOptions } from '../../../../../src/persistence/snapshot-stores/SqliteSnapshotStoreOptions.js';
import { JournalConcurrencyError } from '../../../../../src/persistence/JournalTypes.js';

/**
 * `node:sqlite` driver (#400) — the built-in SQLite that closes the Deno gap.
 *
 * The behavioural cases are guarded on availability rather than skipped
 * outright: `node:sqlite` exists on Node >= 22.13 and Deno >= 2.2, but not in
 * every Bun release, and this suite runs on Bun.  The dispatch test below has
 * no such dependency and always runs.
 */
const available = await NodeSqliteDriver.isAvailable();
const describeIfAvailable = available ? describe : describe.skip;

afterEach(() => {
  setRuntimeOverride(null);
  resetSqliteDriverCache();
});

describe('getSqliteDriver — runtime dispatch', () => {
  test('Deno resolves to the node:sqlite driver instead of throwing', async () => {
    setRuntimeOverride('deno');
    resetSqliteDriverCache();
    if (!available) {
      // Without the built-in module the call must still fail with the
      // version-oriented message, never the old "not supported on Deno".
      await expect(getSqliteDriver()).rejects.toThrow(/node:sqlite/);
      return;
    }
    expect(await getSqliteDriver()).toBeInstanceOf(NodeSqliteDriver);
  });

  test('the driver is cached per runtime', async () => {
    setRuntimeOverride('deno');
    resetSqliteDriverCache();
    if (!available) return;
    expect(await getSqliteDriver()).toBe(await getSqliteDriver());
  });
});

describeIfAvailable('NodeSqliteDriver — journal and snapshot store', () => {
  test('journal append / read / highestSeq round-trip', async () => {
    const journalOptions = SqliteJournalOptions.create()
      .withDriver(new NodeSqliteDriver());
    const journal = new SqliteJournal(journalOptions);
    const written = await journal.append('account-1', ['created', 'deposited'], 0, ['ledger']);
    expect(written.map((e) => e.sequenceNr)).toEqual([1, 2]);
    const read = await journal.read<string>('account-1', 1);
    expect(read.map((e) => e.event)).toEqual(['created', 'deposited']);
    expect(read[0]!.tags).toEqual(['ledger']);
    expect(await journal.highestSeq('account-1')).toBe(2);
    await journal.close();
  });

  test('a rejected append rolls back the synthesized transaction', async () => {
    const journalOptions = SqliteJournalOptions.create()
      .withDriver(new NodeSqliteDriver());
    const journal = new SqliteJournal(journalOptions);
    await journal.append('account-2', ['a'], 0);
    // `node:sqlite` has no `transaction()` helper, so the driver issues
    // BEGIN / COMMIT / ROLLBACK itself — this is what proves the rollback arm
    // works and does not leave the connection inside a transaction.
    await expect(journal.append('account-2', ['b'], 0)).rejects.toBeInstanceOf(JournalConcurrencyError);
    expect(await journal.highestSeq('account-2')).toBe(1);
    // The connection is usable afterwards, which a leaked BEGIN would prevent.
    expect((await journal.append('account-2', ['b'], 1)).map((e) => e.sequenceNr)).toEqual([2]);
    await journal.close();
  });

  test('snapshot store save / loadLatest / keepN prune', async () => {
    const storeOptions = SqliteSnapshotStoreOptions.create()
      .withDriver(new NodeSqliteDriver())
      .withKeepN(2);
    const store = new SqliteSnapshotStore(storeOptions);
    for (const seq of [1, 2, 3]) await store.save('account-1', seq, { seq });
    expect((await store.loadLatest<{ seq: number }>('account-1')).toNullable()?.sequenceNr).toBe(3);
    expect((await store.loadBefore('account-1', 2)).toNullable()).toBeNull();
    await store.close();
  });
});

describe('NodeSqliteDriver — guards', () => {
  test('open before preload fails with an actionable message', () => {
    if (available) return;   // preload already ran via isAvailable()
    expect(() => new NodeSqliteDriver().open(':memory:')).toThrow(/preload/);
  });
});
