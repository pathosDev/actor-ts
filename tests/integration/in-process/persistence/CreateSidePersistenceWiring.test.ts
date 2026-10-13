import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions, ActorSystemOptionsBuilder } from '../../../../src/ActorSystemOptions.js';
import { bootstrapCluster } from '../../../../src/cluster/ClusterBootstrap.js';
import { ClusterBootstrapOptions } from '../../../../src/cluster/ClusterBootstrapOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import type { ConfigObject } from '../../../../src/config/HoconParser.js';
import { CoordinatedShutdownId, Phases, type Reason } from '../../../../src/CoordinatedShutdown.js';
import { CoordinatedStartupId, StartupFailedReason, StartupPhases } from '../../../../src/CoordinatedStartup.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  InMemoryDurableStateStore,
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
  registerSqlitePlugins,
  SQLITE_DURABLE_STATE_PLUGIN_ID,
  SQLITE_JOURNAL_PLUGIN_ID,
  SQLITE_SNAPSHOT_PLUGIN_ID,
  SqliteDurableStateStore,
  SqliteJournal,
  SqliteSnapshotStore,
  type DurableStateStore,
  type Journal,
  type PersistenceExtension,
  type PersistencePlugin,
  type SnapshotStore,
} from '../../../../src/persistence/index.js';

/**
 * Persistence wired where the system is created (#1473): what
 * `ActorSystemOptions.withPersistence` takes, and what the extension answers
 * with on the line after `create`.
 *
 * The plug-in cases select test-only ids in HOCON that nothing registers but
 * the plug-ins under test, so a store that resolves can only have come from
 * the plug-in — and one that did not run fails with `Unknown … plugin`.  Every
 * wait is on a promise the code under test settles; none is on the clock.
 */

const JOURNAL_ID = 'test.journal.create-side';
const SNAPSHOT_STORE_ID = 'test.snapshot-store.create-side';
const DURABLE_STATE_ID = 'test.durable-state.create-side';

/** The task name the extension registers a plug-in's promise under. */
const PLUGINS_TASK = 'persistence-plugins';

type Stores = {
  readonly journal: Journal;
  readonly snapshotStore: SnapshotStore;
  readonly durableStateStore: DurableStateStore;
};

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

function quietOptions(): ActorSystemOptionsBuilder {
  return ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
}

const SELECTING_ALL_THREE: ConfigObject = {
  'actor-ts': {
    persistence: {
      journal: { plugin: JOURNAL_ID },
      'snapshot-store': { plugin: SNAPSHOT_STORE_ID },
      'durable-state': { plugin: DURABLE_STATE_ID },
    },
  },
};

function selectingAllThree(): ActorSystemOptionsBuilder {
  return quietOptions().withConfig(SELECTING_ALL_THREE);
}

function freshStores(): Stores {
  return {
    journal: new InMemoryJournal(),
    snapshotStore: new InMemorySnapshotStore(),
    durableStateStore: new InMemoryDurableStateStore(),
  };
}

