import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions, type ActorSystemOptionsBuilder } from '../../../../src/ActorSystemOptions.js';
import { InMemoryCache } from '../../../../src/cache/InMemoryCache.js';
import type { ConfigObject } from '../../../../src/config/HoconParser.js';
import { CoordinatedShutdownId, Phases, type Reason } from '../../../../src/CoordinatedShutdown.js';
import { CoordinatedStartupId, StartupFailedReason } from '../../../../src/CoordinatedStartup.js';
import {
  CoordinatedStartupOptions,
  StartupPhases,
  type StartupTaskRegistration,
} from '../../../../src/CoordinatedStartupOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  CASSANDRA_JOURNAL_PLUGIN_ID,
  CASSANDRA_SNAPSHOT_PLUGIN_ID,
  CachedSnapshotStore,
  CachedSnapshotStoreOptions,
  CassandraJournalOptions,
  CassandraSnapshotStore,
  CassandraSnapshotStoreOptions,
  InMemoryJournal,
  PersistenceBehaviorOptions,
  PersistenceExtensionId,
  PersistentActor,
  POSTGRES_DURABLE_STATE_PLUGIN_ID,
  POSTGRES_JOURNAL_PLUGIN_ID,
  POSTGRES_SNAPSHOT_PLUGIN_ID,
  RegisterCassandraPluginsOptions,
  RegisterPostgresPluginsOptions,
  registerCassandraPlugins,
  registerPostgresPlugins,
  type PersistencePlugin,
} from '../../../../src/persistence/index.js';
import type { PgClientLike, PgQueryResult } from '../../../../src/persistence/journals/PostgresClient.js';
import { FakeCassandraClient } from './FakeCassandraClient.js';
import { FakePgPool } from './FakePgPool.js';

/**
 * The selected stores are opened as part of the startup (#1473): the system
 * resolves the journal, the snapshot store and the durable-state store inside
 * `create` and opens them in the `persistence-start` phase, so a database
 * that cannot be reached fails `whenReady()` — and takes the system down —
 * instead of the first persisted message.
 *
 * Every wait is on a promise the code under test settles; none is on the
 * clock.
 */

/** The startup task that opens the stores, as the startup error and `StartupFailedReason` name it. */
const WARM_UP_TASK = 'persistence-warm-up';
/** The task a plug-in's returned promise is awaited under. */
const PLUGINS_TASK = 'persistence-plugins';

const REFUSED = 'connect ECONNREFUSED 127.0.0.1:5432';

function quietOptions(config: ConfigObject = {}): ActorSystemOptionsBuilder {
  return ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(config);
}

/** HOCON selecting `journal`, and optionally a snapshot store and a durable-state store. */
function selecting(selection: { journal?: string; snapshotStore?: string; durableState?: string }): ConfigObject {
  const persistence: ConfigObject = {};
  if (selection.journal !== undefined) persistence.journal = { plugin: selection.journal };
  if (selection.snapshotStore !== undefined) persistence['snapshot-store'] = { plugin: selection.snapshotStore };
  if (selection.durableState !== undefined) persistence['durable-state'] = { plugin: selection.durableState };
  return { 'actor-ts': { persistence } };
}

const POSTGRES_SELECTED = selecting({
  journal: POSTGRES_JOURNAL_PLUGIN_ID,
  snapshotStore: POSTGRES_SNAPSHOT_PLUGIN_ID,
  durableState: POSTGRES_DURABLE_STATE_PLUGIN_ID,
});

/** The Postgres plug-in over `pool`, as an entry of the `plugins` slot. */
function postgresOver(pool: FakePgPool): PersistencePlugin {
  const registerOptions = RegisterPostgresPluginsOptions.create().withPool(pool);
  return (persistence) => registerPostgresPlugins(persistence, registerOptions);
}

/** The tables a Postgres pool was asked to create, one entry per `CREATE TABLE`. */
function createdTables(pool: FakePgPool): string[] {
  return pool.log
    .map((statement) => /^CREATE TABLE IF NOT EXISTS (\w+)/i.exec(statement)?.[1])
    .filter((table): table is string => table !== undefined);
}

