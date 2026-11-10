/**
 * #1497 — a replicated actor's recovery is guarded the way a
 * `PersistentActor`'s is: the snapshot load through the snapshot breaker,
 * the journal read through the journal breaker, both under one recovery
 * permit and one recovery deadline, with `snapshot-is-optional` honoured —
 * and a snapshot save through the snapshot breaker.
 *
 * The replicated actor does not have `onRecoveryFailure`; a recovery that
 * fails fails `preStart`, which reaches supervision as an
 * `ActorInitializationError` and, by default, a restart.  So the tests read
 * failures from a `preStart` override (as `SingleWriter.test.ts` does) and
 * never wait for a stop: default supervision restarts a failing `preStart`
 * ten times a minute.
 *
 * The deadline gives up; it cannot cancel the read it gave up on.  What makes
 * that safe is the split the abandoned-recovery test pins: the guarded phase
 * only reads, and nothing is applied to the actor until it has returned — so
 * an answer that arrives after the deadline lands on nothing.
 *
 * Single node over `InMemoryTransport`, like the sibling replicated suites —
 * no OS port is bound.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { match } from 'ts-pattern';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import type { ConfigObject } from '../../../../../src/index.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { CircuitBreakerOpenError } from '../../../../../src/pattern/CircuitBreaker.js';
import type { Journal } from '../../../../../src/persistence/Journal.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { PersistenceExtensionId, type PersistenceExtension } from '../../../../../src/persistence/PersistenceExtension.js';
import { RecoveryTimeoutError, type SnapshotPolicy } from '../../../../../src/persistence/PersistentActor.js';
import {
  ReplicatedEventSourcedActor,
  type ReplicatedEventEnvelope,
} from '../../../../../src/persistence/ReplicatedEventSourcedActor.js';
import { InMemorySnapshotStore } from '../../../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import type { SnapshotStore } from '../../../../../src/persistence/SnapshotStore.js';
import { assertCompletesWithin } from '../../../../util/AsyncAssertions.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';
import { RecordingLogger } from '../../../../util/RecordingLogger.js';
import {
  CountingSnapshotStore,
  FirstReadHeldJournal,
  GatedJournal,
  StallingJournal,
  UnreachableSnapshotStore,
} from '../../../../util/UnavailableJournal.js';

type AddCommand = { readonly kind: 'add'; readonly amount: number };
type FailCommand = { readonly kind: 'fail' };
type Command = AddCommand | FailCommand;

type AddedEvent = { readonly kind: 'added'; readonly amount: number };
type Event = AddedEvent;

type State = { readonly value: number };

const WAIT = { timeoutMs: 3_000, intervalMs: 5 } as const;

/** Bounds a teardown step, so a wedged actor fails the test rather than the runner. */
const TEARDOWN_BUDGET_MS = 2_000;

/** A recovery deadline short enough to pass inside one test. */
const RECOVERY_TIMEOUT: ConfigObject = { 'actor-ts': { persistence: { 'recovery-timeout': '60ms' } } };

/** Everything a test reads, kept outside the actor so it outlives every instance. */
type Observations = {
  readonly persisted: number[];
  readonly preStartFailures: Error[];
  readonly recovered: Array<{ readonly instance: number; readonly state: State }>;
  /** Instances constructed so far — the first is 1, a restart's is the next. */
  instances: number;
};

const newObservations = (): Observations => ({ persisted: [], preStartFailures: [], recovered: [], instances: 0 });

const NEVER: SnapshotPolicy<State, Event> = () => false;

class Counter extends ReplicatedEventSourcedActor<Command, Event, State> {
  readonly persistenceId: string;
  private readonly instance: number;

  constructor(
    persistenceId: string,
    private readonly observations: Observations,
    private readonly policy: SnapshotPolicy<State, Event> = NEVER,
  ) {
    super();
    this.persistenceId = persistenceId;
    observations.instances += 1;
    this.instance = observations.instances;
  }

  initialState(): State { return { value: 0 }; }

