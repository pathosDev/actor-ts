/**
 * `CassandraJournal` against a real cluster: the append serializer, the
 * partition rollover, and compaction.
 *
 * Each assertion here targets something `FakeCassandraClient` cannot answer,
 * because it never parses CQL and never runs Paxos:
 *
 *   - **Partition rollover.**  `append` splits its writes into one unlogged
 *     batch per `partition_nr` specifically to avoid Cassandra's
 *     multi-partition batch warning, and `read` stitches the partitions back
 *     together.  With `partitionSize: 3` and seven events that is three
 *     batches and three reads — against a fake it is one map either way.
 *   - **The LWT claim (#475).**  Two writers that both read head `N` are
 *     separated by a Paxos round on the metadata row, not by our own
 *     bookkeeping.  A Cassandra `INSERT` is an upsert, so without the claim
 *     the loser would silently overwrite the winner and be told it succeeded.
 *     Exactly one of two concurrent appends may win, and the loser must see a
 *     `JournalConcurrencyError`.
 *   - **The high-water mark surviving compaction.**  There is no separate
 *     `deleted_to` column here: the mark *is* `max_sequence_nr`, which is why
 *     `delete` leaves the metadata row alone.
 */
import { assert, assertEqual, expectThrows } from '../../lib/persistence-contract/Assert.js';
import type { BrokerScenario } from '../../lib/Scenario.js';
import { makeJournal, type CassandraContext } from '../Runner.js';

type OrderEvent = { readonly kind: string; readonly amount: number };

export const scenario: BrokerScenario<CassandraContext> = {
  name: 'journal — append across partitions, LWT-serialized, compaction keeps the mark',
  async run(context) {
    // Three rows per partition, so seven events land in partitions 0, 1 and 2.
    const journal = makeJournal(context, { partitionSize: 3 });
    const persistenceId = context.pid('journal:round-trip');
    try {
      const entries = Array.from({ length: 7 }, (_unused, index) => ({
        event: { kind: 'deposited', amount: (index + 1) * 10 } as OrderEvent,
      }));
      const written = await journal.append<OrderEvent>(persistenceId, entries, 0);
      assertEqual(written.length, 7, 'append echoes one event per entry');
      assertEqual(
        written.map((event) => event.sequenceNr),
        [1, 2, 3, 4, 5, 6, 7],
        'sequence numbers are assigned 1-based and contiguous',
      );

      const all = await journal.read<OrderEvent>(persistenceId, 1);
      assertEqual(
        all.map((event) => event.event.amount),
        [10, 20, 30, 40, 50, 60, 70],
        'a full read stitches three partitions back into one ordered stream',
      );
      assert(
        all.every((event) => typeof event.timestamp === 'number' && event.timestamp > 0),
        'every event carries the timestamp the journal stamped',
      );

      // A range that starts inside partition 0 and ends inside partition 1 —
      // the case where `read`'s partition arithmetic has to be right in both
      // directions rather than merely consistent with itself.
      const middle = await journal.read<OrderEvent>(persistenceId, 2, 5);
      assertEqual(
        middle.map((event) => event.sequenceNr),
        [2, 3, 4, 5],
        'a range read spanning two partitions is inclusive at both ends',
      );

      assertEqual(await journal.highestSeq(persistenceId), 7, 'highestSeq reads the metadata row');

      const ids = await journal.persistenceIds();
      assert(ids.includes(persistenceId), 'the id was indexed into all_persistence_ids');
      const firstPage = await journal.persistenceIdsPaginated(undefined, 1);
      assertEqual(firstPage.length, 1, 'pagination honours LIMIT on the `_all` partition');
      const secondPage = await journal.persistenceIdsPaginated(firstPage[0], 1);
      assert(
        secondPage.length === 0 || secondPage[0]! > firstPage[0]!,
        'the cursor seeks forward in clustering order rather than ring order',
      );

      // A stale writer: the head is 7, this one still believes it is 3.  Under
      // LWT the pre-check catches it, and the claim would catch it even if the
      // read had raced.
      await expectThrows(
        () => journal.append(persistenceId, [{ event: { kind: 'stale', amount: 0 } }], 3),
        'JournalConcurrencyError',
        'an append at a stale expectedSeq',
      );

      // Two writers that both believe the head is 7, racing.  The point of the
      // Paxos claim is that exactly one may proceed — an upsert would let both
      // "succeed" and lose one event.  A second journal instance, so the two
      // appends go through two clients rather than one in-process queue.
      const rival = makeJournal(context, { partitionSize: 3 });
      try {
        // Warm it up first.  A journal's first call runs `CREATE KEYSPACE` /
        // `CREATE TABLE IF NOT EXISTS` DDL, and starting that concurrently
        // with the other writer's append would race the two on schema
        // agreement rather than on the metadata row — a flake wearing the
        // costume of the thing under test.
        assertEqual(await rival.highestSeq(persistenceId), 7, 'the rival sees the same head');
        const outcomes = await Promise.allSettled([
          journal.append<OrderEvent>(persistenceId, [{ event: { kind: 'raced', amount: 80 } }], 7),
          rival.append<OrderEvent>(persistenceId, [{ event: { kind: 'raced', amount: 81 } }], 7),
        ]);
        const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
        const losers = outcomes.filter((outcome) => outcome.status === 'rejected');
        assertEqual(winners.length, 1, 'exactly one concurrent append at the same head wins');
        assertEqual(
          (losers[0] as PromiseRejectedResult).reason.name,
          'JournalConcurrencyError',
          'the loser is rejected rather than silently overwriting the winner',
        );
        assertEqual(await journal.highestSeq(persistenceId), 8, 'the head advanced exactly once');
        const afterRace = await journal.read<OrderEvent>(persistenceId, 8);
        assertEqual(afterRace.length, 1, 'the winner wrote exactly one event at seq 8');
      } finally {
        await rival.close();
      }

      // Compaction. The mark IS `max_sequence_nr`, so it must NOT rewind.
      await journal.delete(persistenceId, 4);
      const survivors = await journal.read<OrderEvent>(persistenceId, 1);
      assertEqual(
        survivors.map((event) => event.sequenceNr),
        [5, 6, 7, 8],
        'delete removed the compacted prefix across two partitions',
      );
      assertEqual(
        await journal.highestSeq(persistenceId),
        8,
        'the high-water mark survives compaction — there is no separate deleted_to column',
      );

      // …and raising it is monotonic and idempotent, which is what makes a
      // re-run of a journal migration free.
      await journal.raiseCompactionMark(persistenceId, 5);
      assertEqual(
        await journal.highestSeq(persistenceId),
        8,
        'raiseCompactionMark below the head leaves it alone',
      );
      await journal.raiseCompactionMark(persistenceId, 12);
      assertEqual(
        await journal.highestSeq(persistenceId),
        12,
        'raiseCompactionMark above the head takes the same LWT the append path takes',
      );
    } finally {
      await journal.close();
    }
  },
};
