/**
 * Smoke case: the SQLite lock-wait budget is the same on every runtime (#124).
 *
 * This case exists because the bug it guards was invisible to `bun test`.  The
 * drivers disagreed on their built-in `busy_timeout` — measured: `bun:sqlite`
 * 0, `node:sqlite` 0, `better-sqlite3` 5000 — so the identical journal either
 * failed a contended write on the first tick or blocked for five seconds
 * purely as a function of where it ran.  A single-runtime test suite cannot
 * see that; three runtimes asserting the same number can.
 *
 * The pragma is read back out of SQLite rather than inferred from the options,
 * and the handle comes from `buildSqliteDatabase` so the driver is whichever
 * one this runtime actually selects — on Node that is `better-sqlite3` when it
 * is installed, which is exactly the outlier.
 */
export const name = 'sqlite busy timeout';
export const description = 'identical busy_timeout on Bun, Node and Deno';

export async function run({ actorTs, loadEntry }) {
  const { buildSqliteDatabase, DEFAULT_SQLITE_BUSY_TIMEOUT_MS, SqliteJournal, SqliteJournalOptions } = await loadEntry('persistence');

  const readTimeout = (db) => db.prepare('PRAGMA busy_timeout').get().timeout;

  // 1. The default lands on a handle the package opens, whatever the driver
  //    would have chosen on its own.
  const defaulted = await buildSqliteDatabase({ path: ':memory:' });
  try {
    const observed = readTimeout(defaulted);
    if (observed !== DEFAULT_SQLITE_BUSY_TIMEOUT_MS) {
      throw new Error(`expected busy_timeout ${DEFAULT_SQLITE_BUSY_TIMEOUT_MS} — got ${observed}`);
    }
  } finally {
    defaulted.close();
  }

  // 2. The default is a real wait and stays clear of the failure detector's
  //    2000 ms unreachable threshold — the driver is synchronous, so the whole
  //    budget is event-loop freeze.
  if (!(DEFAULT_SQLITE_BUSY_TIMEOUT_MS > 0 && DEFAULT_SQLITE_BUSY_TIMEOUT_MS < 2000)) {
    throw new Error(`default busy_timeout out of range: ${DEFAULT_SQLITE_BUSY_TIMEOUT_MS}`);
  }

  // 3. An explicit value reaches SQLite, including the `0 = off` case that a
  //    naive `||` default would swallow.
  const explicit = await buildSqliteDatabase({ path: ':memory:', busyTimeoutMs: 250 });
  try {
    const observed = readTimeout(explicit);
    if (observed !== 250) throw new Error(`expected busy_timeout 250 — got ${observed}`);
  } finally {
    explicit.close();
  }

  const off = await buildSqliteDatabase({ path: ':memory:', busyTimeoutMs: 0 });
  try {
    const observed = readTimeout(off);
    if (observed !== 0) throw new Error(`expected busy_timeout 0 — got ${observed}`);
  } finally {
    off.close();
  }

  // 4. A negative value is SQLite's "retry forever" — an unbounded event-loop
  //    freeze on a synchronous driver — and is rejected rather than clamped.
  let rejected = false;
  try {
    new SqliteJournal({ path: ':memory:', busyTimeoutMs: -1 });
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('a negative busyTimeoutMs was accepted');

  // 5. The journal still works end to end with a configured budget — the
  //    append path changed to `BEGIN IMMEDIATE` for this fix, so the round
  //    trip is worth re-proving per runtime.
  const journalOptions = SqliteJournalOptions.create()
    .withPath(':memory:')
    .withBusyTimeoutMs(500);
  const journal = new SqliteJournal(journalOptions);
  try {
    const written = await journal.append('account-1', [{ event: 'created' }, { event: 'deposited:10' }], 0);
    if (written.map((e) => e.sequenceNr).join(',') !== '1,2') {
      throw new Error(`expected seq 1,2 — got ${written.map((e) => e.sequenceNr).join(',')}`);
    }
    const head = await journal.highestSeq('account-1');
    if (head !== 2) throw new Error(`expected highestSeq 2 — got ${head}`);
  } finally {
    await journal.close();
  }
}
