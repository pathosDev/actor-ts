import { describe, test } from 'bun:test';
import {
  CassandraJournal,
  CassandraJournalOptions,
  CassandraQuery,
  CassandraSnapshotStore,
  CassandraSnapshotStoreOptions,
  D1DurableStateStore,
  D1DurableStateStoreOptions,
  D1Journal,
  D1JournalOptions,
  D1SnapshotStore,
  D1SnapshotStoreOptions,
  DynamoDbDurableStateStore,
  DynamoDbDurableStateStoreOptions,
  DynamoDbJournal,
  DynamoDbJournalOptions,
  DynamoDbSnapshotStore,
  DynamoDbSnapshotStoreOptions,
  InMemoryDurableStateStore,
  InMemoryJournal,
  InMemoryQuery,
  InMemorySnapshotStore,
  InMemorySnapshotStoreOptions,
  LibSqlDurableStateStore,
  LibSqlDurableStateStoreOptions,
  SqliteDurableStateStore,
  SqliteDurableStateStoreOptions,
  LibSqlJournal,
  LibSqlJournalOptions,
  LibSqlSnapshotStore,
  LibSqlSnapshotStoreOptions,
  MongoDurableStateStore,
  MongoDurableStateStoreOptions,
  MongoJournal,
  MongoJournalOptions,
  MongoQuery,
  MongoSnapshotStore,
  MongoSnapshotStoreOptions,
  MsSqlDurableStateStore,
  MsSqlDurableStateStoreOptions,
  MsSqlJournal,
  MsSqlJournalOptions,
  MsSqlSnapshotStore,
  MsSqlSnapshotStoreOptions,
  MariaDbDurableStateStore,
  MariaDbDurableStateStoreOptions,
  MariaDbJournal,
  MariaDbJournalOptions,
  MariaDbQuery,
  MariaDbSnapshotStore,
  MariaDbSnapshotStoreOptions,
  PostgresDurableStateStore,
  PostgresDurableStateStoreOptions,
  PostgresJournal,
  PostgresJournalOptions,
  PostgresQuery,
  PostgresSnapshotStore,
  PostgresSnapshotStoreOptions,
  SqliteJournal,
  SqliteQuery,
  SqliteSnapshotStore,
  SqliteSnapshotStoreOptions,
} from '../../../../src/persistence/index.js';
import {
  durableStateContractScenarios,
  journalContractScenarios,
  snapshotContractScenarios,
  type ContractScenario,
  type DurableStateHarness,
  type JournalHarness,
  type SnapshotHarness,
} from '../../brokers/lib/persistence-contract/index.js';
import { FakeCassandraClient } from './FakeCassandraClient.js';
import { FakeD1Client } from './FakeD1Client.js';
import { FakeDynamoDb } from './FakeDynamoDb.js';
import { FakeLibSqlClient } from './FakeLibSqlClient.js';
import { FakeMariaDbPool } from './FakeMariaDbPool.js';
import { FakeMongoClient } from './FakeMongoClient.js';
import { FakeMsSqlPool } from './FakeMsSqlPool.js';
import { FakePgPool } from './FakePgPool.js';
import {
  cassandraClientWithFailingPrune,
  dynamoDbWithFailingPrune,
  mongoClientWithFailingPrune,
  relationalClientWithFailingPrune,
  sqliteDriverWithFailingPrune,
} from './FailingPrune.js';

/**
 * The parameterized persistence contract (#390), bound to `bun test`.
 *
 * Every `Journal` / `SnapshotStore` / `DurableStateStore` implementation runs
 * against one shared scenario set, so a behaviour cannot be verified for one
 * backend and quietly missing in another — the failure mode this replaces,
 * where `PostgresBackends.test.ts` and `MariaDbBackends.test.ts` were
 * hand-copied and had already drifted apart.
 *
 * Relational backends are driven by their in-process fake pools; the live
 * Docker suites run the identical scenarios against real databases via
 * `brokers/lib/PersistenceContract.ts`.
 */

/** In-process stores start empty, so a stable namespace is enough. */
const namespacer = (label: string) => (name: string): string => `${label}:${name}`;

