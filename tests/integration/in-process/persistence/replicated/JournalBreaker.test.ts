/**
 * #1497 — a replicated actor's local `persist` goes through the journal
 * breaker, as `PersistentActor`'s does.
 *
 * The replicated actor extends `Actor`, not `PersistentActor`, so none of the
 * breaker wiring `PersistentActor` got reached it: with the breaker forced
 * open it still wrote, and against a journal that accepted the append and
 * then stalled it wedged on its first command — with the documented
 * `call-timeout` fix configured — and kept `system.terminate()` pending.
 *
 * What these tests pin, beyond "the breaker is in the path":
 *
 *   - the head probe and the append are **one** call through the breaker, so
 *     a stalled `highestSeq` is bounded exactly like a stalled `append`;
 *   - the sequence number and the vector-clock tick taken before the append
 *     are kept when it fails, because a timed-out append may still land and a
 *     re-used number would then exist twice;
 *   - a losing conditional append is the journal answering, not an outage —
 *     it must not open the breaker for every other entity on the node;
 *   - the append of an event received from a peer runs through the same
 *     breaker, inside the serialized append chain #958 introduced — pinned in
 *     `RemoteAppendChain.test.ts`.
 *
 * Single node over `InMemoryTransport`, like the sibling replicated suites —
 * no OS port is bound.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import {
  DistributedPubSubId,
  Subscribe,
  SubscribeAcknowledgment,
} from '../../../../../src/cluster/pubsub/index.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import type { ConfigObject } from '../../../../../src/index.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { CircuitBreakerOpenError, CircuitBreakerTimeoutError } from '../../../../../src/pattern/CircuitBreaker.js';
import { gracefulStop } from '../../../../../src/pattern/GracefulStop.js';
import type { Journal } from '../../../../../src/persistence/Journal.js';
import { JournalConcurrencyError } from '../../../../../src/persistence/JournalTypes.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { PersistenceExtensionId, type PersistenceExtension } from '../../../../../src/persistence/PersistenceExtension.js';
import type { ReplicatedSnapshot } from '../../../../../src/persistence/replicated/ReplicatedSnapshot.js';
import {
  ReplicatedEventSourcedActor,
  type ReplicatedEventEnvelope,
} from '../../../../../src/persistence/ReplicatedEventSourcedActor.js';
import { InMemorySnapshotStore } from '../../../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import { FaultInjectingJournal } from '../../../../../src/testkit/FaultInjectingJournal.js';
import { FaultInjectingJournalOptions } from '../../../../../src/testkit/FaultInjectingJournalOptions.js';
import { assertCompletesWithin } from '../../../../util/AsyncAssertions.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';
import {
  AppendRejectsJournal,
  AppendStallsJournal,
  HeldAppendJournal,
  HighestSeqStallsJournal,
  UnreachableSnapshotStore,
} from '../../../../util/UnavailableJournal.js';

type AddCommand = { readonly kind: 'add'; readonly amount: number };
/** Keeps the actor's mailbox busy until `gate` settles — nothing else runs in between. */
type HoldCommand = { readonly kind: 'hold'; readonly gate: Promise<void> };
type Command = AddCommand | HoldCommand;

type AddedEvent = { readonly kind: 'added'; readonly amount: number };
type Event = AddedEvent;

type State = { readonly value: number };

const WAIT = { timeoutMs: 3_000, intervalMs: 5 } as const;

/** Bounds a teardown step, so a wedged actor fails the test rather than the runner. */
const TEARDOWN_BUDGET_MS = 2_000;

/** A journal call-timeout short enough to cut a stall inside one test. */
const CALL_TIMEOUT: ConfigObject = {
  'actor-ts': { 'circuit-breaker': { 'persistence-journal': { 'call-timeout': '50ms' } } },
};

/** Everything a test reads, kept outside the actor so it outlives an instance. */
type Observations = {
  readonly persisted: number[];
  readonly persistFailures: Error[];
  readonly recovered: State[];
  /** The live instance; replaced when the actor is restarted. */
  current: Counter | null;
};

class Counter extends ReplicatedEventSourcedActor<Command, Event, State> {
  readonly persistenceId: string;

  constructor(persistenceId: string, private readonly observations: Observations) {
    super();
    this.persistenceId = persistenceId;
    observations.current = this;
  }

