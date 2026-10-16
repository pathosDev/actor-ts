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
 *   - the append of an event received from a peer is **not** behind the
 *     breaker yet.  That path is fire-and-forget and races itself today, and
 *     #958 gives it a serialized append chain, which is where a breaker belongs
 *     on it.
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
  PubSubEnvelope,
  Subscribe,
  SubscribeAcknowledgment,
} from '../../../../../src/cluster/pubsub/index.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import type { ConfigObject } from '../../../../../src/index.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { CircuitBreakerOpenError, CircuitBreakerTimeoutError } from '../../../../../src/pattern/CircuitBreaker.js';
import type { Journal } from '../../../../../src/persistence/Journal.js';
import { JournalConcurrencyError } from '../../../../../src/persistence/JournalTypes.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { PersistenceExtensionId, type PersistenceExtension } from '../../../../../src/persistence/PersistenceExtension.js';
import {
  ReplicatedEventSourcedActor,
  type ReplicatedEventEnvelope,
} from '../../../../../src/persistence/ReplicatedEventSourcedActor.js';
import { InMemorySnapshotStore } from '../../../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import { assertCompletesWithin } from '../../../../util/AsyncAssertions.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';
import {
  AppendRejectsJournal,
  AppendStallsJournal,
  HeldAppendJournal,
  HighestSeqStallsJournal,
} from '../../../../util/UnavailableJournal.js';

type AddCommand = { readonly kind: 'add'; readonly amount: number };
type Command = AddCommand;

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

  initialState(): State { return { value: 0 }; }

  onEvent(state: State, event: Event): State { return { value: state.value + event.amount }; }

  override onRecoveryComplete(state: State): void { this.observations.recovered.push(state); }

  /** Records rather than rethrows, so a refused persist leaves the actor serving. */
  async onCommand(_state: State, command: Command): Promise<void> {
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

  test('the append of a peer\'s event stays outside the breaker until #958 gives it a serialized append chain', async () => {
    // Pins the boundary of this change rather than a goal: an envelope from an
    // authenticated peer is still absorbed AND appended with the breaker open.
    // #958 moves that fire-and-forget append into its own serialized chain,
    // where a refusal can be retried instead of logged, and puts the breaker
    // there — at which point this expectation inverts.
    const journal = new InMemoryJournal();
    const replica = await startReplica('journal-breaker-remote', 83_106, journal, 'jb-remote');
    try {
      replica.extension.journalBreaker!.setState('open');
      const peer = 'journal-breaker-peer@h:83199';
      const envelope: ReplicatedEventEnvelope<Event> = {
        persistenceId: replica.persistenceId,
        replica: peer,
        seqAtReplica: 1,
        eventId: `${peer}#${'1'.padStart(24, '0')}`,
        vc: { [peer]: 1 },
        timestamp: 1_700_000_000_000,
        event: { kind: 'added', amount: 5 },
      };
      replica.ref.tell(
        new PubSubEnvelope(`replicated-es:${replica.persistenceId}`, envelope, NodeAddress.parse(peer)) as unknown as Command,
      );
      await awaitCondition(async () => (await journal.highestSeq(replica.persistenceId)) === 1, {
        ...WAIT, label: "the peer's event was appended to the local journal",
      });

      expect(replica.observations.current!.value).toBe(5);
      expect((await storedEnvelopes(journal, replica.persistenceId))[0]!.replica).toBe(peer);
      expect(replica.extension.journalBreaker!.state).toBe('open');
    } finally {
      await stopReplica(replica);
    }
  });
});