const journalHarnesses: ReadonlyArray<JournalHarness> = [
  {
    label: 'InMemoryJournal',
    pid: namespacer('inmem'),
    make: async () => new InMemoryJournal(),
    // The reference query walks the journal itself, so it has no index that
    // could go stale — which is exactly what makes it the oracle for the
    // scenarios the indexed backends have to match.
    makeQuery: (journal) => new InMemoryQuery(journal),
  },
  {
    label: 'SqliteJournal',
    pid: namespacer('sqlite'),
    make: async () => new SqliteJournal(),
    makeQuery: (journal) => new SqliteQuery(journal as SqliteJournal),
  },
  {
    label: 'CassandraJournal',
    pid: namespacer('cassandra'),
    make: async () => {
      const journalOptions = CassandraJournalOptions.create()
        .withContactPoints(['fake'])
        .withKeyspace('ks')
        .withClient(new FakeCassandraClient())
        .withAutoCreateKeyspace(true);
      return new CassandraJournal(journalOptions);
    },
    // Default config: no side table, so `CassandraQuery` falls back to the
    // journal-walking scan.  Kept as its own harness because it is the shape
    // most deployments run, and the one below is the shape that broke.
    makeQuery: (journal) => new CassandraQuery(journal as CassandraJournal),
  },
  {
    // Second Cassandra harness rather than flipping the flag on the one
    // above: `useTagIndex` selects a genuinely different storage layout —
    // a separate `events_by_tag` table that `delete` has to compact (#654) —
    // and both layouts owe the full journal contract.  With only the default
    // harness the tag-index delete path had no coverage at all, and the new
    // query-side scenario would have passed vacuously against the fallback
    // scan.
    label: 'CassandraJournal (tag index)',
    pid: namespacer('cassandra-tag-index'),
    make: async () => {
      const journalOptions = CassandraJournalOptions.create()
        .withContactPoints(['fake'])
        .withKeyspace('ks')
        .withClient(new FakeCassandraClient())
        .withAutoCreateKeyspace(true)
        .withUseTagIndex(true);
      return new CassandraJournal(journalOptions);
    },
    makeQuery: (journal) => new CassandraQuery(journal as CassandraJournal),
  },
  {
    label: 'PostgresJournal',
    pid: namespacer('pg'),
    make: async () => {
      const journalOptions = PostgresJournalOptions.create()
        .withPool(new FakePgPool());
      return new PostgresJournal(journalOptions);
    },
    // A second table that `delete` has to compact in step with the events —
    // exactly the shape #654 is about, and now observable (#391).
    makeQuery: (journal) => new PostgresQuery(journal as PostgresJournal),
  },
  {
    label: 'LibSqlJournal',
    pid: namespacer('libsql'),
    make: async () => {
      const journalOptions = LibSqlJournalOptions.create()
        .withClient(new FakeLibSqlClient());
      return new LibSqlJournal(journalOptions);
    },
  },
  {
    label: 'D1Journal',
    pid: namespacer('d1'),
    make: async () => {
      const journalOptions = D1JournalOptions.create()
        .withClient(new FakeD1Client());
      return new D1Journal(journalOptions);
    },
  },
  {
    label: 'DynamoDbJournal',
    pid: namespacer('dynamodb'),
    make: async () => {
      const journalOptions = DynamoDbJournalOptions.create()
        .withOperations(new FakeDynamoDb());
      return new DynamoDbJournal(journalOptions);
    },
  },
  {
    label: 'MongoJournal',
    pid: namespacer('mongo'),
    make: async () => {
      const journalOptions = MongoJournalOptions.create()
        .withClient(new FakeMongoClient());
      return new MongoJournal(journalOptions);
    },
    // Multikey index over the event document itself — no second collection,
    // so a deleted event leaves the tag index by construction.  Worth running
    // the query-side scenarios against anyway: that is the property being
    // asserted, not an assumption the contract gets to make.
    makeQuery: (journal) => new MongoQuery(journal as MongoJournal),
  },
  {
    label: 'MsSqlJournal',
    pid: namespacer('mssql'),
    make: async () => {
      const journalOptions = MsSqlJournalOptions.create()
        .withPool(new FakeMsSqlPool());
      return new MsSqlJournal(journalOptions);
    },
  },
  {
    label: 'MariaDbJournal',
    pid: namespacer('mariadb'),
    make: async () => {
      const journalOptions = MariaDbJournalOptions.create()
        .withPool(new FakeMariaDbPool());
      return new MariaDbJournal(journalOptions);
    },
    makeQuery: (journal) => new MariaDbQuery(journal as MariaDbJournal),
  },
];

