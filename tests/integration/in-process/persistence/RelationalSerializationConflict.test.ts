/**
 * Contention aborts are concurrency conflicts — when the head moved (#479).
 *
 * The relational journals' optimistic concurrency leans on a backstop: if a
 * racing writer claims `(persistence_id, sequence_nr)` between our head read
 * and the insert, the primary key rejects us and the duplicate-key error is
 * translated into `JournalConcurrencyError`.  That assumed the loser always
 * gets far enough to violate the key, and against a live MariaDB it does not:
 * InnoDB aborts the losing transaction with errno 1020 (`ER_CHECKREAD`)
 * first, which used to fall through as an opaque `JournalError`.
 *
 * The fix cannot be "translate 1020 too" unconditionally — a lock-wait
 * timeout against an unrelated long transaction carries the same family of
 * codes and is a genuine storage failure.  So the base confirms against the
 * stored head, and these tests pin both directions of that decision.
 */
import { describe, expect, test } from 'bun:test';
import {
  MariaDbJournal,
  MariaDbJournalOptions,
  MariaDbDurableStateStore,
  MariaDbDurableStateStoreOptions,
} from '../../../../src/persistence/index.js';
import type { MariaDbResult } from '../../../../src/persistence/journals/MariaDbClient.js';
import { FakeMariaDbPool } from './FakeMariaDbPool.js';

/** The shape the `mariadb` connector reports for an InnoDB contention abort. */
class ContentionAbortError extends Error {
  readonly errno: number;
  readonly code: string;
  constructor(errno: number, code: string) {
    super(`(conn:1, no: ${errno}, SQLState: HY000) simulated ${code}`);
    this.name = 'ContentionAbortError';
    this.errno = errno;
    this.code = code;
  }
}

/**
 * Aborts the next INSERT into a chosen table the way a contended InnoDB
 * transaction does.  `getConnection()` routes back through `query`, so this
 * intercepts statements inside the journal's transaction too.
 */
class ContendedMariaDbPool extends FakeMariaDbPool {
  abortNextInsertInto: string | null = null;
  /**
   * Runs just before the abort.  This is what makes the fixture faithful: the
   * rival has to commit *after* our transaction read the head and *before*
   * our insert fails, which is the only window in which the base's re-read
   * can see a moved head.  Landing the rival up front instead would trip the
   * head pre-check and never reach the code under test.
   */
  beforeAbort: (() => Promise<void>) | null = null;
  errno = 1020;
  code = 'ER_CHECKREAD';

  override async query(sql: string, values?: ReadonlyArray<unknown>): Promise<MariaDbResult> {
    const table = this.abortNextInsertInto;
    if (table !== null && /^\s*INSERT/i.test(sql) && sql.includes(table)) {
      this.abortNextInsertInto = null;
      const rival = this.beforeAbort;
      this.beforeAbort = null;
      if (rival) await rival();
      throw new ContentionAbortError(this.errno, this.code);
    }
    return super.query(sql, values);
  }
}

function journalOn(pool: ContendedMariaDbPool): MariaDbJournal {
  return new MariaDbJournal(MariaDbJournalOptions.create().withPool(pool));
}

describe('RelationalJournal — a contention abort that lost a race', () => {
  test('reports JournalConcurrencyError with the head the winner left', async () => {
    const pool = new ContendedMariaDbPool();
    const journal = journalOn(pool);
    const rival = journalOn(pool);

    // Our head read sees 0; the rival then commits seq 1 and the engine
    // aborts us for contention rather than on the primary key.
    pool.abortNextInsertInto = 'events';
    pool.beforeAbort = async () => { await rival.append('pid', ['winner'], 0); };

    const failure = await journal.append('pid', ['loser'], 0).catch((e: Error) => e);
    expect(failure.name).toBe('JournalConcurrencyError');
    expect((failure as unknown as { expectedSeq: number }).expectedSeq).toBe(0);
    expect((failure as unknown as { actualSeq: number }).actualSeq).toBe(1);

    // The rival's event is the one that survives, intact.
    const stored = await journal.read<string>('pid', 1);
    expect(stored.map((e) => e.event)).toEqual(['winner']);
  });

  test('the same holds for a deadlock victim and a lock-wait timeout', async () => {
    for (const [errno, code] of [[1213, 'ER_LOCK_DEADLOCK'], [1205, 'ER_LOCK_WAIT_TIMEOUT']] as const) {
      const pool = new ContendedMariaDbPool();
      const journal = journalOn(pool);
      const rival = journalOn(pool);
      pool.errno = errno;
      pool.code = code;
      pool.abortNextInsertInto = 'events';
      pool.beforeAbort = async () => { await rival.append('pid', ['winner'], 0); };

      const failure = await journal.append('pid', ['loser'], 0).catch((e: Error) => e);
      expect(failure.name).toBe(`JournalConcurrencyError`);
      expect(failure.message).toContain('journal has 1');
    }
  });
});

describe('RelationalJournal — a contention abort that did NOT lose a race', () => {
  test('stays a JournalError rather than being relabelled', async () => {
    const pool = new ContendedMariaDbPool();
    const journal = journalOn(pool);
    // Nobody moved the head — this is a lock problem, not a lost race.
    pool.abortNextInsertInto = 'events';

    const failure = await journal.append('pid', ['only'], 0).catch((e: Error) => e);
    expect(failure.name).toBe('JournalError');
    expect(failure.message).toContain('1020');
    // Reporting a concurrency conflict here would send the caller into a
    // retry loop against a head that is never going to change.
    expect(await journal.highestSeq('pid')).toBe(0);
  });
});

describe('RelationalDurableStateStore — the same hole', () => {
  test('a CAS loser aborted for contention reports DurableStateConcurrencyError', async () => {
    const pool = new ContendedMariaDbPool();
    const store = new MariaDbDurableStateStore(
      MariaDbDurableStateStoreOptions.create().withPool(pool),
    );
    await store.upsert('pid', 0, { count: 1 });   // revision 1
    await store.upsert('pid', 1, { count: 2 });   // revision 2 — someone else won

    pool.abortNextInsertInto = 'durable_state';
    const failure = await store.upsert('pid', 0, { count: 9 }).catch((e: Error) => e);
    expect(failure.name).toBe('DurableStateConcurrencyError');
    expect((failure as unknown as { expected: number }).expected).toBe(0);
    expect((failure as unknown as { actual: number }).actual).toBe(2);
  });

  test('an uncontested abort stays a storage failure', async () => {
    const pool = new ContendedMariaDbPool();
    const store = new MariaDbDurableStateStore(
      MariaDbDurableStateStoreOptions.create().withPool(pool),
    );
    pool.abortNextInsertInto = 'durable_state';

    const failure = await store.upsert('pid', 0, { count: 1 }).catch((e: Error) => e);
    expect(failure.name).toBe('JournalError');
  });
});
