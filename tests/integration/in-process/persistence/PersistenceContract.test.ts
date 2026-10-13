import { describe, expect, test } from 'bun:test';
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
  JournalError,
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
  PersistenceExtensionId,
  RegisterSqlitePluginsOptions,
  registerSqlitePlugins,
  SQLITE_JOURNAL_PLUGIN_ID,
  SqliteJournal,
  SqliteJournalOptions,
  SqliteQuery,
  SqliteSnapshotStore,
  SqliteSnapshotStoreOptions,
  type DurableStateStore,
  type Journal,
  type PersistencePlugin,
  type SnapshotStore,
} from '../../../../src/persistence/index.js';
import {
  closeQuietly,
  durableStateContractScenarios,
  journalContractScenarios,
  snapshotContractScenarios,
  type ContractScenario,
  type DurableStateHarness,
  type JournalHarness,
  type SnapshotHarness,
} from '../../brokers/lib/persistence-contract/index.js';
import { getSqliteDriver } from '../../../../src/runtime/sqlite/index.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { ConfigObject } from '../../../../src/index.js';
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

/** Wrap a backend so the start cases can count what a store asked of it. */
type ObserveBackend = <T extends object>(backend: T) => T;

/**
 * The start contract's addition to a harness (#1473): build the store `make()`
 * builds, over a backend `observe` wraps in a call counter, so a case can see
 * what opening it cost.  Present exactly when the store defines `start()` —
 * declared rather than sniffed off the store, for the reason
 * `JournalCapabilities.compactionMark` gives: the skip decision is made
 * before `make()` runs.  A store that defines `start()` behind a harness that
 * declares nothing fails the first start case instead of skipping silently.
 */
type StartObservable<Store> = {
  readonly makeObserved?: (observe: ObserveBackend) => Promise<Store>;
};

/**
 * Counts every method call on a backend, and on every object one of those
 * calls hands back — `client.db()`, `driver.open()`, `db.prepare()`,
 * `pool.request()` — so one number says how much work a store did against
 * it, whatever the family.  Promises, arrays and plain row objects are read
 * rather than called, and pass through unwrapped.  Every method is bound to
 * the real target, as in `FailingPrune.ts`, so a class with genuine `#private`
 * fields (`bun:sqlite`'s `Database`) keeps working behind the proxy.
 */
class BackendCallCounter {
  calls = 0;
  readonly observe: ObserveBackend = <T extends object>(backend: T): T => this.wrap(backend);

  private wrap<T extends object>(target: T): T {
    return new Proxy(target, {
      get: (object, property) => {
        const value: unknown = Reflect.get(object, property);
        if (typeof value !== 'function') return value;
        const method = value as (...callArguments: unknown[]) => unknown;
        return (...callArguments: unknown[]): unknown => {
          this.calls++;
          const result = method.apply(object, callArguments);
          return isCallableInstance(result) ? this.wrap(result) : result;
        };
      },
    });
  }
}