const snapshotHarnesses: ReadonlyArray<SnapshotHarness> = [
  {
    label: 'InMemorySnapshotStore',
    pid: namespacer('inmem'),
    // Unset `keepN` keeps every snapshot — the reference store's default
    // stays unbounded (#493) — but the bound is honoured when asked for,
    // so both keepN scenarios apply.
    capabilities: { keepN: 'configurable' },
    make: async (keepN) => {
      const storeOptions = InMemorySnapshotStoreOptions.create();
      return new InMemorySnapshotStore(keepN === undefined ? storeOptions : storeOptions.withKeepN(keepN));
    },
  },
  {
    label: 'SqliteSnapshotStore',
    pid: namespacer('sqlite'),
    capabilities: { keepN: 'configurable', pruneFailure: 'injectable' },
    make: async (keepN) => {
      const storeOptions = SqliteSnapshotStoreOptions.create();
      return new SqliteSnapshotStore(keepN === undefined ? storeOptions : storeOptions.withKeepN(keepN));
    },
    makeWithFailingPrune: async (keepN) => {
      const storeOptions = SqliteSnapshotStoreOptions.create()
        .withKeepN(keepN)
        .withDriver(await sqliteDriverWithFailingPrune());
      return new SqliteSnapshotStore(storeOptions);
    },
  },
  {
    label: 'CassandraSnapshotStore',
    pid: namespacer('cassandra'),
    capabilities: { keepN: 'configurable', pruneFailure: 'injectable' },
    make: async (keepN) => {
      const storeOptions = CassandraSnapshotStoreOptions.create()
        .withContactPoints(['fake'])
        .withKeyspace('ks')
        .withClient(new FakeCassandraClient())
        .withAutoCreateKeyspace(true);
      return new CassandraSnapshotStore(keepN === undefined ? storeOptions : storeOptions.withKeepN(keepN));
    },
    makeWithFailingPrune: async (keepN) => {
      const storeOptions = CassandraSnapshotStoreOptions.create()
        .withContactPoints(['fake'])
        .withKeyspace('ks')
        .withClient(cassandraClientWithFailingPrune(new FakeCassandraClient()))
        .withAutoCreateKeyspace(true)
        .withKeepN(keepN);
      return new CassandraSnapshotStore(storeOptions);
    },
  },
  {
    label: 'PostgresSnapshotStore',
    pid: namespacer('pg'),
    capabilities: { keepN: 'configurable', pruneFailure: 'injectable' },
    make: async (keepN) => {
      const storeOptions = PostgresSnapshotStoreOptions.create()
        .withPool(new FakePgPool());
      return new PostgresSnapshotStore(keepN === undefined ? storeOptions : storeOptions.withKeepN(keepN));
    },
    makeWithFailingPrune: async (keepN) => {
      const storeOptions = PostgresSnapshotStoreOptions.create()
        .withPool(relationalClientWithFailingPrune(new FakePgPool()))
        .withKeepN(keepN);
      return new PostgresSnapshotStore(storeOptions);
    },
  },
  {
    label: 'LibSqlSnapshotStore',
    pid: namespacer('libsql'),
    capabilities: { keepN: 'configurable' },
    make: async (keepN) => {
      const storeOptions = LibSqlSnapshotStoreOptions.create()
        .withClient(new FakeLibSqlClient());
      return new LibSqlSnapshotStore(keepN === undefined ? storeOptions : storeOptions.withKeepN(keepN));
    },
  },
  {
    label: 'D1SnapshotStore',
    pid: namespacer('d1'),
    capabilities: { keepN: 'configurable', pruneFailure: 'injectable' },
    make: async (keepN) => {
      const storeOptions = D1SnapshotStoreOptions.create()
        .withClient(new FakeD1Client());
      return new D1SnapshotStore(keepN === undefined ? storeOptions : storeOptions.withKeepN(keepN));
    },
    makeWithFailingPrune: async (keepN) => {
      const storeOptions = D1SnapshotStoreOptions.create()
        .withClient(relationalClientWithFailingPrune(new FakeD1Client()))
        .withKeepN(keepN);
      return new D1SnapshotStore(storeOptions);
    },
  },
  {
    label: 'DynamoDbSnapshotStore',
    pid: namespacer('dynamodb'),
    capabilities: { keepN: 'configurable', pruneFailure: 'injectable' },
    make: async (keepN) => {
      const storeOptions = DynamoDbSnapshotStoreOptions.create()
        .withOperations(new FakeDynamoDb());
      return new DynamoDbSnapshotStore(keepN === undefined ? storeOptions : storeOptions.withKeepN(keepN));
    },
    makeWithFailingPrune: async (keepN) => {
      const storeOptions = DynamoDbSnapshotStoreOptions.create()
        .withOperations(dynamoDbWithFailingPrune(new FakeDynamoDb()))
        .withKeepN(keepN);
      return new DynamoDbSnapshotStore(storeOptions);
    },
  },
  {
    label: 'MongoSnapshotStore',
    pid: namespacer('mongo'),
    capabilities: { keepN: 'configurable', pruneFailure: 'injectable' },
    make: async (keepN) => {
      const storeOptions = MongoSnapshotStoreOptions.create()
        .withClient(new FakeMongoClient());
      return new MongoSnapshotStore(keepN === undefined ? storeOptions : storeOptions.withKeepN(keepN));
    },
    makeWithFailingPrune: async (keepN) => {
      const storeOptions = MongoSnapshotStoreOptions.create()
        .withClient(mongoClientWithFailingPrune(new FakeMongoClient()))
        .withKeepN(keepN);
      return new MongoSnapshotStore(storeOptions);
    },
  },
  {
    label: 'MsSqlSnapshotStore',
    pid: namespacer('mssql'),
    capabilities: { keepN: 'configurable' },
    make: async (keepN) => {
      const storeOptions = MsSqlSnapshotStoreOptions.create()
        .withPool(new FakeMsSqlPool());
      return new MsSqlSnapshotStore(keepN === undefined ? storeOptions : storeOptions.withKeepN(keepN));
    },
  },
  {
    label: 'MariaDbSnapshotStore',
    pid: namespacer('mariadb'),
    capabilities: { keepN: 'configurable', pruneFailure: 'injectable' },
    make: async (keepN) => {
      const storeOptions = MariaDbSnapshotStoreOptions.create()
        .withPool(new FakeMariaDbPool());
      return new MariaDbSnapshotStore(keepN === undefined ? storeOptions : storeOptions.withKeepN(keepN));
    },
    makeWithFailingPrune: async (keepN) => {
      const storeOptions = MariaDbSnapshotStoreOptions.create()
        .withPool(relationalClientWithFailingPrune(new FakeMariaDbPool()))
        .withKeepN(keepN);
      return new MariaDbSnapshotStore(storeOptions);
    },
  },
];

