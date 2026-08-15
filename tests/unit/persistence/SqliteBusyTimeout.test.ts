import { describe, expect, test } from 'bun:test';
import { DEFAULT_SQLITE_BUSY_TIMEOUT_MS } from '../../../src/persistence/Constants.js';
import {
  applySqliteBusyTimeout,
  buildSqliteDatabase,
} from '../../../src/persistence/journals/SqliteClient.js';
import { SqliteJournal } from '../../../src/persistence/journals/SqliteJournal.js';
import { SqliteJournalOptions } from '../../../src/persistence/journals/SqliteJournalOptions.js';
import { SqliteSnapshotStore } from '../../../src/persistence/snapshot-stores/SqliteSnapshotStore.js';
import { SqliteSnapshotStoreOptions } from '../../../src/persistence/snapshot-stores/SqliteSnapshotStoreOptions.js';
import { SqliteDurableStateStoreOptionsValidator } from '../../../src/persistence/durable-state-stores/SqliteDurableStateStoreOptions.js';
import { getSqliteDriver, type SqliteDb, type SqliteDriver } from '../../../src/runtime/sqlite/index.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * `busy_timeout` on every handle the package opens (#124).
 *
 * The point of these tests is not that a number can be configured — it is that
 * the number no longer depends on which runtime is executing.  The driver
 * defaults measured on the three supported backends were `bun:sqlite` 0,
 * `node:sqlite` 0 and `better-sqlite3` 5000, so before this fix the identical
 * store either failed a contended write on the first tick or blocked for five
 * seconds depending purely on where it ran.
 *
 * Every assertion below therefore reads the pragma back OUT OF SQLITE rather
 * than intercepting the `exec` string: what matters is the value the engine
 * ended up with, and that is exactly the thing that used to differ.
 */

/**
 * Wraps the real driver and keeps every handle it hands out, so a test can
 * interrogate the exact connection a store is using — the stores keep theirs
 * private, and injecting a fake would test the fake instead of SQLite.
 */
class RecordingSqliteDriver implements SqliteDriver {
  readonly opened: SqliteDb[] = [];

  constructor(private readonly inner: SqliteDriver) {}

  open(path: string): SqliteDb {
    const db = this.inner.open(path);
    this.opened.push(db);
    return db;
  }
}

async function recordingDriver(): Promise<RecordingSqliteDriver> {
  return new RecordingSqliteDriver(await getSqliteDriver());
}

function busyTimeoutOf(db: SqliteDb): number {
  const row = db.prepare('PRAGMA busy_timeout').get<{ timeout: number }>();
  return row!.timeout;
}

