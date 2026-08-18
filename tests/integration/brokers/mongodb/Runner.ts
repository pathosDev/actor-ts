/**
 * MongoDB live-integration runner (#397).
 *
 * Boots against the MongoDB container, waits for the port, then runs the shared
 * persistence contract (journal + snapshot + durable-state) against the real
 * `MongoJournal` / `MongoSnapshotStore` / `MongoDurableStateStore`.  Exit 0 / 1
 * like the other broker runners.
 *
 * This is the suite that verifies what the fake cannot: that the server actually
 * enforces the unique compound index the journal's concurrency backstop depends
 * on, that a violation arrives as error 11000 through the real driver, that
 * `$max` really is monotonic, and that `insertMany({ ordered: true })` stops
 * where the journal assumes it does.  It runs against a **standalone** `mongod`
 * on purpose — the backend needs no transactions, and this proves it.
 */
import { MongoDurableStateStore } from '../../../../src/persistence/durable-state-stores/MongoDurableStateStore.js';
import { MongoDurableStateStoreOptions } from '../../../../src/persistence/durable-state-stores/MongoDurableStateStoreOptions.js';
import { MongoJournal } from '../../../../src/persistence/journals/MongoJournal.js';
import { MongoJournalOptions } from '../../../../src/persistence/journals/MongoJournalOptions.js';
import { MongoQuery } from '../../../../src/persistence/query/MongoQuery.js';
import { MongoSnapshotStore } from '../../../../src/persistence/snapshot-stores/MongoSnapshotStore.js';
import { MongoSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/MongoSnapshotStoreOptions.js';
import { waitForPort } from '../lib/WaitForPort.js';
import { runScenarios } from '../lib/Scenario.js';
import { sqlPersistenceScenarios, type SqlPersistenceContext } from '../lib/PersistenceContract.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`runner: missing env var ${name}`);
  return value;
}

async function main(): Promise<void> {
  const url = requireEnv('MONGO_URL');
  const databaseName = requireEnv('MONGO_DATABASE');
  const parsedUrl = new URL(url);
  await waitForPort(parsedUrl.hostname, Number(parsedUrl.port || '27017'), {
    description: 'MongoDB',
    deadlineMs: 60_000,
  });

  // Factories, not instances: every contract scenario builds its own store, so
  // the scenarios stay independent and each closes the client it opened.
  const context: SqlPersistenceContext = {
    env: process.env,
    label: 'mongodb',
    async makeJournal() {
      const journalOptions = MongoJournalOptions.create()
        .withUrl(url)
        .withDatabaseName(databaseName);
      return new MongoJournal(journalOptions);
    },
    // `MongoQuery` reads the multikey `{ tags: 1, timestamp: 1 }` index, which
    // the fake client does not have: it answers the same `find` by filtering an
    // array in JS, so a live run is the only thing that shows the real driver
    // accepts the filter *and* the compound sort the query asks for.  Unset
    // until now, so the scenario logged `SKIP … backend has no query
    // implementation` and was then reported as `PASS … (0ms)` — the same
    // omission the Postgres runner carried, now gated by
    // `tests/unit/ci/LiveBrokerQueryWiring.test.ts`.
    makeQuery: (journal) => new MongoQuery(journal as MongoJournal),
    async makeSnapshotStore(keepN) {
      const snapshotStoreOptions = MongoSnapshotStoreOptions.create()
        .withUrl(url)
        .withDatabaseName(databaseName)
        .withKeepN(keepN ?? 2);
      return new MongoSnapshotStore(snapshotStoreOptions);
    },
    async makeDurableStateStore() {
      const durableStateOptions = MongoDurableStateStoreOptions.create()
        .withUrl(url)
        .withDatabaseName(databaseName);
      return new MongoDurableStateStore(durableStateOptions);
    },
  };

  await runScenarios(sqlPersistenceScenarios(), context);
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
