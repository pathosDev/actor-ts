import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteJournal } from '../../../../src/persistence/journals/SqliteJournal.js';
import { SqliteJournalOptions } from '../../../../src/persistence/journals/SqliteJournalOptions.js';
import { JournalConcurrencyError } from '../../../../src/persistence/JournalTypes.js';
import { SqliteSnapshotStore } from '../../../../src/persistence/snapshot-stores/SqliteSnapshotStore.js';
import { SqliteSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/SqliteSnapshotStoreOptions.js';
import { getSqliteDriver, type SqliteDb, type SqliteDriver } from '../../../../src/runtime/sqlite/index.js';

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

/** A real driver that counts the databases it opened and closed, the first of which may fail. */
type CountingSqliteDriver = {
  readonly driver: SqliteDriver;
  readonly opens: () => number;
  readonly closes: () => number;
};

/**
 * The runtime's driver, counting opens and closes, with the FIRST database it
 * opens optionally failing in one chosen way — the seam the open-retry and
 * `start()` cases need (#1473).  `'first-exec'` throws on the first
 * statement, the busy-timeout pragma, the way a locked file does; `'backfill'`
 * breaks the driver's transaction helper, which only the journal's tag
 * backfill uses.  The counts are what tell "opened afresh" apart from "handed
 * the same failure back", one open apart from two, and a closed handle apart
 * from one left behind.
 */
async function countingSqliteDriver(
  failure: 'none' | 'first-exec' | 'backfill' = 'none',
): Promise<CountingSqliteDriver> {
  const runtimeDriver = await getSqliteDriver();
  let opens = 0;
  let closes = 0;
  const driver: SqliteDriver = {
    open(path: string): SqliteDb {
      opens++;
      const database = runtimeDriver.open(path);
      const failing = opens === 1;
      let statements = 0;
      return {
        exec(sql: string): void {
          statements++;
          if (failing && failure === 'first-exec' && statements === 1) {
            throw new Error('SQLITE_BUSY: database is locked');
          }
          database.exec(sql);
        },
        prepare: (sql: string) => database.prepare(sql),
        transaction<F extends (...callArguments: never[]) => unknown>(body: F): F {
          if (failing && failure === 'backfill') {
            return (() => { throw new Error('disk I/O error'); }) as unknown as F;
          }
          return database.transaction(body);
        },
        close(): void {
          closes++;
          database.close();
        },
      };
    },
  };
  return { driver, opens: () => opens, closes: () => closes };
}

/**
 * Count the opens of the runtime's own cached driver while `body` runs — the
 * driver `getSqliteDriver()` hands a store that was given none.  Only that
 * path awaits before it opens, so only there can a `close()` land between
 * resolving the driver and opening the database (#1473).  The counting `open`
 * shadows the prototype method on the cached instance and is removed again in
 * `finally`, so nothing outlives the case.
 */
async function countingRuntimeOpens(body: (opened: readonly string[]) => Promise<void>): Promise<void> {
  const runtimeDriver = await getSqliteDriver();
  const opened: string[] = [];
  const open = runtimeDriver.open.bind(runtimeDriver);
  Object.defineProperty(runtimeDriver, 'open', {
    configurable: true,
    writable: true,
    value: (path: string): SqliteDb => {
      opened.push(path);
      return open(path);
    },
  });
  try {
    await body(opened);
  } finally {
    Reflect.deleteProperty(runtimeDriver, 'open');
  }
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

  test('a failed open closes the database it opened, and the next call opens afresh (#1473)', async () => {
    const counting = await countingSqliteDriver('first-exec');
    const sqliteJournalOptions = SqliteJournalOptions.create()
      .withPath(':memory:')
      .withDriver(counting.driver);
    const journal = new SqliteJournal(sqliteJournalOptions);
    cleanups.push(() => journal.close());

    await expect(journal.highestSeq('p')).rejects.toThrow(/SQLITE_BUSY/);
    expect(counting.opens()).toBe(1);
    expect(counting.closes()).toBe(1);

    expect(await journal.highestSeq('p')).toBe(0);
    await journal.append('p', [{ event: 'x' }], 0);
    expect((await journal.read('p', 1)).map((e) => e.event)).toEqual(['x']);
    expect(counting.opens()).toBe(2);
    expect(counting.closes()).toBe(1);
  });

  test('a failing tag backfill leaves the journal unopened rather than half-open (#1473)', async () => {
    // A database from before the tags table: tagged rows in the CSV column and
    // nothing in `events_tags`, which is what makes the backfill run.
    const path = join(tempDirectory, 'backfill-retry.sqlite');
    const seeding = new SqliteJournal(SqliteJournalOptions.create().withPath(path));
    await seeding.append('p', [{ event: 'e1', tags: ['orders', 'vip'] }], 0);
    await seeding.close();
    const runtimeDriver = await getSqliteDriver();
    const raw = runtimeDriver.open(path);
    try { raw.exec('DELETE FROM events_tags'); } finally { raw.close(); }

    const counting = await countingSqliteDriver('backfill');
    const sqliteJournalOptions = SqliteJournalOptions.create()
      .withPath(path)
      .withDriver(counting.driver);
    const journal = new SqliteJournal(sqliteJournalOptions);
    cleanups.push(() => journal.close());

    await expect(journal.highestSeq('p')).rejects.toThrow(/disk I\/O error/);
    expect(counting.closes()).toBe(1);

    // Not half-open: the next call opens again, and this time the backfill runs.
    expect(await journal.highestSeq('p')).toBe(1);
    expect(counting.opens()).toBe(2);
    await journal.close();
    const check = runtimeDriver.open(path);
    try {
      const row = check.prepare('SELECT COUNT(*) AS indexed FROM events_tags').get() as { indexed: number };
      expect(row.indexed).toBe(2);
    } finally {
      check.close();
    }
  });

  test('close() while the runtime driver is still resolving opens nothing (#1473)', async () => {
    await countingRuntimeOpens(async (opened) => {
      const journal = new SqliteJournal(SqliteJournalOptions.create().withPath(':memory:'));
      const operation = journal.highestSeq('p');
      await journal.close();
      await expect(operation).rejects.toThrow(/closed/);
      expect(opened).toEqual([]);
    });
  });

  test('start() opens now, once, and shares that open with the first operation (#1473)', async () => {
    // The runtime-driver path, because only it awaits before opening: with an
    // injected driver the whole open runs inside the first call, and a start()
    // that bypassed the shared open could not be told from one that used it.
    await countingRuntimeOpens(async (opened) => {
      const journal = new SqliteJournal(SqliteJournalOptions.create().withPath(':memory:'));
      cleanups.push(() => journal.close());

      await Promise.all([journal.start(), journal.highestSeq('p'), journal.start()]);
      expect(opened).toEqual([':memory:']);
      await journal.start();
      await journal.append('p', [{ event: 'x' }], 0);
      expect(opened).toEqual([':memory:']);
    });
  });

  test('a failed start() is retried by the next one, and start() after close() rejects (#1473)', async () => {
    const counting = await countingSqliteDriver('first-exec');
    const sqliteJournalOptions = SqliteJournalOptions.create()
      .withPath(':memory:')
      .withDriver(counting.driver);
    const journal = new SqliteJournal(sqliteJournalOptions);

    await expect(journal.start()).rejects.toThrow(/SQLITE_BUSY/);
    await journal.start();
    expect(counting.opens()).toBe(2);
    expect(counting.closes()).toBe(1);

    await journal.close();
    await expect(journal.start()).rejects.toThrow('SqliteJournal is closed');
    expect(counting.opens()).toBe(2);
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

  test('a failed open closes the database it opened, and the next call opens afresh (#1473)', async () => {
    const counting = await countingSqliteDriver('first-exec');
    const sqliteSnapshotStoreOptions = SqliteSnapshotStoreOptions.create()
      .withPath(':memory:')
      .withDriver(counting.driver);
    const snapshotStore = new SqliteSnapshotStore(sqliteSnapshotStoreOptions);
    cleanups.push(() => snapshotStore.close());

    await expect(snapshotStore.loadLatest('p')).rejects.toThrow(/SQLITE_BUSY/);
    expect(counting.opens()).toBe(1);
    expect(counting.closes()).toBe(1);

    await snapshotStore.save('p', 1, { balance: 10 });
    expect((await snapshotStore.loadLatest<{ balance: number }>('p')).toNullable()?.state.balance).toBe(10);
    expect(counting.opens()).toBe(2);
    expect(counting.closes()).toBe(1);
  });

  test('close() while the runtime driver is still resolving opens nothing (#1473)', async () => {
    await countingRuntimeOpens(async (opened) => {
      const snapshotStore = new SqliteSnapshotStore(SqliteSnapshotStoreOptions.create().withPath(':memory:'));
      const operation = snapshotStore.loadLatest('p');
      await snapshotStore.close();
      await expect(operation).rejects.toThrow(/closed/);
      expect(opened).toEqual([]);
    });
  });

  test('start() opens now, once, and shares that open with the first operation (#1473)', async () => {
    // The runtime-driver path, for the reason the journal's twin gives.
    await countingRuntimeOpens(async (opened) => {
      const snapshotStore = new SqliteSnapshotStore(SqliteSnapshotStoreOptions.create().withPath(':memory:'));
      cleanups.push(() => snapshotStore.close());

      await Promise.all([snapshotStore.start(), snapshotStore.loadLatest('p'), snapshotStore.start()]);
      expect(opened).toEqual([':memory:']);
      await snapshotStore.start();
      await snapshotStore.save('p', 1, { balance: 10 });
      expect(opened).toEqual([':memory:']);
    });
  });

  test('a failed start() is retried by the next one, and start() after close() rejects (#1473)', async () => {
    const counting = await countingSqliteDriver('first-exec');
    const sqliteSnapshotStoreOptions = SqliteSnapshotStoreOptions.create()
      .withPath(':memory:')
      .withDriver(counting.driver);
    const snapshotStore = new SqliteSnapshotStore(sqliteSnapshotStoreOptions);

    await expect(snapshotStore.start()).rejects.toThrow(/SQLITE_BUSY/);
    await snapshotStore.start();
    expect(counting.opens()).toBe(2);
    expect(counting.closes()).toBe(1);

    await snapshotStore.close();
    await expect(snapshotStore.start()).rejects.toThrow('SqliteSnapshotStore is closed');
    expect(counting.opens()).toBe(2);
  });
});