describe('SQLite busy timeout — the package default (#124)', () => {
  test('buildSqliteDatabase stamps the default onto a handle it opens', async () => {
    const database = await buildSqliteDatabase({ path: ':memory:' });
    expect(busyTimeoutOf(database)).toBe(DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
    database.close();
  });

  test('the default is a real wait, and well short of the failure detector', () => {
    // Two bounds, both load-bearing.  Zero would reproduce the bug on Bun and
    // Deno; 2000 is `defaultFailureDetectorOptions.unreachableAfterMs`, and
    // the driver is synchronous, so a budget at or above it would let one
    // contended write stall a node past the point where peers give up on it.
    expect(DEFAULT_SQLITE_BUSY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_SQLITE_BUSY_TIMEOUT_MS).toBeLessThan(2_000);
  });

  test('the journal opens its connection with the default', async () => {
    const driver = await recordingDriver();
    const journalOptions = SqliteJournalOptions.create()
      .withPath(':memory:')
      .withDriver(driver);
    const journal = new SqliteJournal(journalOptions);
    try {
      await journal.append('account-1', [{ event: 'created' }], 0);
      expect(driver.opened).toHaveLength(1);
      expect(busyTimeoutOf(driver.opened[0]!)).toBe(DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      await journal.close();
    }
  });

  test('the snapshot store opens its connection with the default', async () => {
    const driver = await recordingDriver();
    const storeOptions = SqliteSnapshotStoreOptions.create()
      .withPath(':memory:')
      .withDriver(driver);
    const store = new SqliteSnapshotStore(storeOptions);
    try {
      await store.save('account-1', 1, { balance: 10 });
      expect(driver.opened).toHaveLength(1);
      expect(busyTimeoutOf(driver.opened[0]!)).toBe(DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      await store.close();
    }
  });

  test('the default overrides whatever the driver had already decided', async () => {
    // Stands in for `better-sqlite3`, whose handles arrive pre-set to 5000 —
    // normalizing has to mean "set", not "set if unset", or Node would keep
    // its own value and the divergence would survive the fix.
    const driver = await getSqliteDriver();
    const database = driver.open(':memory:');
    database.exec('PRAGMA busy_timeout = 5000;');
    expect(busyTimeoutOf(database)).toBe(5_000);

    applySqliteBusyTimeout(database);
    expect(busyTimeoutOf(database)).toBe(DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
    database.close();
  });
});

describe('SQLite busy timeout — explicit values (#124)', () => {
  test('an explicit busyTimeoutMs wins over the default', async () => {
    const database = await buildSqliteDatabase({ path: ':memory:', busyTimeoutMs: 250 });
    expect(busyTimeoutOf(database)).toBe(250);
    database.close();
  });

  test('zero means "do not wait" rather than "unset"', async () => {
    // The `0 = off` convention: it must reach SQLite as a genuine 0 and not be
    // swallowed by the `??` default.
    const database = await buildSqliteDatabase({ path: ':memory:', busyTimeoutMs: 0 });
    expect(busyTimeoutOf(database)).toBe(0);
    database.close();
  });

  test('the journal honours an explicit value', async () => {
    const driver = await recordingDriver();
    const journalOptions = SqliteJournalOptions.create()
      .withPath(':memory:')
      .withDriver(driver)
      .withBusyTimeoutMs(750);
    const journal = new SqliteJournal(journalOptions);
    try {
      await journal.append('account-1', [{ event: 'created' }], 0);
      expect(busyTimeoutOf(driver.opened[0]!)).toBe(750);
    } finally {
      await journal.close();
    }
  });

  test('the snapshot store honours an explicit value', async () => {
    const driver = await recordingDriver();
    const storeOptions = SqliteSnapshotStoreOptions.create()
      .withPath(':memory:')
      .withDriver(driver)
      .withBusyTimeoutMs(0);
    const store = new SqliteSnapshotStore(storeOptions);
    try {
      await store.save('account-1', 1, { balance: 10 });
      expect(busyTimeoutOf(driver.opened[0]!)).toBe(0);
    } finally {
      await store.close();
    }
  });

  test('a plain options object works exactly like the builder', async () => {
    const driver = await recordingDriver();
    const journal = new SqliteJournal({ path: ':memory:', driver, busyTimeoutMs: 333 });
    try {
      await journal.append('account-1', [{ event: 'created' }], 0);
      expect(busyTimeoutOf(driver.opened[0]!)).toBe(333);
    } finally {
      await journal.close();
    }
  });
});

describe('SQLite busy timeout — injected handles (#124)', () => {
  test('a pre-opened database keeps its own pragma', async () => {
    // A handle passed in as `database` is shared by construction — with the
    // journal, the snapshot store, or a test fake.  Re-tuning it here would
    // reach into stores that never asked for the change.
    const driver = await getSqliteDriver();
    const shared = driver.open(':memory:');
    shared.exec('PRAGMA busy_timeout = 7777;');

    const returned = await buildSqliteDatabase({ database: shared, busyTimeoutMs: 42 });
    expect(returned).toBe(shared);
    expect(busyTimeoutOf(shared)).toBe(7_777);
    shared.close();
  });
});

describe('SQLite busy timeout — validation (#124)', () => {
  // A negative value is SQLite's "retry forever".  On a synchronous driver
  // that is an unbounded event-loop freeze, so it is rejected rather than
  // clamped — a silently-corrected value would hide the mistake.
  test('the journal rejects a negative busyTimeoutMs', () => {
    expect(() => new SqliteJournal({ path: ':memory:', busyTimeoutMs: -1 }))
      .toThrow(OptionsError);
  });

  test('the snapshot store rejects a negative busyTimeoutMs', () => {
    expect(() => new SqliteSnapshotStore({ path: ':memory:', busyTimeoutMs: -1 }))
      .toThrow(OptionsError);
  });

  test('the durable-state store rejects a negative busyTimeoutMs', () => {
    // Validated through the validator directly: the store's own constructor
    // path is covered by the shared durable-state suites, and the rule under
    // test is the same object either way.
    expect(() => new SqliteDurableStateStoreOptionsValidator()
      .validate({ path: ':memory:', busyTimeoutMs: -1 }))
      .toThrow(OptionsError);
  });

  test('a fractional busyTimeoutMs is rejected rather than truncated', () => {
    expect(() => new SqliteJournal({ path: ':memory:', busyTimeoutMs: 12.5 }))
      .toThrow(/must be an integer >= 0/);
  });

  test('the error names the offending field', () => {
    try {
      new SqliteJournal({ path: ':memory:', busyTimeoutMs: -1 });
      throw new Error('expected the constructor to reject');
    } catch (e) {
      expect(e).toBeInstanceOf(OptionsError);
      expect((e as OptionsError).field).toBe('busyTimeoutMs');
      expect((e as OptionsError).options).toBe('SqliteJournalOptions');
    }
  });

  test('zero and an unset value both pass', () => {
    expect(() => new SqliteJournal({ path: ':memory:', busyTimeoutMs: 0 })).not.toThrow();
    expect(() => new SqliteJournal({ path: ':memory:' })).not.toThrow();
  });
});