  onEvent(state: State, event: Event): State { return { value: state.value + event.amount }; }

  protected override snapshotPolicy(): SnapshotPolicy<State, Event> { return this.policy; }

  override onRecoveryComplete(state: State): void {
    this.observations.recovered.push({ instance: this.instance, state });
  }

  /** Records the failure and rethrows it, so supervision still sees it. */
  override async preStart(): Promise<void> {
    try {
      await super.preStart();
    } catch (e) {
      this.observations.preStartFailures.push(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }

  async onCommand(_state: State, command: Command): Promise<void> {
    await match(command)
      .with({ kind: 'add' }, (c) => this.onAdd(c))
      .with({ kind: 'fail' }, () => this.onFail())
      .exhaustive();
  }

  private async onAdd(command: AddCommand): Promise<void> {
    await this.persist({ kind: 'added', amount: command.amount });
    this.observations.persisted.push(command.amount);
  }

  /** A handler failure, so supervision restarts the actor — a recovery from the same journal. */
  private onFail(): void {
    throw new Error('restart requested by the test');
  }
}

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly extension: PersistenceExtension;
};

async function startNode(
  name: string,
  port: number,
  stores: { readonly journal: Journal; readonly snapshotStore: SnapshotStore },
  config?: ConfigObject,
  logger?: RecordingLogger,
): Promise<Node> {
  let options = logger
    ? ActorSystemOptions.create().withLogger(logger)
    : ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  if (config) options = options.withConfig(config);
  const system = ActorSystem.create(name, options);
  const extension = system.extension(PersistenceExtensionId);
  extension.configure(stores);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster, extension };
}

function spawnCounter(
  node: Node,
  persistenceId: string,
  observations: Observations,
  policy: SnapshotPolicy<State, Event> = NEVER,
): ActorRef<Command | ReplicatedEventEnvelope<Event>> {
  return node.system.spawn(() => new Counter(persistenceId, observations, policy), persistenceId);
}

/** Leave and terminate, each raced against a budget inside the test body. */
async function stopNode(node: Node): Promise<void> {
  await assertCompletesWithin(node.cluster.leave(), TEARDOWN_BUDGET_MS, `${node.system.name}: cluster.leave() settled`);
  await assertCompletesWithin(node.system.terminate(), TEARDOWN_BUDGET_MS, `${node.system.name}: system.terminate() settled`);
}

const PEER = 'recovery-guards-peer@h:83299';

/** Write `amounts` as a peer's events, so a recovery has something to fold. */
async function seedJournal(journal: Journal, persistenceId: string, amounts: ReadonlyArray<number>): Promise<void> {
  for (let index = 0; index < amounts.length; index++) {
    const sequence = index + 1;
    const envelope: ReplicatedEventEnvelope<Event> = {
      persistenceId,
      replica: PEER,
      seqAtReplica: sequence,
      eventId: `${PEER}#${sequence.toString(16).padStart(24, '0')}`,
      vc: { [PEER]: sequence },
      timestamp: 1_700_000_000_000 + sequence,
      event: { kind: 'added', amount: amounts[index]! },
    };
    await journal.append(persistenceId, [{ event: envelope, tags: ['replicated-es'] }], index);
  }
}

const warningsContaining = (logger: RecordingLogger, needle: string): number =>
  logger.records.filter((r) => r.level === 'warn' && r.message.includes(needle)).length;

