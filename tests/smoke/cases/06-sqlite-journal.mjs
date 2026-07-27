/**
 * Smoke case: SQLite persistence on every runtime (#400).
 *
 * This is the case that keeps the Deno gap closed.  SQLite persistence used to
 * throw outright on Deno, because both drivers needed a native binding; the
 * built-in `node:sqlite` driver removes that, and the only honest way to prove
 * it is to append and read back on each runtime rather than to assert which
 * driver got picked.
 *
 * An in-memory database keeps the case self-contained — no temp files, no
 * cleanup, and it still exercises the full prepared-statement and transaction
 * path (the concurrency rejection below rides on the transaction).
 */
export const name = 'sqlite journal';
export const description = 'append / read / concurrency on an in-memory SQLite DB';

export async function run({ actorTs }) {
  const { SqliteJournal, SqliteJournalOptions, JournalConcurrencyError } = actorTs;

  const journalOptions = SqliteJournalOptions.create().withPath(':memory:');
  const journal = new SqliteJournal(journalOptions);
  try {
    const written = await journal.append('account-1', ['created', 'deposited:10'], 0, ['ledger']);
    const sequenceNumbers = written.map((e) => e.sequenceNr).join(',');
    if (sequenceNumbers !== '1,2') throw new Error(`expected seq 1,2 — got ${sequenceNumbers}`);

    const read = await journal.read('account-1', 1);
    if (read.length !== 2) throw new Error(`expected 2 events — got ${read.length}`);
    if (read[0].event !== 'created') throw new Error(`payload round-trip failed: ${read[0].event}`);
    if (read[0].tags?.join(',') !== 'ledger') throw new Error(`tags round-trip failed: ${read[0].tags}`);

    const head = await journal.highestSeq('account-1');
    if (head !== 2) throw new Error(`expected highestSeq 2 — got ${head}`);

    // Optimistic concurrency runs inside a transaction, so this also covers
    // the rollback arm of the driver's transaction support.
    let rejected = false;
    try {
      await journal.append('account-1', ['stale'], 0);
    } catch (e) {
      if (!(e instanceof JournalConcurrencyError)) throw e;
      rejected = true;
    }
    if (!rejected) throw new Error('stale append was not rejected');

    // The journal is still usable after the rollback.
    const resumed = await journal.append('account-1', ['deposited:20'], 2);
    if (resumed[0].sequenceNr !== 3) throw new Error(`expected seq 3 — got ${resumed[0].sequenceNr}`);
  } finally {
    await journal.close();
  }
}