/** A class instance a store will call methods on — not a promise, an array or a plain row. */
function isCallableInstance(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  if (value instanceof Promise || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype !== Object.prototype && prototype !== null;
}

/**
 * An `application.conf` that selects the SQLite journal and says nothing else —
 * the whole wiring for the arm below, with no options in code at all — and the
 * `plugins` slot that registers it inside `create` (#1473).
 *
 * Deliberately sets no leaf under `journal.sqlite`: the shipped block already
 * carries `events-table` and `busy-timeout`, and leaving `path` at its `""`
 * placeholder is what gives each `make()` its own anonymous database.
 */
function hoconOnlySqliteOptions(plugin: PersistencePlugin): ActorSystemOptions {
  const config = {
    'actor-ts': { persistence: { journal: { plugin: SQLITE_JOURNAL_PLUGIN_ID } } },
  } as ConfigObject;
  return ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(config)
    .withPersistence({ plugins: [plugin] });
}

const journalHarnesses: ReadonlyArray<JournalHarness & StartObservable<Journal>> = [
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
    makeObserved: async (observe) => {
      const journalOptions = SqliteJournalOptions.create().withDriver(observe(await getSqliteDriver()));
      return new SqliteJournal(journalOptions);
    },
  },
  {
    // The one arm that is *selected and configured purely from HOCON* (#872).
    // Nothing here names a store, a path or a table: the plug-in is registered
    // with no options at all, and the journal comes back through
    // `actor-ts.persistence.journal.plugin` with its settings merged from
    // `actor-ts.persistence.journal.sqlite`.  SQLite is the only backend that
    // runs in-process against a real database, so it is the only one that can
    // show the config path *and* the whole journal contract without Docker.
    //
    // Kept as a second arm rather than replacing the one above, for the reason
    // the two Cassandra arms are two: the arms differ in how the store is
    // reached, and the direct constructor is the shape a test or an embedded
    // application uses.  A regression in either seam should name itself.
    label: 'SqliteJournal (from HOCON)',
    pid: namespacer('sqlite-hocon'),
    make: async () => {
      const systemOptions = hoconOnlySqliteOptions((persistence) => registerSqlitePlugins(persistence));
      const system = ActorSystem.create('persistence-contract-hocon', systemOptions);
      const journal = system.extension(PersistenceExtensionId).journal;
      // The journal owns its own SQLite handle and holds no reference to the
      // system, so the system can go now — the scenario closes the journal.
      // `path` is left at the shipped `""`, which the reader drops, so each
      // `make()` opens its own anonymous in-memory database and the scenarios
      // stay isolated exactly as the arm above.
      await system.terminate();
      return journal;
    },
    makeQuery: (journal) => new SqliteQuery(journal as SqliteJournal),
    // Still selected through HOCON; only the driver comes from code, which is
    // the one field the journal block cannot carry.
    makeObserved: async (observe) => {
      const journalOptions = SqliteJournalOptions.create().withDriver(observe(await getSqliteDriver()));
      const registerOptions = RegisterSqlitePluginsOptions.create().withJournal(journalOptions);
      const systemOptions = hoconOnlySqliteOptions((persistence) => registerSqlitePlugins(persistence, registerOptions));
      const system = ActorSystem.create('persistence-contract-hocon', systemOptions);
      const journal = system.extension(PersistenceExtensionId).journal;
      await system.terminate();
      return journal;
    },
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
    makeObserved: async (observe) => {
      const journalOptions = CassandraJournalOptions.create()
        .withContactPoints(['fake'])
        .withKeyspace('ks')
        .withClient(observe(new FakeCassandraClient()))
        .withAutoCreateKeyspace(true);
      return new CassandraJournal(journalOptions);
    },
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
    makeObserved: async (observe) => {
      const journalOptions = CassandraJournalOptions.create()
        .withContactPoints(['fake'])
        .withKeyspace('ks')
        .withClient(observe(new FakeCassandraClient()))
        .withAutoCreateKeyspace(true)
        .withUseTagIndex(true);
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
    // A second table that `delete` has to compact in step with the events —
    // exactly the shape #654 is about, and now observable (#391).
    makeQuery: (journal) => new PostgresQuery(journal as PostgresJournal),
    makeObserved: async (observe) => {
      const journalOptions = PostgresJournalOptions.create().withPool(observe(new FakePgPool()));
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
    makeObserved: async (observe) => {
      const journalOptions = LibSqlJournalOptions.create().withClient(observe(new FakeLibSqlClient()));
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
    makeObserved: async (observe) => {
      const journalOptions = D1JournalOptions.create().withClient(observe(new FakeD1Client()));
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
    makeObserved: async (observe) => {
      const journalOptions = DynamoDbJournalOptions.create().withOperations(observe(new FakeDynamoDb()));
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
    makeObserved: async (observe) => {
      const journalOptions = MongoJournalOptions.create().withClient(observe(new FakeMongoClient()));
      return new MongoJournal(journalOptions);
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
    makeObserved: async (observe) => {
      const journalOptions = MsSqlJournalOptions.create().withPool(observe(new FakeMsSqlPool()));
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
    makeObserved: async (observe) => {
      const journalOptions = MariaDbJournalOptions.create().withPool(observe(new FakeMariaDbPool()));
      return new MariaDbJournal(journalOptions);
    },
  },
];

const snapshotHarnesses: ReadonlyArray<SnapshotHarness & StartObservable<SnapshotStore>> = [
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
    makeObserved: async (observe) => {
      const storeOptions = SqliteSnapshotStoreOptions.create().withDriver(observe(await getSqliteDriver()));
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
    makeObserved: async (observe) => {
      const storeOptions = CassandraSnapshotStoreOptions.create()
        .withContactPoints(['fake'])
        .withKeyspace('ks')
        .withClient(observe(new FakeCassandraClient()))
        .withAutoCreateKeyspace(true);
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
    makeObserved: async (observe) => {
      const storeOptions = PostgresSnapshotStoreOptions.create().withPool(observe(new FakePgPool()));
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
    makeObserved: async (observe) => {
      const storeOptions = LibSqlSnapshotStoreOptions.create().withClient(observe(new FakeLibSqlClient()));
      return new LibSqlSnapshotStore(storeOptions);
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
    makeObserved: async (observe) => {
      const storeOptions = D1SnapshotStoreOptions.create().withClient(observe(new FakeD1Client()));
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
    makeObserved: async (observe) => {
      const storeOptions = DynamoDbSnapshotStoreOptions.create().withOperations(observe(new FakeDynamoDb()));
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
    makeObserved: async (observe) => {
      const storeOptions = MongoSnapshotStoreOptions.create().withClient(observe(new FakeMongoClient()));
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
    makeObserved: async (observe) => {
      const storeOptions = MsSqlSnapshotStoreOptions.create().withPool(observe(new FakeMsSqlPool()));
      return new MsSqlSnapshotStore(storeOptions);
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
    makeObserved: async (observe) => {
      const storeOptions = MariaDbSnapshotStoreOptions.create().withPool(observe(new FakeMariaDbPool()));
      return new MariaDbSnapshotStore(storeOptions);
    },
  },
];

const durableStateHarnesses: ReadonlyArray<DurableStateHarness & StartObservable<DurableStateStore>> = [
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
    makeObserved: async (observe) => {
      const storeOptions = PostgresDurableStateStoreOptions.create().withPool(observe(new FakePgPool()));
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
    // Observed through an injected handle, the store's one seam for its
    // database; an injected handle stays the caller's, so the store's close()
    // leaves this in-memory database to the garbage collector.
    makeObserved: async (observe) => {
      const database = observe((await getSqliteDriver()).open(':memory:'));
      const storeOptions = SqliteDurableStateStoreOptions.create().withDatabase(database);
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
    makeObserved: async (observe) => {
      const storeOptions = LibSqlDurableStateStoreOptions.create().withClient(observe(new FakeLibSqlClient()));
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
    makeObserved: async (observe) => {
      const storeOptions = D1DurableStateStoreOptions.create().withClient(observe(new FakeD1Client()));
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
    makeObserved: async (observe) => {
      const storeOptions = DynamoDbDurableStateStoreOptions.create().withOperations(observe(new FakeDynamoDb()));
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
    makeObserved: async (observe) => {
      const storeOptions = MongoDurableStateStoreOptions.create().withClient(observe(new FakeMongoClient()));
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
    makeObserved: async (observe) => {
      const storeOptions = MsSqlDurableStateStoreOptions.create().withPool(observe(new FakeMsSqlPool()));
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
    makeObserved: async (observe) => {
      const storeOptions = MariaDbDurableStateStoreOptions.create().withPool(observe(new FakeMariaDbPool()));
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

/**
 * `start` as all three contracts declare it.  Spelled as indexed accesses on
 * purpose: the day one contract stops declaring the member, this line stops
 * compiling under `typecheck:dev`, instead of the cases below quietly typing
 * `start` from their own constraint.
 */
type DeclaredStart = Journal['start'] & SnapshotStore['start'] & DurableStateStore['start'];

/** What the start cases need from a store, whichever contract it implements. */
type StartableStore = {
  readonly start?: DeclaredStart;
  readonly close?: () => Promise<void>;
};

/** The part of a harness the start cases use. */
interface StartHarness<Store> extends StartObservable<Store> {
  readonly label: string;
  pid(name: string): string;
  make(): Promise<Store>;
}

/** The start cases, named once so a harness without `start()` skips exactly these. */
const START_CASES = {
  declared: 'declares makeObserved exactly when its store defines start()',
  openOnce: 'start(): two concurrent calls open once, and a third opens nothing',
  reuse: 'start(): the next operation reuses the open',
  closed: 'start(): after close() it rejects and touches nothing',
} as const;

/** The store's start(), which the `declared` case has already proven present. */
function startOf(store: StartableStore): () => Promise<void> {
  const start = store.start;
  if (start === undefined) throw new Error('store has no start() although its harness declares makeObserved');
  return () => start.call(store);
}

/**
 * The optional `start()` of the three store contracts (#1473), bound to every
 * harness above.  "Opens once" is measured as the backend calls a start costs:
 * two concurrent starts must cost what one does, and a start on an open store
 * nothing.  "Reuses the open" compares an eager store against a lazy one — a
 * start followed by the first read must cost exactly what that first read
 * alone costs a fresh store, which also holds for a store whose first read
 * warms a cache of its own.
 */
function bindStart<Store extends StartableStore>(
  contract: string,
  harnesses: ReadonlyArray<StartHarness<Store>>,
  read: (store: Store, persistenceId: string) => Promise<unknown>,
): void {
  for (const harness of harnesses) {
    describe(`${contract} start contract — ${harness.label}`, () => {
      test(START_CASES.declared, async () => {
        const store = await harness.make();
        try {
          expect(typeof store.start === 'function').toBe(harness.makeObserved !== undefined);
          if (harness.makeObserved === undefined) return;
          // The observed builder builds the same store, not a stand-in.
          const observed = await harness.makeObserved(new BackendCallCounter().observe);
          try {
            expect(observed.constructor).toBe(store.constructor);
          } finally {
            await closeQuietly(observed);
          }
        } finally {
          await closeQuietly(store);
        }
      });

      const makeObserved = harness.makeObserved;
      if (makeObserved === undefined) {
        for (const name of [START_CASES.openOnce, START_CASES.reuse, START_CASES.closed]) {
          test.skip(`${name} (no start(): nothing to open eagerly)`, () => { /* capability gap */ });
        }
        return;
      }

      test(START_CASES.openOnce, async () => {
        const alone = new BackendCallCounter();
        const single = await makeObserved(alone.observe);
        const together = new BackendCallCounter();
        const racing = await makeObserved(together.observe);
        try {
          await startOf(single)();
          await Promise.all([startOf(racing)(), startOf(racing)()]);
          // The counter saw the open at all — otherwise every equality below is 0 = 0.
          expect(alone.calls).toBeGreaterThan(0);
          expect(together.calls).toBe(alone.calls);
          await startOf(racing)();
          expect(together.calls).toBe(alone.calls);
        } finally {
          await closeQuietly(single);
          await closeQuietly(racing);
        }
      });

      test(START_CASES.reuse, async () => {
        const persistenceId = harness.pid('start-reuse');
        const lazy = new BackendCallCounter();
        const lazyStore = await makeObserved(lazy.observe);
        const eager = new BackendCallCounter();
        const eagerStore = await makeObserved(eager.observe);
        try {
          await read(lazyStore, persistenceId);
          await startOf(eagerStore)();
          const startCost = eager.calls;
          await read(eagerStore, persistenceId);
          expect(startCost).toBeGreaterThan(0);
          expect(eager.calls).toBe(lazy.calls);
        } finally {
          await closeQuietly(lazyStore);
          await closeQuietly(eagerStore);
        }
      });

      test(START_CASES.closed, async () => {
        const counter = new BackendCallCounter();
        const started = await makeObserved(counter.observe);
        await startOf(started)();
        await closeQuietly(started);
        const afterClose = counter.calls;
        const failure = await startOf(started)().then(() => null, (e: unknown) => e);
        expect(failure).toBeInstanceOf(JournalError);
        expect((failure as Error).message).toMatch(/is closed/);
        expect(counter.calls).toBe(afterClose);

        // Closed before it ever started: still a rejection, and still no open.
        const untouched = new BackendCallCounter();
        const neverStarted = await makeObserved(untouched.observe);
        await closeQuietly(neverStarted);
        const neverStartedFailure = await startOf(neverStarted)().then(() => null, (e: unknown) => e);
        expect(neverStartedFailure).toBeInstanceOf(JournalError);
        expect(untouched.calls).toBe(0);
      });
    });
  }
}

bindStart<Journal>('Journal', journalHarnesses, (journal, persistenceId) => journal.highestSeq(persistenceId));
bindStart<SnapshotStore>('SnapshotStore', snapshotHarnesses, (store, persistenceId) => store.loadLatest(persistenceId));
bindStart<DurableStateStore>('DurableStateStore', durableStateHarnesses, (store, persistenceId) => store.load(persistenceId));
