/**
 * `Journal` contract scenarios — one set, run against every implementation
 * (in-memory, SQLite, the relational backends behind their fake pools, and
 * the same backends against a live database in the Docker suites).
 *
 * The point of the shared set is that a behaviour only has to be *specified*
 * once: a case like "the high-water mark survives a full delete" is then
 * automatically checked everywhere instead of being added to whichever
 * backend's hand-written suite happened to prompt it (#390).
 */
import { JournalConcurrencyError } from '../../../../../src/persistence/JournalTypes.js';
import { assert, assertEqual, expectThrows } from './assert.js';
import { closeQuietly, type ContractScenario, type JournalHarness } from './types.js';

export function journalContractScenarios(): ContractScenario<JournalHarness>[] {
  return [
    {
      name: 'append assigns monotonic sequence numbers starting at 1',
      async run(harness) {
        const journal = await harness.make();
        const persistenceId = harness.pid('append');
        try {
          const written = await journal.append(persistenceId, ['e1', 'e2', 'e3'], 0);
          assertEqual(written.map((e) => e.sequenceNr), [1, 2, 3], 'assigned sequence numbers');
          assertEqual(written.map((e) => e.event), ['e1', 'e2', 'e3'], 'returned payloads');
          assert(written.every((e) => e.persistenceId === persistenceId), 'events carry the persistence id');
          assertEqual(await journal.highestSeq(persistenceId), 3, 'highestSeq after append');
        } finally {
          await closeQuietly(journal);
        }
      },
    },
    {
      name: 'read round-trips payloads with numeric sequenceNr and timestamp',
      async run(harness) {
        const journal = await harness.make();
        const persistenceId = harness.pid('read');
        try {
          await journal.append(persistenceId, [{ n: 1 }, { n: 2 }], 0);
          const read = await journal.read<{ n: number }>(persistenceId, 1);
          assertEqual(read.map((e) => e.event.n), [1, 2], 'payloads survive the round-trip');
          // Relational drivers hand BIGINT columns back as strings — every
          // backend must coerce before returning them to the actor layer.
          assert(read.every((e) => typeof e.sequenceNr === 'number'), 'sequenceNr is a number');
          assert(read.every((e) => typeof e.timestamp === 'number'), 'timestamp is a number');
        } finally {
          await closeQuietly(journal);
        }
      },
    },
    {
      name: 'read honours the inclusive fromSeq / toSeq bounds',
      async run(harness) {
        const journal = await harness.make();
        const persistenceId = harness.pid('range');
        try {
          await journal.append(persistenceId, ['a', 'b', 'c', 'd'], 0);
          assertEqual((await journal.read(persistenceId, 2, 3)).map((e) => e.sequenceNr), [2, 3], 'bounded read');
          assertEqual((await journal.read(persistenceId, 3)).map((e) => e.sequenceNr), [3, 4], 'open-ended read');
          assertEqual((await journal.read(persistenceId, 2, 2)).map((e) => e.sequenceNr), [2], 'single-element range');
        } finally {
          await closeQuietly(journal);
        }
      },
    },
    {
      name: 'stale expectedSeq throws JournalConcurrencyError reporting the actual head',
      async run(harness) {
        const journal = await harness.make();
        const persistenceId = harness.pid('concurrency');
        try {
          await journal.append(persistenceId, ['a', 'b'], 0);
          const error = await expectThrows(
            () => journal.append(persistenceId, ['x'], 0),
            'JournalConcurrencyError',
            'append with a stale expectedSeq',
          ) as JournalConcurrencyError;
          assertEqual(error.expectedSeq, 0, 'error reports the rejected expectedSeq');
          assertEqual(error.actualSeq, 2, 'error reports the actual head');
          // The rejected append must not have written anything.
          assertEqual(await journal.highestSeq(persistenceId), 2, 'head unchanged after the rejection');
          const resumed = await journal.append(persistenceId, ['c'], 2);
          assertEqual(resumed.map((e) => e.sequenceNr), [3], 'append resumes with the correct expectedSeq');
        } finally {
          await closeQuietly(journal);
        }
      },
    },
    {
      name: 'concurrent appends at the same expectedSeq leave exactly one winner',
      skip: (harness) => (harness.capabilities?.serializesConcurrentAppends === false
        ? 'store does not serialize racing appends'
        : null),
      async run(harness) {
        const journal = await harness.make();
        const persistenceId = harness.pid('race');
        try {
          // Race at whatever the current head is rather than assuming 0, so a
          // live suite re-run against a database that was not wiped still
          // exercises real contention instead of failing on the first append.
          const head = await journal.highestSeq(persistenceId);

          // Six writers all believing they hold the current head.  Whether a
          // given one loses at the head check or at the conditional write is a
          // matter of timing — the guarantee under test is that the *stream*
          // stays sound either way, which is what the duplicate-key backstop
          // exists for.  On a relational store this is also the only scenario
          // that reaches that backstop at all.
          const attempts = await Promise.allSettled(
            Array.from({ length: 6 }, (_, index) => journal.append(persistenceId, [`writer-${index}`], head)),
          );
          const winners = attempts.filter((attempt) => attempt.status === 'fulfilled');
          const losers = attempts.filter((attempt) => attempt.status === 'rejected');
          assertEqual(winners.length, 1, 'exactly one append succeeds');
          for (const loser of losers) {
            const error = (loser as PromiseRejectedResult).reason as Error;
            assert(
              error.name === 'JournalConcurrencyError',
              `a losing append reports a concurrency conflict, got ${error.name}: ${error.message}`,
            );
          }
          // No lost or duplicated writes: the stream holds exactly the winner.
          assertEqual(await journal.highestSeq(persistenceId), head + 1, 'the head advanced exactly once');
          const stored = await journal.read<string>(persistenceId, head + 1);
          assertEqual(stored.map((event) => event.sequenceNr), [head + 1], 'exactly one event is stored');
          // And it is the *winner's* event.  A store that upserts instead of
          // rejecting would keep one row at the contested sequence number while
          // silently replacing its payload — the row count alone cannot see that.
          const won = (winners[0] as PromiseFulfilledResult<Array<{ event: string }>>).value;
          assertEqual(stored[0]!.event, won[0]!.event, 'the surviving event belongs to the winner');
        } finally {
          await closeQuietly(journal);
        }
      },
    },
    {
      name: 'highestSeq is 0 for an unknown persistence id',
      async run(harness) {
        const journal = await harness.make();
        try {
          assertEqual(await journal.highestSeq(harness.pid('never-written')), 0, 'highestSeq of an unknown id');
          assertEqual(await journal.read(harness.pid('never-written'), 1), [], 'read of an unknown id');
        } finally {
          await closeQuietly(journal);
        }
      },
    },
    {
      name: 'empty append is a no-op and does not check concurrency',
      async run(harness) {
        const journal = await harness.make();
        const persistenceId = harness.pid('empty');
        try {
          assertEqual(await journal.append(persistenceId, [], 0), [], 'empty append on a fresh id returns []');
          assertEqual(await journal.highestSeq(persistenceId), 0, 'empty append does not advance the head');

          await journal.append(persistenceId, ['a', 'b'], 0);
          // Nothing is being written, so there is nothing to conflict over —
          // an empty append is a no-op even when expectedSeq is stale.
          assertEqual(await journal.append(persistenceId, [], 0), [], 'empty append with a stale expectedSeq returns []');
          assertEqual(await journal.highestSeq(persistenceId), 2, 'head unchanged by the empty append');
          assertEqual((await journal.read(persistenceId, 1)).length, 2, 'no phantom events written');
        } finally {
          await closeQuietly(journal);
        }
      },
    },
    {
      name: 'tags round-trip on append and read',
      skip: (harness) => (harness.capabilities?.tags === false ? 'store does not support tags' : null),
      async run(harness) {
        const journal = await harness.make();
        const persistenceId = harness.pid('tags');
        try {
          const written = await journal.append(persistenceId, ['a', 'b'], 0, ['tagAlpha', 'tagBeta']);
          assertEqual(written[0]!.tags, ['tagAlpha', 'tagBeta'], 'returned events carry the tags');
          const read = await journal.read(persistenceId, 1);
          assertEqual(read[0]!.tags, ['tagAlpha', 'tagBeta'], 'tags survive the round-trip');
          assertEqual(read[1]!.tags, ['tagAlpha', 'tagBeta'], 'every event of the batch is tagged');
          // An untagged append leaves the field absent rather than empty.
          await journal.append(persistenceId, ['c'], 2);
          const untagged = (await journal.read(persistenceId, 3))[0]!;
          assert(untagged.tags === undefined, 'untagged events report no tags');
        } finally {
          await closeQuietly(journal);
        }
      },
    },
    {
      name: 'partial delete compacts up to toSeq and keeps the surviving head',
      async run(harness) {
        const journal = await harness.make();
        const persistenceId = harness.pid('partial-delete');
        try {
          await journal.append(persistenceId, ['e1', 'e2', 'e3'], 0);
          await journal.delete(persistenceId, 2);
          assertEqual((await journal.read(persistenceId, 1)).map((e) => e.sequenceNr), [3], 'events up to toSeq are gone');
          assertEqual(await journal.highestSeq(persistenceId), 3, 'highestSeq is the surviving head');
          const written = await journal.append(persistenceId, ['e4'], 3);
          assertEqual(written.map((e) => e.sequenceNr), [4], 'append continues after the compaction');
        } finally {
          await closeQuietly(journal);
        }
      },
    },
    {
      name: 'full delete preserves highestSeq and the next append continues the sequence',
      async run(harness) {
        const journal = await harness.make();
        const persistenceId = harness.pid('full-delete');
        try {
          await journal.append(persistenceId, ['e1', 'e2', 'e3'], 0);
          // Full compaction past a snapshot: every event for the id is dropped.
          await journal.delete(persistenceId, 3);
          assertEqual(await journal.read(persistenceId, 1), [], 'all events are gone');
          // … but sequence numbers are never reused, so the counter stands.
          assertEqual(await journal.highestSeq(persistenceId), 3, 'highestSeq survives the full delete');
          const written = await journal.append(persistenceId, ['e4'], 3);
          assertEqual(written.map((e) => e.sequenceNr), [4], 'the recovered actor can append at the old head');
          assertEqual(await journal.highestSeq(persistenceId), 4, 'head advances from the preserved mark');
        } finally {
          await closeQuietly(journal);
        }
      },
    },
    {
      name: 'delete is idempotent and tolerates an unknown persistence id',
      async run(harness) {
        const journal = await harness.make();
        const persistenceId = harness.pid('delete-idempotent');
        try {
          await journal.delete(harness.pid('never-written-delete'), 5);   // must not throw
          await journal.append(persistenceId, ['a', 'b'], 0);
          await journal.delete(persistenceId, 2);
          await journal.delete(persistenceId, 2);
          assertEqual(await journal.read(persistenceId, 1), [], 'repeated delete leaves the stream empty');
          assertEqual(await journal.highestSeq(persistenceId), 2, 'repeated delete does not move the mark');
        } finally {
          await closeQuietly(journal);
        }
      },
    },
    {
      name: 'persistenceIds reports ids that hold events',
      async run(harness) {
        const journal = await harness.make();
        const first = harness.pid('ids-first');
        const second = harness.pid('ids-second');
        try {
          await journal.append(first, ['a'], 0);
          await journal.append(second, ['a'], 0);
          await journal.append(first, ['b'], 1);
          const ids = await journal.persistenceIds();
          assert(ids.includes(first), `persistenceIds includes ${first}`);
          assert(ids.includes(second), `persistenceIds includes ${second}`);
          // Distinct, not one entry per event.
          assertEqual(ids.filter((id) => id === first).length, 1, 'ids are distinct');
        } finally {
          await closeQuietly(journal);
        }
      },
    },
    {
      name: 'close is idempotent',
      async run(harness) {
        const journal = await harness.make();
        await journal.append(harness.pid('close'), ['a'], 0);
        // `close` is documented as best-effort and idempotent — a second call
        // (e.g. CoordinatedShutdown after an explicit close) must not throw.
        await closeQuietly(journal);
        await closeQuietly(journal);
      },
    },
  ];
}
