import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteJournal, SqliteJournalOptions } from '../../../../src/persistence/index.js';
import { JournalError } from '../../../../src/persistence/JournalTypes.js';
import { getSqliteDriver, type SqliteDb } from '../../../../src/runtime/sqlite/index.js';

/**
 * The busy timeout under genuine lock contention (#124).
 *
 * The unit suite proves the pragma reaches SQLite; this proves it changes what
 * SQLite *does*.  A second connection holds `BEGIN IMMEDIATE` — the same write
 * lock `adaptSqliteDatabase` takes deliberately — and the journal then tries to
 * append against it.  With no timeout the append fails on the first tick; with
 * one it spends the budget waiting first.  That gap is the whole issue: on
 * `bun:sqlite` and `node:sqlite` the built-in default was 0, so every SQLite
 * journal on those runtimes was in the fail-immediately column without anyone
 * choosing it.
 *
 * A real file is required.  Two `:memory:` connections are two separate
 * databases and cannot contend at all.
 */

const tempDirectory = mkdtempSync(join(tmpdir(), 'actor-ts-sqlite-busy-timeout-'));
afterAll(() => {
  // Best-effort: on Windows the SQLite driver can release its file handle a
  // beat after close(), and a locked file must not fail the suite.
  try { rmSync(tempDirectory, { recursive: true, force: true }); } catch { /* leave the temp dir to the OS */ }
});

/**
 * Time one append that is guaranteed to lose the race for the write lock.
 *
 * The warm-up append is not optional: the journal creates its tables on first
 * use, and that DDL takes the write lock too — so it has to happen before the
 * blocker holds it, or the test would be measuring the schema step instead.
 */
async function timeBlockedAppend(fileName: string, busyTimeoutMs: number): Promise<number> {
  const journalOptions = SqliteJournalOptions.create()
    .withPath(join(tempDirectory, fileName))
    .withBusyTimeoutMs(busyTimeoutMs);
  const journal = new SqliteJournal(journalOptions);
  let blocker: SqliteDb | undefined;
  try {
    await journal.append('account-1', [{ event: 'created' }], 0);

    const driver = await getSqliteDriver();
    blocker = driver.open(join(tempDirectory, fileName));
    blocker.exec('BEGIN IMMEDIATE');

    const startedAt = Date.now();
    await expect(journal.append('account-1', [{ event: 'deposited' }], 1)).rejects.toThrow(JournalError);
    return Date.now() - startedAt;
  } finally {
    if (blocker) {
      try { blocker.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      blocker.close();
    }
    await journal.close();
  }
}

describe('SQLite busy timeout under contention (#124)', () => {
  test('a configured timeout makes the writer wait; zero makes it fail at once', async () => {
    const waited = await timeBlockedAppend('waits.db', 800);
    const immediate = await timeBlockedAppend('fails-fast.db', 0);

    // Bounds are deliberately loose on the wait side and relative on the
    // fail-fast side.  SQLite's busy handler retries in sleep increments and
    // gives up somewhere at or before the budget, so pinning it to ~800 ms
    // would be a timing flake; 300 ms is far above anything an uncontended
    // path costs and far below the budget.
    expect(waited).toBeGreaterThanOrEqual(300);
    // The comparison is what actually distinguishes the two configurations,
    // and it holds regardless of how loaded the machine is.
    expect(immediate).toBeLessThan(waited);
  }, 20_000);
});