describe('ReplicatedEventSourcedActor — recovery is bounded (#1497)', () => {
  test('recovery-timeout fails the replicated preStart with a RecoveryTimeoutError naming the persistenceId', async () => {
    const journal = new StallingJournal();
    const node = await startNode('recovery-guards-deadline', 83_201, {
      journal, snapshotStore: new InMemorySnapshotStore(),
    }, RECOVERY_TIMEOUT);
    try {
      const observations = newObservations();
      spawnCounter(node, 'rg-deadline', observations);
      await awaitCondition(() => observations.preStartFailures.length >= 1, {
        ...WAIT, label: 'the stalled recovery hit its deadline',
      });

      const failure = observations.preStartFailures[0];
      expect(failure).toBeInstanceOf(RecoveryTimeoutError);
      expect((failure as RecoveryTimeoutError).persistenceId).toBe('rg-deadline');
      expect((failure as RecoveryTimeoutError).timeoutMs).toBe(60);
      expect(failure!.message).toContain("'rg-deadline'");
      expect(observations.recovered).toEqual([]);
    } finally {
      journal.settleAll();
      await stopNode(node);
    }
  });

  test('max-concurrent-recoveries queues replicated recoveries behind one permit', async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const journal = new GatedJournal(gate);
    const node = await startNode('recovery-guards-permits', 83_202, {
      journal, snapshotStore: new InMemorySnapshotStore(),
    }, { 'actor-ts': { persistence: { 'max-concurrent-recoveries': 1 } } });
    try {
      const observations = newObservations();
      for (const persistenceId of ['rg-permit-a', 'rg-permit-b', 'rg-permit-c']) {
        spawnCounter(node, persistenceId, observations);
      }
      await awaitCondition(() => node.extension.recoveryPermits?.queued === 2, {
        ...WAIT, label: 'two recoveries queued behind the one permit',
      });
      expect(journal.reading).toHaveLength(1);

      openGate();
      await awaitCondition(() => observations.recovered.length === 3, {
        ...WAIT, label: 'all three replicas recovered once the journal answered',
      });
      expect(node.extension.recoveryPermits?.peakInFlight).toBe(1);
      expect(journal.reading).toHaveLength(3);
    } finally {
      openGate();
      await stopNode(node);
    }
  });

  test('a recovery stalled past its deadline gives its permit back, so the replica queued behind it recovers', async () => {
    // The deadline sits inside the permit, as in PersistentActor: when it
    // fires, the permit is returned even though the stalled read never
    // answers.  Were it wrapped around the permit instead, the stalled read
    // would keep the one permit for good and every recovery queued behind it
    // would wait for ever.
    const journal = new FirstReadHeldJournal(new InMemoryJournal());
    const node = await startNode('recovery-guards-permit-release', 83_210, {
      journal, snapshotStore: new InMemorySnapshotStore(),
    }, { 'actor-ts': { persistence: { 'max-concurrent-recoveries': 1, 'recovery-timeout': '60ms' } } });
    try {
      const stalled = newObservations();
      const queued = newObservations();
      spawnCounter(node, 'rg-release-stalled', stalled);
      await awaitCondition(() => journal.readCount === 1, { ...WAIT, label: 'the first recovery holds the permit, its read stalled' });
      spawnCounter(node, 'rg-release-queued', queued);

      await awaitCondition(() => queued.recovered.length === 1, {
        ...WAIT, label: 'the replica queued behind the stalled recovery recovered',
      });
      expect(stalled.preStartFailures[0]).toBeInstanceOf(RecoveryTimeoutError);
      expect(queued.preStartFailures).toEqual([]);
    } finally {
      journal.releaseFirstRead();
      await stopNode(node);
    }
  });
});

