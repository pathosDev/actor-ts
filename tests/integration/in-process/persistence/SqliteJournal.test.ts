import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteJournal } from '../../../../src/persistence/journals/SqliteJournal.js';
import { SqliteJournalOptions } from '../../../../src/persistence/journals/SqliteJournalOptions.js';
import { JournalConcurrencyError } from '../../../../src/persistence/JournalTypes.js';
import { SqliteSnapshotStore } from '../../../../src/persistence/snapshot-stores/SqliteSnapshotStore.js';
import { SqliteSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/SqliteSnapshotStoreOptions.js';
import { getSqliteDriver } from '../../../../src/runtime/sqlite/index.js';

/** Journals and snapshot stores we create per test, auto-closed after. */
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.shift()!();
});

/**
 * One temp directory for the cases that need a real file — a `:memory:`
 * database cannot be reopened by a second connection, and the legacy-CSV case
 * has to write a row the journal itself would now refuse.
 */
const tempDirectory = mkdtempSync(join(tmpdir(), 'actor-ts-sqlite-journal-'));
afterAll(() => {
  // Best-effort: on Windows the SQLite driver can release its file handle a
  // beat after close(), and a locked file must not fail the suite.
  try { rmSync(tempDirectory, { recursive: true, force: true }); } catch { /* leave the temp dir to the OS */ }
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
    await journal.append('acct-1', [{ event: { kind: 'deposited', amount: 100 } }], 0);
    await journal.append('acct-1', [{ event: { kind: 'withdrew', amount: 30 } }], 1);
    const events = await journal.read<{ kind: string; amount: number }>('acct-1', 1);
    expect(events.length).toBe(2);
    expect(events[0]!.event.kind).toBe('deposited');
    expect(events[1]!.event.amount).toBe(30);
  });

  test('assigns monotonic sequence numbers per persistenceId', async () => {
    const journal = newJournal();
    await journal.append('a', [{ event: 'x' }, { event: 'y' }], 0);
    await journal.append('b', [{ event: 'z' }], 0);
    expect(await journal.highestSeq('a')).toBe(2);
    expect(await journal.highestSeq('b')).toBe(1);
  });

  test('concurrency mismatch throws and does not write partial rows', async () => {
    const journal = newJournal();
    await journal.append('p', [{ event: 'first' }], 0);
    await expect(journal.append('p', [{ event: 'bad' }], 0)).rejects.toBeInstanceOf(JournalConcurrencyError);
    const events = await journal.read('p', 1);
    expect(events.length).toBe(1);
  });

  test('tags round-trip through CSV encoding', async () => {
    const journal = newJournal();
    await journal.append('p', [{ event: 'e1', tags: ['orders', 'vip'] }, { event: 'e2', tags: ['orders', 'vip'] }], 0);
    const events = await journal.read('p', 1);
    for (const e of events) expect([...(e.tags ?? [])]).toEqual(['orders', 'vip']);
  });

  test('a CSV with an empty member can no longer be written (#740)', async () => {
    // The CSV column is `tags.join(',')` and `read` is `tags.split(',')`, with
    // nothing in between — so an empty member survives that round-trip as a
    // real tag while the tags *table* used to drop it, one append recorded two
    // different ways.  Rejecting at the validator is what closes it: the
    // trailing comma the join would produce is now unreachable.
    const journal = newJournal();
    await expect(journal.append('p', [{ event: 'e1', tags: ['orders', ''] }], 0))
      .rejects.toThrow(/empty tag/);
    await expect(journal.append('p', [{ event: 'e1', tags: ['', 'orders'] }], 0))
      .rejects.toThrow(/empty tag/);
    await expect(journal.append('p', [{ event: 'e1', tags: ['orders', 'orders'] }], 0))
      .rejects.toThrow(/duplicate tag/);
    // Nothing was written, so no row carries a comma that splits into an
    // empty member on read.
    expect(await journal.highestSeq('p')).toBe(0);
    expect(await journal.read('p', 1)).toEqual([]);
  });

  test('a legacy CSV row written before the rule still reads back (#740)', async () => {
    // "Reading is never refused" — the promise the persistence-id rules
    // already make.  Validation lives only in `append`, so a database that
    // predates #740 keeps handing back exactly the tag list it stored,
    // trailing empty member and all.  A real file, because the raw row has to
    // be written by a second connection to the same database.
    const path = join(tempDirectory, 'legacy-csv.sqlite');
    const legacyJournal = new SqliteJournal(SqliteJournalOptions.create().withPath(path));
    await legacyJournal.append('p', [{ event: 'e1', tags: ['orders'] }], 0);
    await legacyJournal.close();

    const driver = await getSqliteDriver();
    const raw = driver.open(path);
    try {
      // What SqliteJournal v0 would have stored for `['orders', '']`.
      raw.prepare('UPDATE events SET tags = ? WHERE persistence_id = ? AND sequence_nr = ?')
        .run('orders,', 'p', 1);
    } finally {
      raw.close();
    }

    const reopened = new SqliteJournal(SqliteJournalOptions.create().withPath(path));
    cleanups.push(() => reopened.close());
    const events = await reopened.read('p', 1);
    expect([...(events[0]!.tags ?? [])]).toEqual(['orders', '']);
  });

  test('read range is inclusive on both ends', async () => {
    const journal = newJournal();
    await journal.append('p', [{ event: 'a' }, { event: 'b' }, { event: 'c' }, { event: 'd' }], 0);
    const slice = await journal.read('p', 2, 3);
    expect(slice.map(e => e.event)).toEqual(['b', 'c']);
  });

  test('delete removes events up to and including toSeq', async () => {
    const journal = newJournal();
    await journal.append('p', [{ event: 'a' }, { event: 'b' }, { event: 'c' }], 0);
    await journal.delete('p', 2);
    const rest = await journal.read('p', 1);
    expect(rest.map(e => e.event)).toEqual(['c']);
  });

  test('persistenceIds lists distinct streams', async () => {
    const journal = newJournal();
    await journal.append('a', [{ event: 'x' }], 0);
    await journal.append('b', [{ event: 'y' }], 0);
    expect((await journal.persistenceIds()).sort()).toEqual(['a', 'b']);
  });

  test('survives close with clear error afterwards', async () => {
    const sqliteJournalOptions = SqliteJournalOptions.create()
      .withPath(':memory:');
    const journal = new SqliteJournal(sqliteJournalOptions);
    await journal.append('p', [{ event: 'x' }], 0);
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