const durableStateHarnesses: ReadonlyArray<DurableStateHarness> = [
  {
    label: 'InMemoryDurableStateStore',
    pid: namespacer('inmem'),
    make: async () => new InMemoryDurableStateStore(),
  },
  {
    label: 'PostgresDurableStateStore',
    pid: namespacer('pg'),
    make: async () => {
      const storeOptions = PostgresDurableStateStoreOptions.create()
        .withPool(new FakePgPool());
      return new PostgresDurableStateStore(storeOptions);
    },
  },
  {
    // The only durable-state harness running against a real SQL engine rather
    // than a fake: a local SQLite database needs no container and no network,
    // so `:memory:` exercises the actual statements the dialect emits.  A fresh
    // database per `make()` keeps scenarios isolated.
    label: 'SqliteDurableStateStore',
    pid: namespacer('sqlite'),
    make: async () => {
      const storeOptions = SqliteDurableStateStoreOptions.create().withPath(':memory:');
      return new SqliteDurableStateStore(storeOptions);
    },
  },
  {
    label: 'LibSqlDurableStateStore',
    pid: namespacer('libsql'),
    make: async () => {
      const storeOptions = LibSqlDurableStateStoreOptions.create()
        .withClient(new FakeLibSqlClient());
      return new LibSqlDurableStateStore(storeOptions);
    },
  },
  {
    label: 'D1DurableStateStore',
    pid: namespacer('d1'),
    make: async () => {
      const storeOptions = D1DurableStateStoreOptions.create()
        .withClient(new FakeD1Client());
      return new D1DurableStateStore(storeOptions);
    },
  },
  {
    label: 'DynamoDbDurableStateStore',
    pid: namespacer('dynamodb'),
    make: async () => {
      const storeOptions = DynamoDbDurableStateStoreOptions.create()
        .withOperations(new FakeDynamoDb());
      return new DynamoDbDurableStateStore(storeOptions);
    },
  },
  {
    label: 'MongoDurableStateStore',
    pid: namespacer('mongo'),
    make: async () => {
      const storeOptions = MongoDurableStateStoreOptions.create()
        .withClient(new FakeMongoClient());
      return new MongoDurableStateStore(storeOptions);
    },
  },
  {
    label: 'MsSqlDurableStateStore',
    pid: namespacer('mssql'),
    make: async () => {
      const storeOptions = MsSqlDurableStateStoreOptions.create()
        .withPool(new FakeMsSqlPool());
      return new MsSqlDurableStateStore(storeOptions);
    },
  },
  {
    label: 'MariaDbDurableStateStore',
    pid: namespacer('mariadb'),
    make: async () => {
      const storeOptions = MariaDbDurableStateStoreOptions.create()
        .withPool(new FakeMariaDbPool());
      return new MariaDbDurableStateStore(storeOptions);
    },
  },
];

function bind<Harness extends { readonly label: string }>(
  contract: string,
  harnesses: ReadonlyArray<Harness>,
  scenarios: ReadonlyArray<ContractScenario<Harness>>,
): void {
  for (const harness of harnesses) {
    describe(`${contract} contract — ${harness.label}`, () => {
      for (const scenario of scenarios) {
        const skipReason = scenario.skip?.(harness) ?? null;
        if (skipReason !== null) {
          test.skip(`${scenario.name} (${skipReason})`, () => { /* capability gap */ });
          continue;
        }
        test(scenario.name, async () => { await scenario.run(harness); });
      }
    });
  }
}

bind('Journal', journalHarnesses, journalContractScenarios());
bind('SnapshotStore', snapshotHarnesses, snapshotContractScenarios());
bind('DurableStateStore', durableStateHarnesses, durableStateContractScenarios());
