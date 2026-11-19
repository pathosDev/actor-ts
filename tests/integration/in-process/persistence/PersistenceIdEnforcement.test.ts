import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCache } from '../../../../src/cache/InMemoryCache.js';
import type { SnapshotStore } from '../../../../src/persistence/SnapshotStore.js';
import type { DurableStateStore } from '../../../../src/persistence/DurableStateStore.js';
import { ReplicatedEventSourcedActor } from '../../../../src/persistence/ReplicatedEventSourcedActor.js';
import { CachedSnapshotStore } from '../../../../src/persistence/snapshot-stores/CachedSnapshotStore.js';
import { CachedSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/CachedSnapshotStoreOptions.js';
import { CassandraSnapshotStore } from '../../../../src/persistence/snapshot-stores/CassandraSnapshotStore.js';
import { CassandraSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/CassandraSnapshotStoreOptions.js';
import { D1SnapshotStore } from '../../../../src/persistence/snapshot-stores/D1SnapshotStore.js';
import { D1SnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/D1SnapshotStoreOptions.js';
import { DynamoDbSnapshotStore } from '../../../../src/persistence/snapshot-stores/DynamoDbSnapshotStore.js';
import { DynamoDbSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/DynamoDbSnapshotStoreOptions.js';
import { MongoSnapshotStore } from '../../../../src/persistence/snapshot-stores/MongoSnapshotStore.js';
import { MongoSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/MongoSnapshotStoreOptions.js';
import { ObjectStorageSnapshotStore } from '../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStore.js';
import {
  ObjectStorageSnapshotStoreOptions,
} from '../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
import { SqliteSnapshotStore } from '../../../../src/persistence/snapshot-stores/SqliteSnapshotStore.js';
import { SqliteSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/SqliteSnapshotStoreOptions.js';
import { D1DurableStateStore } from '../../../../src/persistence/durable-state-stores/D1DurableStateStore.js';
import {
  D1DurableStateStoreOptions,
} from '../../../../src/persistence/durable-state-stores/D1DurableStateStoreOptions.js';
import { DynamoDbDurableStateStore } from '../../../../src/persistence/durable-state-stores/DynamoDbDurableStateStore.js';
import {
  DynamoDbDurableStateStoreOptions,
} from '../../../../src/persistence/durable-state-stores/DynamoDbDurableStateStoreOptions.js';
import { MongoDurableStateStore } from '../../../../src/persistence/durable-state-stores/MongoDurableStateStore.js';
import {
  MongoDurableStateStoreOptions,
} from '../../../../src/persistence/durable-state-stores/MongoDurableStateStoreOptions.js';
import {
  ObjectStorageDurableStateStore,
} from '../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStore.js';
import {
  ObjectStorageDurableStateStoreOptions,
} from '../../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStoreOptions.js';
import { FilesystemObjectStorageBackend } from '../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { FakeCassandraClient } from './FakeCassandraClient.js';
import { FakeD1Client } from './FakeD1Client.js';
import { FakeDynamoDb } from './FakeDynamoDb.js';
import { FakeMongoClient } from './FakeMongoClient.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Actor } from '../../../../src/Actor.js';
import {
  DurableStateActor,
  DurableStateOptions,
  InMemoryDurableStateStore,
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
  PersistentActor,
} from '../../../../src/persistence/index.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import { ActorLifecycleEvent, ActorStopped } from '../../../../src/SystemMessages.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/* --------------------------- shared fixtures ----------------------------- */

type DepositCommand = { kind: 'deposit'; amount: number };
type Command = DepositCommand;

type DepositedEvent = { kind: 'deposited'; amount: number };
type Event = DepositedEvent;

type State = { balance: number };

/**
 * What the actor did, recorded outside it — an actor whose `preStart`
 * throws is unreachable, so every assertion reads from this bag.
 */
type Observations = {
  incarnations: number;
  recovered: State[];
  recoveryFailures: Error[];
};

const newObservations = (): Observations =>
  ({ incarnations: 0, recovered: [], recoveryFailures: [] });

class Account extends PersistentActor<Command, Event, State> {
  readonly persistenceId: string;
  constructor(persistenceId: string, private readonly observations: Observations) {
    super();
    this.persistenceId = persistenceId;
  }
  initialState(): State { return { balance: 0 }; }
  onEvent(state: State, event: Event): State {
    return { balance: state.balance + event.amount };
  }
  override onRecoveryComplete(state: State): void { this.observations.recovered.push(state); }
  /**
   * Records instead of rethrowing — the point of the test below is that a
   * rejected id never reaches this hook, and a hook that rethrew would
   * make "never reached" and "reached and rethrew" indistinguishable.
   */
  override onRecoveryFailure(reason: Error): void { this.observations.recoveryFailures.push(reason); }
  async onCommand(_state: State, command: Command): Promise<void> {
    await this.persist({ kind: 'deposited', amount: command.amount });
  }
}

type SetCommand = { kind: 'set'; value: string };

class Setting extends DurableStateActor<SetCommand, { value: string }> {
  override async onCommand(command: SetCommand): Promise<void> {
    await this.persist({ value: command.value });
  }
}

const settingOptions = (persistenceId: string): DurableStateOptions<{ value: string }> =>
  DurableStateOptions.create<{ value: string }>()
    .withPersistenceId(persistenceId)
    .withStore(new InMemoryDurableStateStore())
    .withEmptyState(() => ({ value: '' }));

class LifecycleListener extends Actor<ActorLifecycleEvent> {
  constructor(private readonly seen: ActorLifecycleEvent[], private readonly ready: { value: boolean }) {
    super();
  }
  override preStart(): void {
    this.system.eventStream.subscribe(this.self, ActorLifecycleEvent);
    this.ready.value = true;
  }
  override onReceive(event: ActorLifecycleEvent): void { this.seen.push(event); }
}

function makeSystem(name: string): { system: ActorSystem; journal: InMemoryJournal } {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  const journal = new InMemoryJournal();
  const extension = system.extension(PersistenceExtensionId);
  extension.setJournal(journal);
  extension.setSnapshotStore(new InMemorySnapshotStore());
  return { system, journal };
}

/* ------------------------------- journals -------------------------------- */

describe('journal append — the last line of defence', () => {
  test('refuses an id with a path separator and writes nothing', async () => {
    const journal = new InMemoryJournal();
    await expect(journal.append('tenant/../root', [{ event: { kind: 'deposited', amount: 1 } }], 0))
      .rejects.toThrow(/path separator/);
    expect(await journal.highestSeq('tenant/../root')).toBe(0);
    expect(await journal.read('tenant/../root', 1)).toEqual([]);
  });

  test('refuses an empty id, which every stream would otherwise share', async () => {
    const journal = new InMemoryJournal();
    await expect(journal.append('', [{ event: { kind: 'deposited', amount: 1 } }], 0))
      .rejects.toThrow(/non-empty string/);
  });

  test('leaves the READ path open, so pre-existing data stays reachable', async () => {
    // The escape hatch that makes the tightening adoptable: events written
    // before these rules existed must stay copyable to a corrected id, so
    // `read` and `highestSeq` answer for an id `append` now refuses rather
    // than throwing at it.
    const journal = new InMemoryJournal();
    await expect(journal.read('tenant/legacy', 1)).resolves.toEqual([]);
    await expect(journal.highestSeq('tenant/legacy')).resolves.toBe(0);
  });

  test('accepts the pipe-separated id the chat example ships', async () => {
    const journal = new InMemoryJournal();
    const written = await journal.append(
      'dm-channel-alice|bob', [{ event: { kind: 'deposited', amount: 1 } }], 0,
    );
    expect(written.map((e) => e.sequenceNr)).toEqual([1]);
  });
});

/* ---------------------------- PersistentActor ---------------------------- */

describe('PersistentActor — an id that cannot be a storage key', () => {
  test('fails at preStart without ever reaching onRecoveryFailure', async () => {
    const { system } = makeSystem('persistence-id-rejected');
    const lifecycle: ActorLifecycleEvent[] = [];
    const ready = { value: false };
    system.spawn(() => new LifecycleListener(lifecycle, ready), 'lifecycle');
    await awaitCondition(() => ready.value, { label: 'the lifecycle listener subscribed' });

    const observations = newObservations();
    const ref = system.spawn(
      () => {
        observations.incarnations++;
        return new Account('snapshots/../../etc', observations);
      },
      'account',
    );

    // The assert sits outside the recovery guard, so supervision — not the
    // hook — owns the failure, and the restart budget eventually stops it.
    await awaitCondition(() => observations.incarnations > 1, {
      label: 'supervision restarted the actor with the rejected id',
    });
    await awaitCondition(
      () => lifecycle.some((e) => e instanceof ActorStopped && e.actor.equals(ref)),
      { label: 'the restart budget ran out and the actor stopped', timeoutMs: 5_000 },
    );
    // An id this class refuses is a bug in the class, not a journal
    // failure — routing it through the recovery hook would let an override
    // that swallows journal errors swallow this too.
    expect(observations.recoveryFailures).toEqual([]);
    expect(observations.recovered).toEqual([]);
    await system.terminate();
    // The 5 s restart-budget wait exactly equals bun's default cap, so the two
    // deadlines raced and the runner usually won — reporting a bare timeout for
    // the one wait whose label ("the restart budget ran out") is the diagnosis.
  }, 15_000);

  test('recovers normally with the pipe-separated id the chat example ships', async () => {
    const { system, journal } = makeSystem('persistence-id-pipe');
    await journal.append<Event>('dm-channel-alice|bob', [{ event: { kind: 'deposited', amount: 3 } }], 0);

    const observations = newObservations();
    system.spawn(() => new Account('dm-channel-alice|bob', observations), 'channel');
    await awaitCondition(() => observations.recovered.length === 1, {
      label: 'the DM channel recovered its journal',
    });
    expect(observations.recovered[0]).toEqual({ balance: 3 });
    await system.terminate();
  });
});

/* --------------------------- DurableStateActor --------------------------- */

describe('DurableStateActor — the id arrives as an option', () => {
  test('rejects it as an OptionsError, at construction', () => {
    // Reported against the field, like every other XOptionsValidator —
    // and before the actor is wired to a store, which is earlier than a
    // preStart check could manage.
    let caught: unknown = null;
    try { new Setting(settingOptions('cart/../admin')); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(OptionsError);
    expect((caught as OptionsError).field).toBe('persistenceId');
    expect((caught as Error).message).toMatch(/path separator/);
  });

  test('rejects an empty id the builder happily accepted', () => {
    expect(() => new Setting(settingOptions(''))).toThrow(OptionsError);
  });

  test('accepts an ordinary id', () => {
    expect(() => new Setting(settingOptions('cart-user-42'))).not.toThrow();
  });
});

/* --------------------- snapshot and durable-state stores ------------------ */

/**
 * Every store the framework ships, held directly — the shape #1632 and #1070
 * are about: a migration script, a store wrapper or a tool that writes without
 * an actor in front of it.  The actors validate at construction or `preStart`;
 * this is the second line the journals' `append` already has.
 *
 * The expected origin is the class that owns the method, so a wrapper that
 * forwarded the call and let its inner store refuse it would still fail here:
 * `CachedSnapshotStore` must refuse before it touches its cache.  The relational
 * stores are reached through D1 because its fake runs in-process; every
 * relational dialect shares the one `save` and `upsert`.
 */
type SnapshotStoreCase = {
  readonly origin: string;
  readonly open: () => SnapshotStore;
};

type DurableStateStoreCase = {
  readonly origin: string;
  readonly open: () => DurableStateStore;
};

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (directory !== '') rmSync(directory, { recursive: true, force: true });
  }
});

function filesystemBackend(): FilesystemObjectStorageBackend {
  const directory = mkdtempSync(join(tmpdir(), 'actor-ts-pid-'));
  temporaryDirectories.push(directory);
  return new FilesystemObjectStorageBackend(FilesystemObjectStorageOptions.create().withDir(directory));
}

const snapshotStores: readonly SnapshotStoreCase[] = [
  { origin: 'InMemorySnapshotStore.save', open: () => new InMemorySnapshotStore() },
  {
    origin: 'CachedSnapshotStore.save',
    open: () => {
      const cachedOptions = CachedSnapshotStoreOptions.create().withCache(new InMemoryCache());
      return new CachedSnapshotStore(new InMemorySnapshotStore(), cachedOptions);
    },
  },
  {
    origin: 'CassandraSnapshotStore.save',
    open: () => {
      const cassandraOptions = CassandraSnapshotStoreOptions.create()
        .withContactPoints(['fake'])
        .withKeyspace('ks')
        .withClient(new FakeCassandraClient())
        .withAutoCreateKeyspace(true);
      return new CassandraSnapshotStore(cassandraOptions);
    },
  },
  {
    origin: 'DynamoDbSnapshotStore.save',
    open: () => {
      const dynamoOptions = DynamoDbSnapshotStoreOptions.create().withOperations(new FakeDynamoDb());
      return new DynamoDbSnapshotStore(dynamoOptions);
    },
  },
  {
    origin: 'MongoSnapshotStore.save',
    open: () => {
      const mongoOptions = MongoSnapshotStoreOptions.create().withClient(new FakeMongoClient());
      return new MongoSnapshotStore(mongoOptions);
    },
  },
  {
    origin: 'ObjectStorageSnapshotStore.save',
    open: () => {
      const objectStorageOptions = ObjectStorageSnapshotStoreOptions.create().withBackend(filesystemBackend());
      return new ObjectStorageSnapshotStore(objectStorageOptions);
    },
  },
  {
    origin: 'SqliteSnapshotStore.save',
    open: () => {
      const sqliteOptions = SqliteSnapshotStoreOptions.create().withPath(':memory:');
      return new SqliteSnapshotStore(sqliteOptions);
    },
  },
  {
    origin: 'RelationalSnapshotStore.save',
    open: () => {
      const d1Options = D1SnapshotStoreOptions.create().withClient(new FakeD1Client());
      return new D1SnapshotStore(d1Options);
    },
  },
];

const durableStateStores: readonly DurableStateStoreCase[] = [
  { origin: 'InMemoryDurableStateStore.upsert', open: () => new InMemoryDurableStateStore() },
  {
    origin: 'DynamoDbDurableStateStore.upsert',
    open: () => {
      const dynamoOptions = DynamoDbDurableStateStoreOptions.create().withOperations(new FakeDynamoDb());
      return new DynamoDbDurableStateStore(dynamoOptions);
    },
  },
  {
    origin: 'MongoDurableStateStore.upsert',
    open: () => {
      const mongoOptions = MongoDurableStateStoreOptions.create().withClient(new FakeMongoClient());
      return new MongoDurableStateStore(mongoOptions);
    },
  },
  {
    origin: 'ObjectStorageDurableStateStore.upsert',
    open: () => {
      const objectStorageOptions = ObjectStorageDurableStateStoreOptions.create().withBackend(filesystemBackend());
      return new ObjectStorageDurableStateStore(objectStorageOptions);
    },
  },
  {
    origin: 'RelationalDurableStateStore.upsert',
    open: () => {
      const d1Options = D1DurableStateStoreOptions.create().withClient(new FakeD1Client());
      return new D1DurableStateStore(d1Options);
    },
  },
];

/** Ids every journal's `append` refuses, one per rule worth naming. */
const refusedIds: readonly string[] = ['tenant/../root', 'tenant\\root', '', '..', 'line\nbreak'];

function escapeRegularExpression(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, (match) => `\\${match}`);
}

/** The validator's message for `persistenceId` raised at `origin`. */
const refusalFor = (persistenceId: string, origin: string): RegExp => new RegExp(
  `Invalid persistenceId ${escapeRegularExpression(JSON.stringify(persistenceId))} `
  + `\\(${escapeRegularExpression(origin)}\\)`,
);

describe('snapshot store save — the rules journal append enforces (#1632, #1070)', () => {
  for (const { origin, open } of snapshotStores) {
    test(`${origin} refuses every id a journal refuses`, async () => {
      const store = open();
      try {
        for (const persistenceId of refusedIds) {
          await expect(store.save(persistenceId, 1, { balance: 1 })).rejects.toThrow(refusalFor(persistenceId, origin));
        }
      } finally {
        await store.close?.();
      }
    });

    test(`${origin} accepts an ordinary id`, async () => {
      const store = open();
      try {
        const saved = await store.save('account-42', 1, { balance: 1 });
        expect(saved.persistenceId).toBe('account-42');
      } finally {
        await store.close?.();
      }
    });
  }
});

describe('durable-state store upsert — the rules journal append enforces (#1632, #1070)', () => {
  for (const { origin, open } of durableStateStores) {
    test(`${origin} refuses every id a journal refuses`, async () => {
      const store = open();
      try {
        for (const persistenceId of refusedIds) {
          await expect(store.upsert(persistenceId, 0, { value: 'x' })).rejects.toThrow(refusalFor(persistenceId, origin));
        }
      } finally {
        await store.close?.();
      }
    });

    test(`${origin} accepts an ordinary id`, async () => {
      const store = open();
      try {
        expect((await store.upsert('account-42', 0, { value: 'x' })).revision).toBe(1);
      } finally {
        await store.close?.();
      }
    });
  }
});

/* ---------------------- ReplicatedEventSourcedActor ---------------------- */

type AddCommand = { kind: 'add'; amount: number };
type AddedEvent = { kind: 'added'; amount: number };

/** Records what `preStart` threw — the actor itself is unreachable after it. */
class ReplicatedAccount extends ReplicatedEventSourcedActor<AddCommand, AddedEvent, State> {
  readonly persistenceId: string;
  constructor(persistenceId: string, private readonly failures: Error[]) {
    super();
    this.persistenceId = persistenceId;
  }
  override get replicaId(): string { return 'eu-west'; }
  initialState(): State { return { balance: 0 }; }
  onEvent(state: State, event: AddedEvent): State { return { balance: state.balance + event.amount }; }
  async onCommand(_state: State, command: AddCommand): Promise<void> {
    await this.persist({ kind: 'added', amount: command.amount });
  }
  override async preStart(): Promise<void> {
    try {
      await super.preStart();
    } catch (error) {
      this.failures.push(error as Error);
      throw error;
    }
  }
}

describe('ReplicatedEventSourcedActor — an id that cannot be a storage key (#1070)', () => {
  test('fails at preStart with the validator, not with whatever runs after it', async () => {
    const { system } = makeSystem('replicated-persistence-id-rejected');
    const failures: Error[] = [];
    system.spawn(() => new ReplicatedAccount('replicated/../root', failures), 'replicated');
    await awaitCondition(() => failures.length > 0, { label: 'the replicated actor failed its preStart' });
    expect(failures[0]?.message).toMatch(refusalFor('replicated/../root', 'ReplicatedEventSourcedActor'));
    await system.terminate();
  });
});