  /** The folded value, read by the test between messages. */
  get value(): number { return this.state.value; }

  /** A snapshot of the current state, taken by the test between messages. */
  snapshotNow(): Promise<void> { return this.saveSnapshot(); }

  initialState(): State { return { value: 0 }; }

  onEvent(state: State, event: Event): State { return { value: state.value + event.amount }; }

  override onRecoveryComplete(state: State): void { this.observations.recovered.push(state); }

  /** Records rather than rethrows, so a refused persist leaves the actor serving. */
  async onCommand(_state: State, command: Command): Promise<void> {
    if (command.kind === 'hold') {
      await command.gate;
      return;
    }
    try {
      await this.persist({ kind: 'added', amount: command.amount });
      this.observations.persisted.push(command.amount);
    } catch (e) {
      this.observations.persistFailures.push(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

/** Records what the replication topic carries — the observable half of "nothing was broadcast". */
class TopicProbe extends Actor<unknown> {
  constructor(private readonly received: unknown[]) { super(); }

  override onReceive(message: unknown): void { this.received.push(message); }
}

type Replica = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly extension: PersistenceExtension;
  readonly ref: ActorRef<Command | ReplicatedEventEnvelope<Event>>;
  readonly observations: Observations;
  readonly persistenceId: string;
};

async function startReplica(
  name: string,
  port: number,
  journal: Journal,
  persistenceId: string,
  config?: ConfigObject,
): Promise<Replica> {
  let options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (config) options = options.withConfig(config);
  const system = ActorSystem.create(name, options);
  const extension = system.extension(PersistenceExtensionId);
  extension.configure({ journal, snapshotStore: new InMemorySnapshotStore() });
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  const observations: Observations = { persisted: [], persistFailures: [], recovered: [], current: null };
  const ref = system.spawn(() => new Counter(persistenceId, observations), 'counter');
  await awaitCondition(() => observations.recovered.length === 1, { ...WAIT, label: `${name}: the replica recovered` });
  return { system, cluster, extension, ref, observations, persistenceId };
}

/**
 * Leave and terminate, each raced against a budget inside the test body.  The
 * wedge #1497 found kept `terminate()` pending forever, and a teardown left to
 * the runner's timeout would report that as "timed out" without saying where.
 */
async function stopReplica(replica: Replica): Promise<void> {
  await assertCompletesWithin(replica.cluster.leave(), TEARDOWN_BUDGET_MS, `${replica.system.name}: cluster.leave() settled`);
  await assertCompletesWithin(replica.system.terminate(), TEARDOWN_BUDGET_MS, `${replica.system.name}: system.terminate() settled`);
}

async function storedEnvelopes(journal: Journal, persistenceId: string): Promise<ReplicatedEventEnvelope<Event>[]> {
  const events = await journal.read<ReplicatedEventEnvelope<Event>>(persistenceId, 1);
  return events.map((e) => e.event);
}

const isEnvelope = (message: unknown): message is ReplicatedEventEnvelope<Event> =>
  typeof message === 'object' && message !== null && 'seqAtReplica' in message;

describe('ReplicatedEventSourcedActor — the local persist goes through the journal breaker (#1497)', () => {
  test('an open breaker refuses the persist before the journal, the fold or the topic', async () => {
    const journal = new InMemoryJournal();
    const replica = await startReplica('journal-breaker-open', 83_101, journal, 'jb-open');
    try {
      // A second subscriber on the replica's own topic: whatever the actor
      // broadcasts lands here as a plain envelope.
      const received: unknown[] = [];
      const probe = replica.system.spawn(() => new TopicProbe(received), 'topic-probe');
      const mediator = replica.system.extension(DistributedPubSubId).start(replica.cluster);
      mediator.tell(new Subscribe(`replicated-es:${replica.persistenceId}`, probe, probe));
      await awaitCondition(() => received.some((m) => m instanceof SubscribeAcknowledgment), {
        ...WAIT, label: 'the topic probe is subscribed',
      });

      replica.extension.journalBreaker!.setState('open');
      replica.ref.tell({ kind: 'add', amount: 1 });
      await awaitCondition(() => replica.observations.persistFailures.length === 1, {
        ...WAIT, label: 'the persist was refused by the open breaker',
      });

      expect(replica.observations.persistFailures[0]).toBeInstanceOf(CircuitBreakerOpenError);
      expect(await journal.highestSeq(replica.persistenceId)).toBe(0);
      expect(replica.observations.current!.value).toBe(0);

      // The absence of a broadcast, read off a presence: once the breaker
      // closes, the next persist's envelope reaches the probe, and the topic
      // is FIFO from this publisher — so a broadcast of the refused event
      // would have arrived ahead of it.
      replica.extension.journalBreaker!.setState('closed');
      replica.ref.tell({ kind: 'add', amount: 2 });
      await awaitCondition(() => received.some(isEnvelope), {
        ...WAIT, label: 'the persist after the breaker closed was broadcast',
      });
      expect(received.filter(isEnvelope).map((e) => e.event.amount)).toEqual([2]);
      expect(replica.observations.current!.value).toBe(2);
    } finally {
      await stopReplica(replica);
    }
  });

  test('call-timeout cuts a stalled append, the next command is served, and terminate() settles', async () => {
    const journal = new AppendStallsJournal(new InMemoryJournal());
    const replica = await startReplica('journal-breaker-stall', 83_102, journal, 'jb-stall', CALL_TIMEOUT);
    try {
      replica.ref.tell({ kind: 'add', amount: 1 });
      await awaitCondition(() => replica.observations.persistFailures.length === 1, {
        ...WAIT, label: 'the stalled append was cut at the call-timeout',
      });
      expect(replica.observations.persistFailures[0]).toBeInstanceOf(CircuitBreakerTimeoutError);

      // The actor's turn ended, so the mailbox moves on.
      replica.ref.tell({ kind: 'add', amount: 2 });
      await awaitCondition(() => replica.observations.persistFailures.length === 2, {
        ...WAIT, label: 'the next command was handled after the timed-out one',
      });
      expect(replica.observations.persistFailures[1]).toBeInstanceOf(CircuitBreakerTimeoutError);
      expect(replica.observations.persisted).toEqual([]);

      // Still stalled underneath, and the system goes down anyway.
      await stopReplica(replica);
    } finally {
      journal.settleAll();
      await stopReplica(replica);
    }
  });

  test('the head probe is inside the same breaker call — a stalled highestSeq is cut too', async () => {
    const journal = new HighestSeqStallsJournal(new InMemoryJournal());
    const replica = await startReplica('journal-breaker-head', 83_103, journal, 'jb-head', CALL_TIMEOUT);
    try {
      replica.ref.tell({ kind: 'add', amount: 1 });
      await awaitCondition(() => replica.observations.persistFailures.length === 1, {
        ...WAIT, label: 'the stalled head probe was cut at the call-timeout',
      });
      expect(replica.observations.persistFailures[0]).toBeInstanceOf(CircuitBreakerTimeoutError);
      // Cut while still probing: the append itself was never reached.
      expect(journal.inFlight).toBe(1);
      expect(await journal.read(replica.persistenceId, 1)).toEqual([]);
    } finally {
      journal.settleAll();
      await stopReplica(replica);
    }
  });

  test('a timed-out append that lands later is not re-numbered by the next persist', async () => {
    const journal = new HeldAppendJournal(new InMemoryJournal());
    const replica = await startReplica('journal-breaker-late', 83_104, journal, 'jb-late', CALL_TIMEOUT);
    try {
      replica.ref.tell({ kind: 'add', amount: 1 });
      await awaitCondition(() => replica.observations.persistFailures.length === 1, {
        ...WAIT, label: 'the held append was cut at the call-timeout',
      });
      expect(replica.observations.persistFailures[0]).toBeInstanceOf(CircuitBreakerTimeoutError);

      // The write the actor was told had failed reaches the journal after all.
      journal.landAll();
      await awaitCondition(async () => (await journal.highestSeq(replica.persistenceId)) === 1, {
        ...WAIT, label: 'the timed-out append landed late',
      });

      replica.ref.tell({ kind: 'add', amount: 2 });
      await awaitCondition(() => replica.observations.persisted.includes(2), {
        ...WAIT, label: 'the next persist succeeded',
      });

      const [late, next] = await storedEnvelopes(journal, replica.persistenceId);
      expect(late!.event.amount).toBe(1);
      expect(next!.event.amount).toBe(2);
      expect(next!.seqAtReplica).toBeGreaterThan(late!.seqAtReplica);
      expect(next!.vc[next!.replica]!).toBeGreaterThan(late!.vc[late!.replica]!);
    } finally {
      journal.landAll();
      await stopReplica(replica);
    }
  });

  test('ten losing conditional appends are refused with JournalConcurrencyError and leave max-failures = 1 closed', async () => {
    const journal = new AppendRejectsJournal(
      new InMemoryJournal(),
      (persistenceId, expectedSeq) => new JournalConcurrencyError(persistenceId, expectedSeq, expectedSeq + 1),
    );
    const replica = await startReplica('journal-breaker-ownership', 83_105, journal, 'jb-ownership', {
      'actor-ts': { 'circuit-breaker': { 'persistence-journal': { 'max-failures': 1 } } },
    });
    try {
      for (let amount = 1; amount <= 10; amount++) replica.ref.tell({ kind: 'add', amount });
      await awaitCondition(() => replica.observations.persistFailures.length === 10, {
        ...WAIT, label: 'all ten persists were answered',
      });

      for (const failure of replica.observations.persistFailures) {
        expect(failure).toBeInstanceOf(JournalConcurrencyError);
      }
      expect(journal.appendCalls).toBe(10);
      expect(replica.extension.journalBreaker!.state).toBe('closed');
    } finally {
      await stopReplica(replica);
    }
  });
});

/**
 * `add 1` is cut at the call-timeout and its append lands afterwards; `add 2`
 * then persists.  The late event is folded and broadcast once it has landed,
 * so the live state shows both (#1732).
 */
async function landLateThenPersist(replica: Replica, journal: HeldAppendJournal): Promise<void> {
  replica.ref.tell({ kind: 'add', amount: 1 });
  await awaitCondition(() => replica.observations.persistFailures.length === 1, {
    ...WAIT, label: 'the held append was cut at the call-timeout',
  });
  expect(replica.observations.current!.value).toBe(0);
  journal.landAll();
  await awaitCondition(() => replica.observations.current!.value === 1, {
    ...WAIT, label: 'the timed-out append landed late and was folded',
  });
  replica.ref.tell({ kind: 'add', amount: 2 });
  await awaitCondition(() => replica.observations.persisted.includes(2), {
    ...WAIT, label: 'the next persist succeeded',
  });
  expect(replica.observations.current!.value).toBe(3);
}

/**
 * `add 1`'s append lands late — `land` makes it — with the mailbox held, and
 * `add 2` persists behind the hold, so the journal's head moves past the late
 * event before its fold runs.  A snapshot taken then must stop short of the
 * late event, and a recovery from it must hold both (#1732).
 */
async function snapshotBetweenLandingAndFold(replica: Replica, land: () => void): Promise<void> {
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  replica.ref.tell({ kind: 'hold', gate: new Promise<void>((resolve) => { releaseFirst = resolve; }) });
  replica.ref.tell({ kind: 'add', amount: 2 });
  replica.ref.tell({ kind: 'hold', gate: new Promise<void>((resolve) => { releaseSecond = resolve; }) });
  try {
    land();
    await awaitCondition(async () => (await replica.extension.journal.highestSeq(replica.persistenceId)) === 1, {
      ...WAIT, label: 'the first event landed',
    });
    releaseFirst();
    await awaitCondition(() => replica.observations.persisted.includes(2), { ...WAIT, label: 'the second event persisted' });

    await replica.observations.current!.snapshotNow();
    const snapshot = await latestSnapshot(replica);
    expect(snapshot?.state).toEqual({ value: 2 });
    expect(snapshot?.journalSeqAtSnapshot).toBe(0);

    releaseSecond();
    await awaitCondition(() => replica.observations.current!.value === 3, { ...WAIT, label: 'the late event was folded' });
    expect(await restartedState(replica, 'counter-from-early-snapshot')).toEqual({ value: 3 });
  } finally {
    releaseFirst?.();
    releaseSecond?.();
  }
}

type Restarted = {
  readonly ref: ActorRef<Command | ReplicatedEventEnvelope<Event>>;
  readonly state: State;
};

/** Stop the replica's actor `running` and spawn it again over the same stores; answers the new one and what it recovered. */
async function restarted(
  replica: Replica,
  running: ActorRef<Command | ReplicatedEventEnvelope<Event>>,
  name: string,
): Promise<Restarted> {
  expect(await gracefulStop(running, TEARDOWN_BUDGET_MS)).toBe(true);
  const recoveriesBefore = replica.observations.recovered.length;
  const ref = replica.system.spawn(() => new Counter(replica.persistenceId, replica.observations), name);
  await awaitCondition(() => replica.observations.recovered.length === recoveriesBefore + 1, {
    ...WAIT, label: `${name}: the restarted replica recovered`,
  });
  return { ref, state: replica.observations.recovered.at(-1)! };
}

/** {@link restarted}, once, from the replica's first actor; answers the state it recovered. */
async function restartedState(replica: Replica, name: string): Promise<State> {
  return (await restarted(replica, replica.ref, name)).state;
}

/** A second subscriber on the replica's own topic; answers what it receives. */
async function subscribeProbe(replica: Replica): Promise<unknown[]> {
  const received: unknown[] = [];
  const probe = replica.system.spawn(() => new TopicProbe(received), `topic-probe-${replica.observations.recovered.length}`);
  const mediator = replica.system.extension(DistributedPubSubId).start(replica.cluster);
  mediator.tell(new Subscribe(`replicated-es:${replica.persistenceId}`, probe, probe));
  await awaitCondition(() => received.some((m) => m instanceof SubscribeAcknowledgment), {
    ...WAIT, label: 'the topic probe is subscribed',
  });
  return received;
}

async function latestSnapshot(replica: Replica): Promise<ReplicatedSnapshot<Event, State> | undefined> {
  const saved = await replica.extension.snapshotStore
    .loadLatest<ReplicatedSnapshot<Event, State>>(replica.persistenceId);
  return saved.isSome() ? saved.value.state : undefined;
}

/** The first append commits and then fails, as a connection that drops before the reply does. */
function firstAnswerLostJournal(): FaultInjectingJournal {
  const journalFaults = FaultInjectingJournalOptions.create()
    .withFailOn('append')
    .withFailOnce()
    .withFailurePoint('after-operation');
  return new FaultInjectingJournal(new InMemoryJournal(), journalFaults);
}

// An append whose outcome the caller never saw — cut by `call-timeout`, or
// committed with the answer lost — is settled once the journal call itself
// settles: if it landed, the event is folded and broadcast as a successful
// persist's would have been; if the replica stopped first, its successor
// waits for the call before it recovers, and re-publishes its own events.
describe('ReplicatedEventSourcedActor — an append of unknown outcome is settled (#1732)', () => {
  test('a timed-out append that lands later is folded and broadcast, and a snapshot after it recovers it', async () => {
    const journal = new HeldAppendJournal(new InMemoryJournal());
    const replica = await startReplica('journal-breaker-late-snapshot', 83_107, journal, 'jb-late-snapshot', CALL_TIMEOUT);
    try {
      const received = await subscribeProbe(replica);
      await landLateThenPersist(replica, journal);
      await awaitCondition(() => received.filter(isEnvelope).length === 2, { ...WAIT, label: 'both events were broadcast' });
      expect(received.filter(isEnvelope).map((e) => e.event.amount)).toEqual([1, 2]);

      await replica.observations.current!.snapshotNow();
      const snapshot = await latestSnapshot(replica);
      expect(snapshot?.journalSeqAtSnapshot).toBe(2);
      expect(snapshot?.state).toEqual({ value: 3 });

      expect(await restartedState(replica, 'counter-from-snapshot')).toEqual({ value: 3 });
    } finally {
      journal.landAll();
      await stopReplica(replica);
    }
  });

  test('a recovery with no snapshot replays it once', async () => {
    const journal = new HeldAppendJournal(new InMemoryJournal());
    const replica = await startReplica('journal-breaker-late-replay', 83_108, journal, 'jb-late-replay', CALL_TIMEOUT);
    try {
      await landLateThenPersist(replica, journal);
      expect(await restartedState(replica, 'counter-replayed')).toEqual({ value: 3 });
    } finally {
      journal.landAll();
      await stopReplica(replica);
    }
  });

  test('with the snapshot unreadable and snapshot-is-optional on, the same history recovers to the same state', async () => {
    const journal = new HeldAppendJournal(new InMemoryJournal());
    const optional: ConfigObject = {
      'actor-ts': {
        'circuit-breaker': { 'persistence-journal': { 'call-timeout': '50ms' } },
        persistence: { 'snapshot-is-optional': true },
      },
    };
    const replica = await startReplica('journal-breaker-late-optional', 83_109, journal, 'jb-late-optional', optional);
    try {
      await landLateThenPersist(replica, journal);
      await replica.observations.current!.snapshotNow();
      replica.extension.setSnapshotStore(new UnreachableSnapshotStore());
      expect(await restartedState(replica, 'counter-without-its-snapshot')).toEqual({ value: 3 });
    } finally {
      journal.landAll();
      await stopReplica(replica);
    }
  });

  test('a snapshot taken after the landing but before the fold does not count the event as covered', async () => {
    const journal = new HeldAppendJournal(new InMemoryJournal());
    const replica = await startReplica('journal-breaker-late-covered', 83_111, journal, 'jb-late-covered', CALL_TIMEOUT);
    let release!: () => void;
    try {
      replica.ref.tell({ kind: 'add', amount: 1 });
      await awaitCondition(() => replica.observations.persistFailures.length === 1, {
        ...WAIT, label: 'the held append was cut at the call-timeout',
      });
      // Occupy the mailbox, so the fold of the landed event has to wait: the
      // mailbox is FIFO, and the fold is told only once the append lands.
      replica.ref.tell({ kind: 'hold', gate: new Promise<void>((resolve) => { release = resolve; }) });
      journal.landAll();
      await awaitCondition(async () => (await journal.highestSeq(replica.persistenceId)) === 1, {
        ...WAIT, label: 'the timed-out append landed',
      });

      await replica.observations.current!.snapshotNow();
      const snapshot = await latestSnapshot(replica);
      expect(snapshot?.state).toEqual({ value: 0 });
      // The journal position it records stops short of the unfolded event.
      expect(snapshot?.journalSeqAtSnapshot).toBe(0);

      release();
      await awaitCondition(() => replica.observations.current!.value === 1, { ...WAIT, label: 'the landed event was folded' });
      expect(await restartedState(replica, 'counter-after-early-snapshot')).toEqual({ value: 1 });
    } finally {
      release?.();
      journal.landAll();
      await stopReplica(replica);
    }
  });

  test('a late landing seen through the cut call itself keeps its position when a later persist moves the journal on', async () => {
    const journal = new HeldAppendJournal(new InMemoryJournal());
    const replica = await startReplica('journal-breaker-late-position', 83_113, journal, 'jb-late-position', CALL_TIMEOUT);
    try {
      replica.ref.tell({ kind: 'add', amount: 1 });
      await awaitCondition(() => replica.observations.persistFailures.length === 1, {
        ...WAIT, label: 'the held append was cut at the call-timeout',
      });
      await snapshotBetweenLandingAndFold(replica, () => journal.landAll());
    } finally {
      journal.landAll();
      await stopReplica(replica);
    }
  });

  test('a late landing found by reading the journal back keeps its position when a later persist moves the journal on', async () => {
    const journal = firstAnswerLostJournal();
    const replica = await startReplica('journal-breaker-found-position', 83_114, journal, 'jb-found-position');
    try {
      // Lands at once, answered as failed; the holds queue up behind it in the
      // same synchronous stretch, ahead of the fold its read-back schedules.
      replica.ref.tell({ kind: 'add', amount: 1 });
      await snapshotBetweenLandingAndFold(replica, () => {});
    } finally {
      await stopReplica(replica);
    }
  });

  test('an append cut before its turn in the chain came is never written, and never folded', async () => {
    const journal = new HeldAppendJournal(new InMemoryJournal());
    const replica = await startReplica('journal-breaker-cancelled', 83_115, journal, 'jb-cancelled', CALL_TIMEOUT);
    try {
      replica.ref.tell({ kind: 'add', amount: 1 });
      await awaitCondition(() => replica.observations.persistFailures.length === 1, {
        ...WAIT, label: 'the held append was cut at the call-timeout',
      });
      // Queued behind the held append, and cut before the journal is asked.
      replica.ref.tell({ kind: 'add', amount: 2 });
      await awaitCondition(() => replica.observations.persistFailures.length === 2, {
        ...WAIT, label: 'the queued append was cut before its turn',
      });
      expect(journal.heldCount).toBe(1);

      journal.landAll();
      await awaitCondition(() => replica.observations.current!.value === 1, { ...WAIT, label: 'the held append landed and was folded' });
      // The successor waits for every settling of the stopped instance.
      expect(await restartedState(replica, 'counter-after-cancel')).toEqual({ value: 1 });
      expect((await storedEnvelopes(journal, replica.persistenceId)).map((e) => e.event.amount)).toEqual([1]);
    } finally {
      journal.landAll();
      await stopReplica(replica);
    }
  });

  test('a store that commits and then fails is settled by reading the journal back, with no breaker involved', async () => {
    const journal = firstAnswerLostJournal();
    const replica = await startReplica('journal-breaker-lost-answer', 83_110, journal, 'jb-lost-answer');
    try {
      const received = await subscribeProbe(replica);
      replica.ref.tell({ kind: 'add', amount: 1 });
      await awaitCondition(() => replica.observations.persistFailures.length === 1, {
        ...WAIT, label: 'the committed append was answered as failed',
      });
      await awaitCondition(() => replica.observations.current!.value === 1, {
        ...WAIT, label: 'the read-back found the event and folded it',
      });
      replica.ref.tell({ kind: 'add', amount: 2 });
      await awaitCondition(() => replica.observations.persisted.includes(2), {
        ...WAIT, label: 'the next persist succeeded',
      });
      expect(replica.observations.current!.value).toBe(3);
      await awaitCondition(() => received.filter(isEnvelope).length === 2, { ...WAIT, label: 'both events were broadcast' });

      await replica.observations.current!.snapshotNow();
      const fromSnapshot = await restarted(replica, replica.ref, 'counter-after-lost-answer');
      expect(fromSnapshot.state).toEqual({ value: 3 });

      // The same journal with nothing to start from: the full replay agrees.
      replica.extension.setSnapshotStore(new InMemorySnapshotStore());
      const replayed = await restarted(replica, fromSnapshot.ref, 'counter-replayed-after-lost-answer');
      expect(replayed.state).toEqual({ value: 3 });
    } finally {
      await stopReplica(replica);
    }
  });

  test('a late landing after the actor stopped is recovered and re-published by its successor, and its number is never reused', async () => {
    const journal = new HeldAppendJournal(new InMemoryJournal());
    const replica = await startReplica('journal-breaker-late-restart', 83_112, journal, 'jb-late-restart', CALL_TIMEOUT);
    try {
      replica.ref.tell({ kind: 'add', amount: 1 });
      await awaitCondition(() => replica.observations.persistFailures.length === 1, {
        ...WAIT, label: 'the held append was cut at the call-timeout',
      });
      expect(await gracefulStop(replica.ref, TEARDOWN_BUDGET_MS)).toBe(true);
      const received = await subscribeProbe(replica);

      // The successor waits for its predecessor's append before it reads.
      const recoveriesBefore = replica.observations.recovered.length;
      const successor = replica.system.spawn(() => new Counter(replica.persistenceId, replica.observations), 'counter-2');
      // An absence: the successor must NOT have recovered while the append is held.
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      expect(replica.observations.recovered.length).toBe(recoveriesBefore);
      journal.landAll();
      await awaitCondition(() => replica.observations.recovered.length === recoveriesBefore + 1, {
        ...WAIT, label: 'the successor recovered once the append landed',
      });
      expect(replica.observations.recovered.at(-1)).toEqual({ value: 1 });
      // No peer had received it; the successor's recovery publishes it.
      await awaitCondition(() => received.some(isEnvelope), { ...WAIT, label: 'the late event was re-published' });
      expect(received.filter(isEnvelope).map((e) => e.event.amount)).toEqual([1]);

      successor.tell({ kind: 'add', amount: 2 });
      await awaitCondition(() => replica.observations.persisted.includes(2), { ...WAIT, label: 'the next persist succeeded' });
      const stored = await storedEnvelopes(journal, replica.persistenceId);
      expect(stored.map((e) => [e.event.amount, e.seqAtReplica])).toEqual([[1, 1], [2, 2]]);
    } finally {
      journal.landAll();
      await stopReplica(replica);
    }
  });
});
