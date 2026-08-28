/**
 * The `events_by_tag` side table (#44) and compaction reaching it (#654).
 *
 * `useTagIndex` makes every `append` dual-write one row per `(event, tag)`
 * pair into a table partitioned by `(tag)` and clustered on
 * `(timestamp, persistence_id, sequence_nr)`, which `CassandraQuery` then
 * walks instead of sweeping the journal client-side.  Two things about that
 * are only checkable against a real server:
 *
 *   - The **table is real CQL**.  A wrong clustering order, a column typed
 *     `text` where the query binds a `bigint`, or a partition key that does
 *     not match the `WHERE tag = ? AND timestamp >= ?` the query issues are
 *     all accepted without comment by a fake that answers out of a JS map.
 *   - **`delete` has to reach it.**  `events_by_tag` is a separate physical
 *     table, not a secondary index Cassandra maintains, and each row carries
 *     the full payload — so a compacted event left behind there stays both
 *     readable through `currentEventsByTag` and stored forever.  That is a
 *     correctness defect and a data-retention one at once, and it is invisible
 *     to a fake, whose `delete` is a map deletion that cannot forget a second
 *     table.
 *
 * Tags are namespaced per run for the same reason persistence ids are: the tag
 * IS the partition key, so a fixed tag would accumulate every previous run's
 * rows in one partition and every count below would drift upward.
 */
import { CassandraQuery } from '../../../../../src/persistence/query/CassandraQuery.js';
import { offsetStart } from '../../../../../src/persistence/query/PersistenceQuery.js';
import { assert, assertEqual } from '../../lib/persistence-contract/Assert.js';
import type { BrokerScenario } from '../../lib/Scenario.js';
import { makeJournal, type CassandraContext } from '../Runner.js';

type MemberEvent = { readonly kind: string; readonly who: string };

export const scenario: BrokerScenario<CassandraContext> = {
  name: 'tag index — CassandraQuery walks events_by_tag, and delete compacts it',
  async run(context) {
    const journal = makeJournal(context, { useTagIndex: true });
    const query = new CassandraQuery(journal);
    const vip = context.pid('tag:vip');
    const europe = context.pid('tag:eu');
    const unitedStates = context.pid('tag:us');
    const alice = context.pid('tag:alice');
    const bob = context.pid('tag:bob');
    try {
      assert(journal.useTagIndex, 'the journal was built with the side table on');

      await journal.append<MemberEvent>(alice, [
        { event: { kind: 'joined', who: 'alice' }, tags: [vip, europe] },
        { event: { kind: 'renewed', who: 'alice' }, tags: [vip] },
      ], 0);
      // A second append so the two streams carry different timestamps, which is
      // the side table's leading clustering column — same-tick rows would make
      // the ordering assertion below pass for the wrong reason.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await journal.append<MemberEvent>(bob, [
        { event: { kind: 'joined', who: 'bob' }, tags: [vip, unitedStates] },
      ], 0);

      // A bare string is shorthand for `{ all: [tag] }` — strategy 1, a single
      // partition walk.
      const vipEvents = await query.currentEventsByTag<MemberEvent>(vip, offsetStart);
      assertEqual(
        vipEvents.map((tagged) => tagged.event.event.who),
        ['alice', 'alice', 'bob'],
        'the tag partition comes back in (timestamp, persistence_id, sequence_nr) order',
      );
      assert(
        vipEvents.every((tagged) => (tagged.event.tags ?? []).includes(vip)),
        'each row carries the full tag set the side table stores',
      );
      assertEqual(
        vipEvents[0]!.offset.persistenceId,
        alice,
        'the offset is the resumable cursor, not just the event',
      );

      // Strategy 1 with a refinement: walk `vip`'s partition, then JS-filter
      // the rest against the per-row tag set rather than reading `events`.
      const vipInEurope = await query.currentEventsByTag<MemberEvent>(
        { all: [vip, europe] }, offsetStart,
      );
      assertEqual(
        vipInEurope.map((tagged) => tagged.event.sequenceNr),
        [1],
        'an `all` filter intersects against the tags carried on the side-table row',
      );

      // Strategy 2: one partition scan per `any` tag, merged and deduped by
      // (persistence_id, sequence_nr) — alice's seq 1 is in both partitions.
      const anywhere = await query.currentEventsByTag<MemberEvent>(
        { any: [vip, europe] }, offsetStart,
      );
      assertEqual(
        anywhere.map((tagged) => `${tagged.event.persistenceId}#${tagged.event.sequenceNr}`),
        [`${alice}#1`, `${alice}#2`, `${bob}#1`],
        'an `any` filter merges partitions without duplicating a multi-tagged event',
      );

      // A tag nothing carries: an empty partition, not an error.
      const nobody = await query.currentEventsByTag<MemberEvent>(
        context.pid('tag:nobody'), offsetStart,
      );
      assertEqual(nobody.length, 0, 'an unused tag partition reads back empty');

      // #654: compaction has to reach the side table.  Alice's first event goes;
      // her second must stay, and so must bob's.
      await journal.delete(alice, 1);
      const afterCompaction = await query.currentEventsByTag<MemberEvent>(vip, offsetStart);
      assertEqual(
        afterCompaction.map((tagged) => `${tagged.event.persistenceId}#${tagged.event.sequenceNr}`),
        [`${alice}#2`, `${bob}#1`],
        'the compacted event is gone from events_by_tag, not merely from events',
      );
      const europeAfterCompaction = await query.currentEventsByTag<MemberEvent>(europe, offsetStart);
      assertEqual(
        europeAfterCompaction.length,
        0,
        'every tag partition the compacted event was written to lost its row',
      );
      const aliceSurvivors = await journal.read<MemberEvent>(alice, 1);
      assertEqual(
        aliceSurvivors.map((event) => event.sequenceNr),
        [2],
        'the events table and the tag index agree about what survived',
      );
    } finally {
      await journal.close();
    }
  },
};
