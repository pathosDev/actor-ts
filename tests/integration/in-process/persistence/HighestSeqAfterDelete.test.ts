import { describe, expect, test } from 'bun:test';
import {
  InMemoryJournal,
  MariaDbJournal,
  MariaDbJournalOptions,
  PostgresJournal,
  PostgresJournalOptions,
  SqliteJournal,
  type Journal,
} from '../../../../src/persistence/index.js';
import { FakePgPool } from './FakePgPool.js';
import { FakeMariaDbPool } from './FakeMariaDbPool.js';

/**
 * The high-water mark must never rewind — after every event for a pid is
 * deleted (compaction past a snapshot), `highestSeq` still returns the
 * highest seq ever written, and the next append with that expectedSeq
 * succeeds instead of tripping the optimistic-concurrency check.  Cassandra
 * already behaves this way via its metadata table; this guards the
 * in-memory + relational backends that used to reset to 0 (#379).
 */
const backends: ReadonlyArray<{ name: string; make: () => Journal }> = [
  { name: 'InMemoryJournal', make: () => new InMemoryJournal() },
  { name: 'SqliteJournal', make: () => new SqliteJournal() },
  { name: 'PostgresJournal', make: () => new PostgresJournal(PostgresJournalOptions.create().withPool(new FakePgPool())) },
  { name: 'MariaDbJournal', make: () => new MariaDbJournal(MariaDbJournalOptions.create().withPool(new FakeMariaDbPool())) },
];

for (const { name, make } of backends) {
  describe(`${name} — highestSeq never rewinds after delete`, () => {
    test('full delete preserves highestSeq and lets the next append continue the sequence', async () => {
      const journal = make();
      await journal.append('acct-1', ['e1', 'e2', 'e3'], 0);
      expect(await journal.highestSeq('acct-1')).toBe(3);

      // Full compaction: delete everything up to and including the head.
      await journal.delete('acct-1', 3);

      // Events are gone …
      expect(await journal.read('acct-1', 1)).toEqual([]);
      // … but the counter is preserved.
      expect(await journal.highestSeq('acct-1')).toBe(3);

      // The next append (expectedSeq = 3, as a recovered PersistentActor would
      // send after snapshot + deleteHistory) must succeed and assign seq 4.
      const written = await journal.append('acct-1', ['e4'], 3);
      expect(written.map((e) => e.sequenceNr)).toEqual([4]);
      expect(await journal.highestSeq('acct-1')).toBe(4);

      await journal.close?.();
    });

    test('partial delete keeps the surviving head as highestSeq', async () => {
      const journal = make();
      await journal.append('acct-2', ['e1', 'e2', 'e3'], 0);
      await journal.delete('acct-2', 2);

      expect(await journal.highestSeq('acct-2')).toBe(3);
      const remaining = await journal.read('acct-2', 1);
      expect(remaining.map((e) => e.sequenceNr)).toEqual([3]);

      await journal.close?.();
    });
  });
}
