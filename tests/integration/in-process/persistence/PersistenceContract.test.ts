import { describe, test } from 'bun:test';
import {
  CassandraJournal,
  CassandraJournalOptions,
  CassandraSnapshotStore,
  CassandraSnapshotStoreOptions,
  InMemoryDurableStateStore,
  InMemoryJournal,
  InMemorySnapshotStore,
  LibSqlDurableStateStore,
  LibSqlDurableStateStoreOptions,
  LibSqlJournal,
  LibSqlJournalOptions,
  LibSqlSnapshotStore,
  LibSqlSnapshotStoreOptions,
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
  MariaDbSnapshotStore,
  MariaDbSnapshotStoreOptions,
  PostgresDurableStateStore,
  PostgresDurableStateStoreOptions,
  PostgresJournal,
  PostgresJournalOptions,
  PostgresSnapshotStore,
  PostgresSnapshotStoreOptions,
  SqliteJournal,
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
import { FakeLibSqlClient } from './FakeLibSqlClient.js';
import { FakeMariaDbPool } from './FakeMariaDbPool.js';
import { FakeMsSqlPool } from './FakeMsSqlPool.js';
import { FakePgPool } from './FakePgPool.js';

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
 * `brokers/lib/persistence-contract.ts`.
 */

/** In-process stores start empty, so a stable namespace is enough. */
const namespacer = (label: string) => (name: string): string => `${label}:${name}`;

const journalHarnesses: ReadonlyArray<JournalHarness> = [
  {
    label: 'InMemoryJournal',
    pid: namespacer('inmem'),
    make: async () => new InMemoryJournal(),
  },
  {
    label: 'SqliteJournal',
    pid: namespacer('sqlite'),
    make: async () => new SqliteJournal(),
  },
  {
    label: 'CassandraJournal',
    pid: namespacer('cassandra'),
    // `append` reads the max-sequence metadata and then writes the events
    // batch unconditionally — no lightweight transaction behind it — so two
    // writers that agree on the head both pass the check and the second
    // overwrites the first at the same (persistence_id, sequence_nr).  The
    // relational backends survive this because their primary key rejects the
    // loser; Cassandra has no equivalent here.  A real limitation, gated rather
    // than hidden: making it an `INSERT … IF NOT EXISTS` is a Paxos round-trip
    // per event and a decision of its own.
    capabilities: { serializesConcurrentAppends: false },
    make: async () => {
      const journalOptions = CassandraJournalOptions.create()
        .withContactPoints(['fake'])
        .withKeyspace('ks')
        .withClient(new FakeCassandraClient())
        .withAutoCreateKeyspace(true);
      return new CassandraJournal(journalOptions);
    },
  },
  {
    label: 'PostgresJournal',
    pid: namespacer('pg'),
    make: async () => {
      const journalOptions = PostgresJournalOptions.create()
        .withPool(new FakePgPool());
      return new PostgresJournal(journalOptions);
    },
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
  },
];

const snapshotHarnesses: ReadonlyArray<SnapshotHarness> = [
  {
    label: 'InMemorySnapshotStore',
    pid: namespacer('inmem'),
    // The reference store deliberately keeps every snapshot.
    capabilities: { keepN: 'none' },
    make: async () => new InMemorySnapshotStore(),
  },
  {
    label: 'SqliteSnapshotStore',
    pid: namespacer('sqlite'),
    capabilities: { keepN: 'configurable' },
    make: async (keepN) => {
      const storeOptions = SqliteSnapshotStoreOptions.create();
      return new SqliteSnapshotStore(keepN === undefined ? storeOptions : storeOptions.withKeepN(keepN));
    },
  },
  {
    label: 'CassandraSnapshotStore',
    pid: namespacer('cassandra'),
    capabilities: { keepN: 'configurable' },
    make: async (keepN) => {
      const storeOptions = CassandraSnapshotStoreOptions.create()
        .withContactPoints(['fake'])
        .withKeyspace('ks')
        .withClient(new FakeCassandraClient())
        .withAutoCreateKeyspace(true);
      return new CassandraSnapshotStore(keepN === undefined ? storeOptions : storeOptions.withKeepN(keepN));
    },
  },
  {
    label: 'PostgresSnapshotStore',
    pid: namespacer('pg'),
    capabilities: { keepN: 'configurable' },
    make: async (keepN) => {
      const storeOptions = PostgresSnapshotStoreOptions.create()
        .withPool(new FakePgPool());
      return new PostgresSnapshotStore(keepN === undefined ? storeOptions : storeOptions.withKeepN(keepN));
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
    capabilities: { keepN: 'configurable' },
    make: async (keepN) => {
      const storeOptions = MariaDbSnapshotStoreOptions.create()
        .withPool(new FakeMariaDbPool());
      return new MariaDbSnapshotStore(keepN === undefined ? storeOptions : storeOptions.withKeepN(keepN));
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
    label: 'LibSqlDurableStateStore',
    pid: namespacer('libsql'),
    make: async () => {
      const storeOptions = LibSqlDurableStateStoreOptions.create()
        .withClient(new FakeLibSqlClient());
      return new LibSqlDurableStateStore(storeOptions);
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