/** The tables a Cassandra client was asked to create, keyspace-qualified. */
function cassandraTables(client: FakeCassandraClient): string[] {
  return client.log
    .map((statement) => /^CREATE TABLE IF NOT EXISTS ([\w.]+)/i.exec(statement)?.[1])
    .filter((table): table is string => table !== undefined);
}

/** A database that is not there: every statement fails the way `pg` reports a refused connection. */
class RefusingPgPool extends FakePgPool {
  override async query(): Promise<PgQueryResult> {
    throw new Error(REFUSED);
  }

  override async connect(): Promise<PgClientLike> {
    throw new Error(REFUSED);
  }
}

/** Counts the connects a store makes on the client it was handed. */
class ConnectCountingCassandraClient extends FakeCassandraClient {
  connects = 0;

  override async connect(): Promise<void> {
    this.connects++;
    await super.connect();
  }
}

/** A journal with something to open, counting the times it is asked to. */
class StartCountingJournal extends InMemoryJournal {
  starts = 0;

  async start(): Promise<void> {
    this.starts++;
  }
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const STILL_PENDING = Symbol('still pending');

/** Whether `promise` has settled by now — one that has wins the race, its reaction is queued first. */
async function settledState(promise: Promise<unknown>): Promise<'pending' | 'resolved' | 'rejected'> {
  try {
    const value = await Promise.race([promise, Promise.resolve(STILL_PENDING)]);
    return value === STILL_PENDING ? 'pending' : 'resolved';
  } catch {
    return 'rejected';
  }
}

/** The error `promise` rejects with; fails the test when it resolves instead. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the promise to reject, and it resolved');
}

/** One macrotask turn: every microtask the code under test queued has run by then. */
function aMacrotaskLater(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve); });
}

/** Stop `system` and wait until it is down — after a failed startup it is already on its way. */
async function stopped(system: ActorSystem): Promise<void> {
  await system.terminate();
  await system.whenTerminated();
}

type CountCommand = { readonly kind: 'count' };
type TallyCommand = CountCommand;
type CountedEvent = { readonly kind: 'counted' };
type TallyEvent = CountedEvent;
type TallyState = { readonly count: number };

/** A persistent actor that says when it has recovered — its first journal read — and counts. */
class Tally extends PersistentActor<TallyCommand, TallyEvent, TallyState> {
  readonly persistenceId = 'tally-1';

  constructor(
    private readonly recovered: (state: TallyState) => void,
    private readonly counted: (state: TallyState) => void,
  ) {
    super();
  }

  initialState(): TallyState { return { count: 0 }; }

  onEvent(state: TallyState): TallyState { return { count: state.count + 1 }; }

  override onRecoveryComplete(state: TallyState): void { this.recovered(state); }

  async onCommand(_state: TallyState, command: TallyCommand): Promise<void> {
    await this.onCount(command);
  }

  private async onCount(_command: CountCommand): Promise<void> {
    await this.persist({ kind: 'counted' }, (state) => this.counted(state));
  }
}