describe('ReplicatedEventSourcedActor — snapshot-is-optional (#1497)', () => {
  test('on: an unreachable snapshot store falls back to the journal, with one WARN naming the key', async () => {
    const journal = new InMemoryJournal();
    await seedJournal(journal, 'rg-optional', [3, 4]);
    const logger = new RecordingLogger();
    const node = await startNode('recovery-guards-optional', 83_203, {
      journal, snapshotStore: new UnreachableSnapshotStore(),
    }, { 'actor-ts': { persistence: { 'snapshot-is-optional': true } } }, logger);
    try {
      const observations = newObservations();
      spawnCounter(node, 'rg-optional', observations);
      await awaitCondition(() => observations.recovered.length === 1, {
        ...WAIT, label: 'the replica recovered without its snapshot store',
      });

      expect(observations.recovered[0]!.state).toEqual({ value: 7 });
      expect(observations.preStartFailures).toEqual([]);
      expect(warningsContaining(logger, 'actor-ts.persistence.snapshot-is-optional')).toBe(1);
    } finally {
      await stopNode(node);
    }
  });

  test('off: an unreachable snapshot store fails preStart with the store\'s error', async () => {
    const node = await startNode('recovery-guards-required', 83_204, {
      journal: new InMemoryJournal(), snapshotStore: new UnreachableSnapshotStore(),
    });
    try {
      const observations = newObservations();
      spawnCounter(node, 'rg-required', observations);
      await awaitCondition(() => observations.preStartFailures.length >= 1, {
        ...WAIT, label: 'the recovery failed on the snapshot store',
      });

      expect(observations.preStartFailures[0]!.message).toContain('snapshot store is unreachable');
      expect(observations.recovered).toEqual([]);
    } finally {
      await stopNode(node);
    }
  });
});

describe('ReplicatedEventSourcedActor — each store behind its own breaker (#1497)', () => {
  test('an open snapshot breaker fails the recovery and leaves the journal breaker alone', async () => {
    // max-failures = 1 on the journal breaker: a snapshot failure counted
    // against it even once would open it.
    const node = await startNode('recovery-guards-snapshot-open', 83_205, {
      journal: new InMemoryJournal(), snapshotStore: new InMemorySnapshotStore(),
    }, { 'actor-ts': { 'circuit-breaker': { 'persistence-journal': { 'max-failures': 1 } } } });
    try {
      node.extension.snapshotBreaker!.setState('open');
      const observations = newObservations();
      spawnCounter(node, 'rg-snapshot-open', observations);
      await awaitCondition(() => observations.preStartFailures.length >= 1, {
        ...WAIT, label: 'the recovery was refused by the open snapshot breaker',
      });

      expect(observations.preStartFailures[0]).toBeInstanceOf(CircuitBreakerOpenError);
      expect(node.extension.journalBreaker!.state).toBe('closed');
    } finally {
      await stopNode(node);
    }
  });

  test('an open journal breaker fails the recovery before the journal is read', async () => {
    const journal = new GatedJournal(Promise.resolve());
    const node = await startNode('recovery-guards-journal-open', 83_206, {
      journal, snapshotStore: new InMemorySnapshotStore(),
    });
    try {
      node.extension.journalBreaker!.setState('open');
      const observations = newObservations();
      spawnCounter(node, 'rg-journal-open', observations);
      await awaitCondition(() => observations.preStartFailures.length >= 1, {
        ...WAIT, label: 'the recovery was refused by the open journal breaker',
      });

      expect(observations.preStartFailures[0]).toBeInstanceOf(CircuitBreakerOpenError);
      expect(journal.reading).toEqual([]);
    } finally {
      await stopNode(node);
    }
  });

  test('a policy-triggered snapshot save behind an open snapshot breaker never reaches the store and is a WARN', async () => {
    const snapshots = new CountingSnapshotStore();
    const logger = new RecordingLogger();
    const node = await startNode('recovery-guards-save', 83_207, {
      journal: new InMemoryJournal(), snapshotStore: snapshots,
    }, undefined, logger);
    try {
      const observations = newObservations();
      const ref = spawnCounter(node, 'rg-save', observations, () => true);
      await awaitCondition(() => observations.recovered.length === 1, { ...WAIT, label: 'the replica recovered' });

      node.extension.snapshotBreaker!.setState('open');
      ref.tell({ kind: 'add', amount: 1 });
      await awaitCondition(() => warningsContaining(logger, 'snapshot save failed') === 1, {
        ...WAIT, label: 'the refused snapshot save was logged',
      });
      expect(observations.persisted).toEqual([1]);
      expect(snapshots.saves).toBe(0);

      // A WARN, not a failure: the same instance goes on serving.
      ref.tell({ kind: 'add', amount: 2 });
      await awaitCondition(() => observations.persisted.includes(2), { ...WAIT, label: 'the next command was served' });
      expect(observations.preStartFailures).toEqual([]);
      expect(observations.instances).toBe(1);
      expect(snapshots.saves).toBe(0);
    } finally {
      await stopNode(node);
    }
  });
});

