/**
 * `CassandraSnapshotStore` against a real cluster, sharing one client with the
 * journal.
 *
 * Three things here are live-only:
 *
 *   - **`loadLatest` is a single-row read, not a sort.**  It issues
 *     `… WHERE persistence_id = ? LIMIT 1` and trusts the table's
 *     `WITH CLUSTERING ORDER BY (sequence_nr DESC)` to make row one the newest.
 *     A fake that keeps a JS array and returns its last element passes whether
 *     that DDL says DESC, ASC, or nothing at all.
 *   - **`keepN` prunes with a real clustering seek.**  `pruneKeepN` reads the
 *     newest `keepN` sequence numbers with a `LIMIT`, takes the oldest of them
 *     as the cutoff, and deletes below it — arithmetic that only means
 *     anything if the server really hands back the rows in that order.
 *   - **Two stores on one keyspace agree on a storage identity (#1358).**  The
 *     agreement is produced by a lightweight transaction on a singleton row:
 *     whoever arrives first writes a UUID, the loser's `IF NOT EXISTS` is
 *     rejected and it reads back the winner's value.  Fakes agree by
 *     construction; Paxos is the thing being checked.
 *
 * The client is injected into both stores, so `ownsClient` is false on each
 * and neither may shut it down — the last assertion is that closing both
 * leaves the caller's connection usable, which is the whole promise of
 * `withClient`.
 */
import { assert, assertEqual } from '../../lib/persistence-contract/Assert.js';
import type { BrokerScenario } from '../../lib/Scenario.js';
import { makeClient, makeJournal, makeSnapshotStore, type CassandraContext } from '../Runner.js';

type AccountState = { readonly balance: number };

export const scenario: BrokerScenario<CassandraContext> = {
  name: 'snapshot store — clustering order, keepN prune, and a shared storage identity',
  async run(context) {
    const client = await makeClient(context);
    await client.connect();
    const journal = makeJournal(context, { client });
    const snapshotStore = makeSnapshotStore(context, 2, client);
    const latestId = context.pid('snapshot:latest');
    const pruneId = context.pid('snapshot:prune');
    try {
      const saved = await snapshotStore.save<AccountState>(latestId, 5, { balance: 10 });
      assertEqual(saved.sequenceNr, 5, 'save echoes the sequence number');
      assertEqual(saved.state, { balance: 10 }, 'save echoes the state');
      await snapshotStore.save<AccountState>(latestId, 9, { balance: 42 });

      const latest = (await snapshotStore.loadLatest<AccountState>(latestId)).toNullable();
      assertEqual(latest?.sequenceNr, 9, 'LIMIT 1 over a DESC clustering order is the newest row');
      assertEqual(latest?.state.balance, 42, 'the newest state came back decoded');
      assert(typeof latest?.timestamp === 'number', 'the stored timestamp round-trips as a number');

      const before = (await snapshotStore.loadBefore<AccountState>(latestId, 9)).toNullable();
      assertEqual(before?.sequenceNr, 5, 'loadBefore seeks backwards within the partition');
      const beforeAll = await snapshotStore.loadBefore<AccountState>(latestId, 5);
      assert(beforeAll.isNone(), 'loadBefore the oldest snapshot is None, not a throw');

      // keepN = 2: the first save is under the cap, the second reaches it, the
      // third pushes the oldest out.
      await snapshotStore.save<AccountState>(pruneId, 1, { balance: 1 });
      await snapshotStore.save<AccountState>(pruneId, 2, { balance: 2 });
      await snapshotStore.save<AccountState>(pruneId, 3, { balance: 3 });
      assertEqual(
        (await snapshotStore.loadLatest<AccountState>(pruneId)).toNullable()?.sequenceNr,
        3,
        'the newest snapshot survives the prune',
      );
      assertEqual(
        (await snapshotStore.loadBefore<AccountState>(pruneId, 3)).toNullable()?.sequenceNr,
        2,
        'keepN = 2 keeps the second-newest',
      );
      assert(
        (await snapshotStore.loadBefore<AccountState>(pruneId, 2)).isNone(),
        'keepN = 2 pruned everything older',
      );

      await snapshotStore.delete(latestId, 9);
      assert(
        (await snapshotStore.loadLatest<AccountState>(latestId)).isNone(),
        'delete removes the whole prefix inclusive of toSeq',
      );

      // #1358 — one keyspace, one identity, decided by an LWT rather than by
      // both stores having been handed the same string.
      const journalIdentity = await journal.storageIdentity();
      const snapshotIdentity = await snapshotStore.storageIdentity();
      assert(journalIdentity.length > 0, 'the journal claimed or read a storage identity');
      assertEqual(
        snapshotIdentity,
        journalIdentity,
        'the snapshot store lost the IF NOT EXISTS claim and read back the journal\'s identity',
      );
      assertEqual(journal.storageLocality, 'shared', 'a Cassandra cluster is shared storage');
      assertEqual(snapshotStore.storageLocality, 'shared', 'and so is the snapshot store over it');

      // Neither store owns the injected client, so neither may close it.  The
      // query after them is what proves the connection is still live rather
      // than merely believed to be — the whole promise of `withClient`.  It
      // sits inside the `try` on purpose: run from the `finally`, a failure
      // here would replace whichever assertion above actually broke.
      await snapshotStore.close();
      await journal.close();
      const stillAlive = await client.execute('SELECT release_version FROM system.local');
      assertEqual(
        stillAlive.rows.length,
        1,
        'closing two stores left the injected client connected',
      );
    } finally {
      await snapshotStore.close();
      await journal.close();
      await client.shutdown();
    }
  },
};