describe('the selected stores are opened at startup', () => {
  test('a Postgres plug-in selected in HOCON has run its DDL once whenReady() resolves, with nothing persisted', async () => {
    const pool = new FakePgPool();
    const systemOptions = quietOptions(POSTGRES_SELECTED).withPersistence({ plugins: [postgresOver(pool)] });
    const system = ActorSystem.create('warm-up-postgres', systemOptions);
    try {
      await system.whenReady();

      const tables = createdTables(pool);
      expect(tables).toEqual(expect.arrayContaining(['events', 'snapshots', 'durable_state']));
      // Each table once: one open per store.
      expect(new Set(tables).size).toBe(tables.length);
      expect(pool.log.filter((statement) => /^INSERT/i.test(statement))).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('a before-system-ready task finds the tables already there', async () => {
    // The warm-up runs in persistence-start, the phase ahead of
    // before-system-ready, where a migration or a cache warm-up goes: such a
    // task reads through stores that are open instead of racing their creation.
    const pool = new FakePgPool();
    let tablesSeen: string[] = [];
    const observeTables: StartupTaskRegistration = {
      phase: StartupPhases.BeforeSystemReady,
      name: 'observe-tables',
      task: () => {
        tablesSeen = createdTables(pool);
      },
    };
    const startupOptions = CoordinatedStartupOptions.create().withTasks([observeTables]);
    const systemOptions = quietOptions(POSTGRES_SELECTED)
      .withPersistence({ plugins: [postgresOver(pool)] })
      .withCoordinatedStartup(startupOptions);
    const system = ActorSystem.create('warm-up-before-ready', systemOptions);
    try {
      await system.whenReady();

      expect(tablesSeen).toEqual(expect.arrayContaining(['events', 'snapshots', 'durable_state']));
    } finally {
      await system.terminate();
    }
  });

  test('a PersistentActor spawned on the line after create shares that single open', async () => {
    const pool = new FakePgPool();
    const systemOptions = quietOptions(POSTGRES_SELECTED).withPersistence({ plugins: [postgresOver(pool)] });
    const system = ActorSystem.create('warm-up-shared-open', systemOptions);
    const recovered = deferred<TallyState>();
    const counted = deferred<TallyState>();
    const tally = system.spawn(() => new Tally(recovered.resolve, counted.resolve), 'tally');
    try {
      await system.whenReady();
      expect((await recovered.promise).count).toBe(0);
      tally.tell({ kind: 'count' });
      expect((await counted.promise).count).toBe(1);

      // The warm-up and the actor's recovery opened the journal and the
      // snapshot store together: a second open would have run every
      // CREATE TABLE again.  The durable-state store only the warm-up opened.
      const tables = createdTables(pool);
      expect(tables.filter((table) => table === 'events')).toHaveLength(1);
      expect(tables.filter((table) => table === 'snapshots')).toHaveLength(1);
      expect(tables.filter((table) => table === 'durable_state')).toHaveLength(1);
      expect(new Set(tables).size).toBe(tables.length);
    } finally {
      await system.terminate();
    }
  });

  test('a store set in code is opened too', async () => {
    const journal = new StartCountingJournal();
    const system = ActorSystem.create('warm-up-instance', quietOptions().withPersistence({ journal }));
    try {
      await system.whenReady();
      expect(journal.starts).toBe(1);
    } finally {
      await system.terminate();
    }
  });

  test('a Cassandra pair wired through the plugins slot is started exactly once, at boot', async () => {
    const client = new ConnectCountingCassandraClient();
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('app');
    const snapshotStoreOptions = CassandraSnapshotStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('app');
    const registerOptions = RegisterCassandraPluginsOptions.create()
      .withClient(client)
      .withJournal(journalOptions)
      .withSnapshotStore(snapshotStoreOptions);
    const systemOptions = quietOptions(selecting({
      journal: CASSANDRA_JOURNAL_PLUGIN_ID,
      snapshotStore: CASSANDRA_SNAPSHOT_PLUGIN_ID,
    })).withPersistence({ plugins: [(persistence) => registerCassandraPlugins(persistence, registerOptions)] });
    const system = ActorSystem.create('warm-up-cassandra', systemOptions);
    try {
      await system.whenReady();
      // One start per store, before anything was persisted.
      expect(client.connects).toBe(2);
      const tablesAtBoot = cassandraTables(client);
      expect(tablesAtBoot.length).toBeGreaterThan(0);
      expect(new Set(tablesAtBoot).size).toBe(tablesAtBoot.length);

      // Using them starts nothing again.
      const persistence = system.extension(PersistenceExtensionId);
      await persistence.journal.append('cassandra-1', [{ event: 'hello' }], 0);
      await persistence.snapshotStore.save('cassandra-1', 1, { greeting: 'hello' });
      expect(client.connects).toBe(2);
      expect(cassandraTables(client)).toEqual(tablesAtBoot);
    } finally {
      await system.terminate();
    }
  });

  test('a snapshot store behind CachedSnapshotStore is opened through the decorator', async () => {
    const client = new ConnectCountingCassandraClient();
    const snapshotStoreOptions = CassandraSnapshotStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('app')
      .withClient(client);
    const cachedOptions = CachedSnapshotStoreOptions.create().withCache(new InMemoryCache());
    const cachedSnapshotStoreId = 'test.snapshot-store.cached-cassandra';
    const plugin: PersistencePlugin = (persistence) => persistence.registerSnapshotStore(
      cachedSnapshotStoreId,
      () => new CachedSnapshotStore(new CassandraSnapshotStore(snapshotStoreOptions), cachedOptions),
    );
    const systemOptions = quietOptions(selecting({ snapshotStore: cachedSnapshotStoreId }))
      .withPersistence({ plugins: [plugin] });
    const system = ActorSystem.create('warm-up-cached', systemOptions);
    try {
      await system.whenReady();
      expect(system.extension(PersistenceExtensionId).snapshotStore).toBeInstanceOf(CachedSnapshotStore);
      expect(client.connects).toBe(1);
      expect(cassandraTables(client).length).toBeGreaterThan(0);
    } finally {
      await system.terminate();
    }
  });

  test('the warm-up waits for a plug-in\'s pending registration before it opens anything', async () => {
    const pool = new FakePgPool();
    const probe = deferred<void>();
    const register = postgresOver(pool);
    const plugin: PersistencePlugin = (persistence) => {
      register(persistence);
      return probe.promise;
    };
    const systemOptions = quietOptions(selecting({ journal: POSTGRES_JOURNAL_PLUGIN_ID }))
      .withPersistence({ plugins: [plugin] });
    const system = ActorSystem.create('warm-up-pending', systemOptions);
    try {
      await aMacrotaskLater();
      expect(await settledState(system.whenReady())).toBe('pending');
      expect(pool.log).toEqual([]);

      probe.resolve();
      await system.whenReady();
      expect(createdTables(pool)).toContain('events');
    } finally {
      await system.terminate();
    }
  });

  test('a system with neither persistence options nor a selection does not build the extension', async () => {
    const system = ActorSystem.create('warm-up-none', quietOptions());
    try {
      expect(system.extensions.has(PersistenceExtensionId)).toBe(false);
      expect(system.extension(CoordinatedStartupId).hasTasks).toBe(false);
    } finally {
      await system.terminate();
    }
  });
});

describe('a store that cannot be opened fails the startup', () => {
  test('a pool that refuses connections rejects whenReady() naming the store, takes the system down and fails runUntilTerminated()', async () => {
    const systemOptions = quietOptions(selecting({ journal: POSTGRES_JOURNAL_PLUGIN_ID }))
      .withPersistence({ plugins: [postgresOver(new RefusingPgPool())] });
    const system = ActorSystem.create('warm-up-refused', systemOptions);
    // Registered before the first phase has had a chance to run: `create`
    // returns before any task does.
    const shutdownReasons: Reason[] = [];
    system.extension(CoordinatedShutdownId).addTask(Phases.BeforeServiceUnbind, 'observe', (reason) => {
      shutdownReasons.push(reason);
    });
    try {
      const error = await rejectionOf(system.whenReady());
      expect(error.message).toContain(`"${WARM_UP_TASK}"`);
      expect(error.message).toContain('the journal');
      expect(error.message).toContain('PostgresJournal');
      expect(error.message).toContain(`'${POSTGRES_JOURNAL_PLUGIN_ID}'`);
      expect(error.message).toContain(REFUSED);

      await system.whenTerminated();
      expect(system.isTerminated).toBe(true);
      expect(shutdownReasons).toHaveLength(1);
      const reason = shutdownReasons[0] as StartupFailedReason;
      expect(reason).toBeInstanceOf(StartupFailedReason);
      expect(reason.task).toBe(WARM_UP_TASK);
      expect(reason.phase).toBe(StartupPhases.PersistenceStart);

      // No signal handlers: the wait is all this needs to show.
      expect(await rejectionOf(system.runUntilTerminated([]))).toBe(error);
    } finally {
      await stopped(system);
    }
  });

  test('a HOCON selection nothing wired fails the startup with the Unknown-plugin message', async () => {
    const system = ActorSystem.create('warm-up-unwired', quietOptions(selecting({ journal: 'test.journal.unwired' })));
    try {
      const error = await rejectionOf(system.whenReady());
      expect(error.message).toContain(`"${WARM_UP_TASK}"`);
      expect(error.message).toContain('Unknown journal plugin \'test.journal.unwired\'');
      await system.whenTerminated();
      expect(system.isTerminated).toBe(true);
    } finally {
      await stopped(system);
    }
  });

  test('a plug-in registered on the line after create is never seen: the selection was resolved inside it', async () => {
    const lateJournalId = 'test.journal.registered-late';
    const system = ActorSystem.create('warm-up-late', quietOptions(selecting({ journal: lateJournalId })));
    system.extension(PersistenceExtensionId).registerJournal(lateJournalId, () => new StartCountingJournal());
    try {
      const error = await rejectionOf(system.whenReady());
      expect(error.message).toContain(`Unknown journal plugin '${lateJournalId}'`);
    } finally {
      await stopped(system);
    }
  });

  test('a plug-in whose registration fails is reported by its own task, and the warm-up opens nothing', async () => {
    const pool = new FakePgPool();
    const cause = new Error('the pg package is not installed');
    const register = postgresOver(pool);
    const plugin: PersistencePlugin = (persistence) => {
      register(persistence);
      return Promise.reject(cause);
    };
    const systemOptions = quietOptions(selecting({ journal: POSTGRES_JOURNAL_PLUGIN_ID }))
      .withPersistence({ plugins: [plugin] });
    const system = ActorSystem.create('warm-up-registration-failed', systemOptions);
    try {
      const error = await rejectionOf(system.whenReady());
      expect(error.cause).toBe(cause);
      expect(error.message).toContain(`"${PLUGINS_TASK}"`);
      await system.whenTerminated();
      await aMacrotaskLater();
      expect(pool.log).toEqual([]);
    } finally {
      await stopped(system);
    }
  });
});

describe('behavior autoStart false', () => {
  test('opens nothing before the first operation', async () => {
    const pool = new FakePgPool();
    const behavior = PersistenceBehaviorOptions.create().withAutoStart(false);
    const systemOptions = quietOptions(POSTGRES_SELECTED).withPersistence({ plugins: [postgresOver(pool)], behavior });
    const system = ActorSystem.create('warm-up-off', systemOptions);
    try {
      await system.whenReady();
      expect(system.extension(CoordinatedStartupId).hasTasks).toBe(false);
      await aMacrotaskLater();
      expect(pool.log).toEqual([]);

      await system.extension(PersistenceExtensionId).journal.highestSeq('nothing-yet');
      expect(createdTables(pool)).toContain('events');
    } finally {
      await system.terminate();
    }
  });

  test('keeps a selection registered after create working, as before', async () => {
    const lateJournalId = 'test.journal.registered-late';
    const journal = new StartCountingJournal();
    const behavior = PersistenceBehaviorOptions.create().withAutoStart(false);
    const systemOptions = quietOptions(selecting({ journal: lateJournalId })).withPersistence({ behavior });
    const system = ActorSystem.create('warm-up-off-late', systemOptions);
    const persistence = system.extension(PersistenceExtensionId);
    persistence.registerJournal(lateJournalId, () => journal);
    try {
      await system.whenReady();
      expect(persistence.journal).toBe(journal);
      expect(journal.starts).toBe(0);
    } finally {
      await system.terminate();
    }
  });
});