describe('ReplicatedEventSourcedActor — an abandoned recovery is inert (#1497)', () => {
  test('a read answering after the deadline neither completes a recovery nor saves a snapshot', async () => {
    const inner = new InMemoryJournal();
    await seedJournal(inner, 'rg-abandoned', [2, 3]);
    const journal = new FirstReadHeldJournal(inner);
    const snapshots = new CountingSnapshotStore();
    const node = await startNode('recovery-guards-abandoned', 83_208, {
      journal, snapshotStore: snapshots,
    }, RECOVERY_TIMEOUT);
    try {
      const observations = newObservations();
      // Snapshots while the observed history is at most two events long: a
      // replay of the seeded pair saves, the sentinel persist below does not.
      const ref = spawnCounter(node, 'rg-abandoned', observations, (observedCount) => observedCount <= 2);
      await awaitCondition(() => observations.recovered.length === 1, {
        ...WAIT, label: 'the restarted instance recovered from the second read',
      });
      expect(observations.preStartFailures[0]).toBeInstanceOf(RecoveryTimeoutError);
      expect(observations.recovered[0]).toEqual({ instance: 2, state: { value: 5 } });
      const savesBeforeTheLateAnswer = snapshots.saves;

      // The first instance's read answers now — with events in it.
      journal.releaseFirstRead();
      await awaitCondition(() => journal.firstReadAnswered, { ...WAIT, label: 'the abandoned read answered' });
      // A full message round trip through the live instance after it, so a
      // continuation of the abandoned read has had every chance to run.
      ref.tell({ kind: 'add', amount: 10 });
      await awaitCondition(() => observations.persisted.includes(10), {
        ...WAIT, label: 'the live instance served a command after the late answer',
      });

      expect(observations.recovered).toEqual([{ instance: 2, state: { value: 5 } }]);
      expect(snapshots.saves).toBe(savesBeforeTheLateAnswer);
    } finally {
      journal.releaseFirstRead();
      await stopNode(node);
    }
  });
});

describe('ReplicatedEventSourcedActor — outside the storage-locality seams', () => {
  test('neither noteStoreUse nor assertPersistenceOptionsSupported is called across spawn, persist and a restart', async () => {
    // The per-node journal is the intended design for replicated event
    // sourcing, and the storage-locality advisory exempts it structurally: the
    // class never crosses the seams the advisory latches on.  Wiring the
    // breakers in must not have wired those in with them.
    const node = await startNode('recovery-guards-locality', 83_209, {
      journal: new InMemoryJournal(), snapshotStore: new InMemorySnapshotStore(),
    });
    const noteStoreUse = spyOn(node.extension, 'noteStoreUse');
    const assertSupported = spyOn(node.extension, 'assertPersistenceOptionsSupported');
    try {
      const observations = newObservations();
      const ref = spawnCounter(node, 'rg-locality', observations);
      await awaitCondition(() => observations.recovered.length === 1, { ...WAIT, label: 'the replica recovered' });
      ref.tell({ kind: 'add', amount: 1 });
      ref.tell({ kind: 'fail' });
      await awaitCondition(() => observations.recovered.length === 2, {
        ...WAIT, label: 'the replica restarted and recovered again',
      });
      ref.tell({ kind: 'add', amount: 2 });
      await awaitCondition(() => observations.persisted.includes(2), { ...WAIT, label: 'the restarted replica persisted' });

      expect(observations.recovered[1]).toEqual({ instance: 2, state: { value: 1 } });
      expect(noteStoreUse).toHaveBeenCalledTimes(0);
      expect(assertSupported).toHaveBeenCalledTimes(0);
    } finally {
      noteStoreUse.mockRestore();
      assertSupported.mockRestore();
      await stopNode(node);
    }
  });
});