/** Register one factory per selected axis, each answering with the store given. */
function registerAll(persistence: PersistenceExtension, stores: Stores): void {
  persistence.registerJournal(JOURNAL_ID, () => stores.journal);
  persistence.registerSnapshotStore(SNAPSHOT_STORE_ID, () => stores.snapshotStore);
  persistence.registerDurableStateStore(DURABLE_STATE_ID, () => stores.durableStateStore);
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
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

/**
 * Stop `system` and wait until it is down.  After a failed startup it is
 * already going down — `terminate()` then returns at once and the wait is for
 * the pipeline the failure started; after one that should have failed and did
 * not, this is what stops it, so a regression fails the test instead of
 * leaving a system running.
 */
async function stopped(system: ActorSystem): Promise<void> {
  await system.terminate();
  await system.whenTerminated();
}

/** What `create` threw, or `undefined` — and then the system it built is terminated. */
async function thrownByCreate(name: string, systemOptions: ActorSystemOptionsBuilder): Promise<unknown> {
  let system: ActorSystem | undefined;
  try {
    system = ActorSystem.create(name, systemOptions);
  } catch (error) {
    return error;
  }
  await system.terminate();
  return undefined;
}

describe('the instance slots of withPersistence', () => {
  test('a durable-state store passed in is the one the extension answers with', async () => {
    const durableStateStore = new InMemoryDurableStateStore();
    const systemOptions = quietOptions().withPersistence({ durableStateStore });
    const system = ActorSystem.create('create-side-durable-state', systemOptions);
    try {
      expect(system.extension(PersistenceExtensionId).durableStateStore).toBe(durableStateStore);
    } finally {
      await system.terminate();
    }
  });

  test('the three slots are independent: one set leaves the other two at the in-memory default', async () => {
    const durableStateStore = new InMemoryDurableStateStore();
    const systemOptions = quietOptions().withPersistence({ durableStateStore });
    const system = ActorSystem.create('create-side-independent-slots', systemOptions);
    try {
      const persistence = system.extension(PersistenceExtensionId);
      expect(persistence.durableStateStore).toBe(durableStateStore);
      expect(persistence.journal).toBeInstanceOf(InMemoryJournal);
      expect(persistence.snapshotStore).toBeInstanceOf(InMemorySnapshotStore);
    } finally {
      await system.terminate();
    }
  });

  test('all three set at once each land on their own axis', async () => {
    const journal = new InMemoryJournal();
    const snapshotStore = new InMemorySnapshotStore();
    const durableStateStore = new InMemoryDurableStateStore();
    const systemOptions = quietOptions().withPersistence({ journal, snapshotStore, durableStateStore });
    const system = ActorSystem.create('create-side-all-slots', systemOptions);
    try {
      const persistence = system.extension(PersistenceExtensionId);
      expect(persistence.journal).toBe(journal);
      expect(persistence.snapshotStore).toBe(snapshotStore);
      expect(persistence.durableStateStore).toBe(durableStateStore);
    } finally {
      await system.terminate();
    }
  });
});

describe('plug-ins passed through withPersistence', () => {
  test('are registered before create returns: every selected store resolves on the next line', async () => {
    const stores = freshStores();
    const plugin: PersistencePlugin = (persistence) => registerAll(persistence, stores);
    const systemOptions = selectingAllThree().withPersistence({ plugins: [plugin] });
    const system = ActorSystem.create('create-side-registered', systemOptions);
    try {
      const persistence = system.extension(PersistenceExtensionId);
      expect(persistence.journal).toBe(stores.journal);
      expect(persistence.snapshotStore).toBe(stores.snapshotStore);
      expect(persistence.durableStateStore).toBe(stores.durableStateStore);
    } finally {
      await system.terminate();
    }
  });

  test('a shipped register*Plugins helper is a plug-in as it stands', async () => {
    // The durable-state store is the one SQLite store that insists on a path.
    const sqliteSelected: ConfigObject = {
      'actor-ts': {
        persistence: {
          journal: { plugin: SQLITE_JOURNAL_PLUGIN_ID },
          'snapshot-store': { plugin: SQLITE_SNAPSHOT_PLUGIN_ID },
          'durable-state': { plugin: SQLITE_DURABLE_STATE_PLUGIN_ID, sqlite: { path: ':memory:' } },
        },
      },
    };
    const systemOptions = quietOptions()
      .withConfig(sqliteSelected)
      .withPersistence({ plugins: [(persistence) => registerSqlitePlugins(persistence)] });
    const system = ActorSystem.create('create-side-sqlite', systemOptions);
    try {
      // Resolving opens nothing: each store opens its database on first use.
      const persistence = system.extension(PersistenceExtensionId);
      expect(persistence.journal).toBeInstanceOf(SqliteJournal);
      expect(persistence.snapshotStore).toBeInstanceOf(SqliteSnapshotStore);
      expect(persistence.durableStateStore).toBeInstanceOf(SqliteDurableStateStore);
    } finally {
      await system.terminate();
    }
  });

  test('a plug-in is handed the extension the system answers with', async () => {
    let handed: PersistenceExtension | undefined;
    const systemOptions = quietOptions().withPersistence({ plugins: [(persistence) => { handed = persistence; }] });
    const system = ActorSystem.create('create-side-handed', systemOptions);
    try {
      expect(handed).toBe(system.extension(PersistenceExtensionId));
    } finally {
      await system.terminate();
    }
  });

  test('run in the order given, so a later plug-in registering the same id is the one that counts', async () => {
    const calls: string[] = [];
    const first = new InMemoryJournal();
    const second = new InMemoryJournal();
    const systemOptions = selectingAllThree().withPersistence({
      plugins: [
        (persistence) => { calls.push('first'); persistence.registerJournal(JOURNAL_ID, () => first); },
        (persistence) => { calls.push('second'); persistence.registerJournal(JOURNAL_ID, () => second); },
        () => { calls.push('third'); },
      ],
    });
    const system = ActorSystem.create('create-side-order', systemOptions);
    try {
      expect(calls).toEqual(['first', 'second', 'third']);
      expect(system.extension(PersistenceExtensionId).journal).toBe(second);
    } finally {
      await system.terminate();
    }
  });

  test('plug-ins that return no promise add no startup task: the system is ready at once', async () => {
    const plugin: PersistencePlugin = (persistence) => registerAll(persistence, freshStores());
    const systemOptions = selectingAllThree().withPersistence({ plugins: [plugin] });
    const system = ActorSystem.create('create-side-no-task', systemOptions);
    try {
      expect(system.extension(CoordinatedStartupId).hasTasks).toBe(false);
      expect(await settledState(system.whenReady())).toBe('resolved');
    } finally {
      await system.terminate();
    }
  });

  test('a promise a plug-in returns holds whenReady until it settles', async () => {
    const registration = deferred();
    const systemOptions = quietOptions().withPersistence({ plugins: [() => registration.promise] });
    const system = ActorSystem.create('create-side-pending', systemOptions);
    try {
      expect(system.extension(CoordinatedStartupId).hasTasks).toBe(true);
      expect(await settledState(system.whenReady())).toBe('pending');
      registration.resolve();
      await system.whenReady();
    } finally {
      await system.terminate();
    }
  });
});

describe('an instance in withPersistence wins over a plug-in factory', () => {
  test('on every axis, over a plug-in that registers inside create', async () => {
    const instances = freshStores();
    const plugin: PersistencePlugin = (persistence) => registerAll(persistence, freshStores());
    const systemOptions = selectingAllThree().withPersistence({ plugins: [plugin], ...instances });
    const system = ActorSystem.create('create-side-instances-win', systemOptions);
    try {
      const persistence = system.extension(PersistenceExtensionId);
      expect(persistence.journal).toBe(instances.journal);
      expect(persistence.snapshotStore).toBe(instances.snapshotStore);
      expect(persistence.durableStateStore).toBe(instances.durableStateStore);
    } finally {
      await system.terminate();
    }
  });

  test('and over one that registers after an await', async () => {
    const instances = freshStores();
    let registeredLate = false;
    const plugin: PersistencePlugin = async (persistence) => {
      await Promise.resolve();
      registerAll(persistence, freshStores());
      registeredLate = true;
    };
    const systemOptions = selectingAllThree().withPersistence({ plugins: [plugin], ...instances });
    const system = ActorSystem.create('create-side-instances-win-late', systemOptions);
    try {
      await system.whenReady();
      // Not vacuous: the late registration did happen, under a selected id.
      expect(registeredLate).toBe(true);
      const persistence = system.extension(PersistenceExtensionId);
      expect(persistence.journal).toBe(instances.journal);
      expect(persistence.snapshotStore).toBe(instances.snapshotStore);
      expect(persistence.durableStateStore).toBe(instances.durableStateStore);
    } finally {
      await system.terminate();
    }
  });
});

describe('a plug-in that fails', () => {
  test('one that throws makes create throw that error, and the plug-ins after it do not run', async () => {
    const cause = new Error('the connection string names no host');
    let laterRan = false;
    const systemOptions = quietOptions().withPersistence({
      plugins: [() => { throw cause; }, () => { laterRan = true; }],
    });

    expect(await thrownByCreate('create-side-throws', systemOptions)).toBe(cause);
    expect(laterRan).toBe(false);
  });

  test('a promise an earlier plug-in returned is not reported unhandled when a later one throws', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const cause = new Error('the second plug-in is misconfigured');
      const systemOptions = quietOptions().withPersistence({
        plugins: [() => Promise.reject(new Error('the first plug-in failed its probe')), () => { throw cause; }],
      });
      expect(await thrownByCreate('create-side-throws-after-promise', systemOptions)).toBe(cause);
      // One macrotask turn, because the rejection tracker reports once the
      // microtask queue has drained — not a wait for anything to happen.
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  test('one whose promise rejects fails the startup: whenReady rejects and the system goes down', async () => {
    const cause = new Error('zstd is not installed');
    const systemOptions = quietOptions().withPersistence({ plugins: [async () => { throw cause; }] });
    const system = ActorSystem.create('create-side-rejects', systemOptions);
    try {
      // Registered before the first phase has had a chance to run: `create`
      // returns before any task does.
      const shutdownReasons: Reason[] = [];
      system.extension(CoordinatedShutdownId).addTask(Phases.BeforeServiceUnbind, 'observe', (reason) => {
        shutdownReasons.push(reason);
      });

      const error = await rejectionOf(system.whenReady());
      expect(error.cause).toBe(cause);
      expect(error.message).toContain(`"${PLUGINS_TASK}"`);
      expect(error.message).toContain(`"${StartupPhases.PersistenceStart}"`);

      await system.whenTerminated();
      expect(system.isTerminated).toBe(true);
      expect(shutdownReasons).toHaveLength(1);
      const reason = shutdownReasons[0] as StartupFailedReason;
      expect(reason).toBeInstanceOf(StartupFailedReason);
      expect(reason.phase).toBe(StartupPhases.PersistenceStart);
      expect(reason.task).toBe(PLUGINS_TASK);
      expect(reason.cause).toBe(cause);
    } finally {
      await stopped(system);
    }
  });

  test('a thenable that is not a Promise counts as one', async () => {
    const cause = new Error('rejected through a bare then');
    const thenable = {
      then(_onFulfilled: (value: unknown) => void, onRejected: (reason: unknown) => void): void {
        onRejected(cause);
      },
    };
    const systemOptions = quietOptions().withPersistence({ plugins: [() => thenable] });
    const system = ActorSystem.create('create-side-thenable', systemOptions);
    try {
      const error = await rejectionOf(system.whenReady());
      expect(error.cause).toBe(cause);
    } finally {
      await stopped(system);
    }
  });

  test('what a plug-in registered before its promise rejected is in place when create returns', async () => {
    // The shape of a helper that registers and then probes: the factories are
    // there at once, and the probe's verdict arrives through the startup.
    const stores = freshStores();
    const cause = new Error('the probe failed');
    const plugin: PersistencePlugin = (persistence) => {
      registerAll(persistence, stores);
      return Promise.reject(cause);
    };
    const systemOptions = selectingAllThree().withPersistence({ plugins: [plugin] });
    const system = ActorSystem.create('create-side-registered-then-rejected', systemOptions);
    try {
      expect(system.extension(PersistenceExtensionId).journal).toBe(stores.journal);
      expect((await rejectionOf(system.whenReady())).cause).toBe(cause);
    } finally {
      await stopped(system);
    }
  });
});

describe('a selected plug-in nothing registered', () => {
  test('is refused on every axis with an error that names the plugins slot as the route', async () => {
    const system = ActorSystem.create('create-side-unregistered', selectingAllThree());
    try {
      const persistence = system.extension(PersistenceExtensionId);
      const axes: ReadonlyArray<readonly [string, () => unknown]> = [
        ['journal', () => persistence.journal],
        ['snapshot-store', () => persistence.snapshotStore],
        ['durable-state', () => persistence.durableStateStore],
      ];
      for (const [axis, resolve] of axes) {
        expect(resolve).toThrow(`Unknown ${axis} plugin`);
        expect(resolve).toThrow('ActorSystemOptions.withPersistence({ plugins })');
        expect(resolve).toThrow(`actor-ts.persistence.${axis}.plugin`);
      }
    } finally {
      await system.terminate();
    }
  });
});

describe('ClusterBootstrapOptions.withPersistence', () => {
  test('forwards the plug-ins to the system it creates', async () => {
    const stores = freshStores();
    const name = 'create-side-bootstrap';
    const transport = new InMemoryTransport(new NodeAddress(name, '127.0.0.1', 2552));
    const plugin: PersistencePlugin = (persistence) => registerAll(persistence, stores);
    // No port is bound: the in-memory transport carries the join.
    const bootstrapOptions = ClusterBootstrapOptions.create(name)
      .withHost('127.0.0.1')
      .withPort(2552)
      .withSeeds([])
      .withTransport(transport)
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withLogger(new NoopLogger())
      .withConfig(SELECTING_ALL_THREE)
      .withPersistence({ plugins: [plugin] });
    const { system, shutdown } = await bootstrapCluster(bootstrapOptions);
    try {
      expect(system.extension(PersistenceExtensionId).journal).toBe(stores.journal);
    } finally {
      await shutdown();
    }
  });
});
