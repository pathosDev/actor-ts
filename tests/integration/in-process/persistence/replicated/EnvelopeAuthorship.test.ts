/**
 * An envelope's author is the node that sent it, not the name inside it (#706).
 *
 * `ReplicatedEventSourcedActor` read `replica` — the id that keys the vector
 * clock, prefixes every event id and breaks ties in the deterministic order —
 * straight out of the broadcast payload. Any member of the cluster could
 * therefore publish an event attributed to a peer, and with a large enough
 * `timestamp` make it sort last and win the fold on every replica. Nothing
 * downstream could tell: `DistributedPubSub` delivered subscribers the bare
 * body, so the `from` the transport had authenticated never left
 * `Cluster.dispatchEnvelope`.
 *
 * Four things are asserted here.
 *
 *   1. **The honest path still works.** Two real replicas on one in-memory
 *      cluster exchange events end to end. Without this the three refusals
 *      below would also be satisfied by a fix that refused everything.
 *   2. **Impersonation is refused.** A member that publishes under another
 *      replica's id is dropped with a `WARN` naming the node it actually came
 *      from.
 *   3. **The route around pub-sub is closed.** `Cluster.dispatchEnvelope`
 *      resolves any path and `tell`s the raw body with no identity at all, so
 *      a fix that only taught the mediator to carry an origin would leave the
 *      attack reachable one path over. The *same* envelope is delivered by
 *      both routes here, and only the one that carries an origin lands.
 *   4. **A replica id that is not a node address needs the documented
 *      override.** `replicaId` may legitimately be `'eu-west'`, which is why
 *      the check is a predicate and not a hard-wired equality — and why the
 *      default refuses it until the deployment supplies the mapping.
 *
 * Deliveries are made by hand rather than through a hostile node, because the
 * shape reaching the actor is the whole point: a `PubSubEnvelope` is what the
 * mediator hands an origin-subscriber, and a bare object is what every other
 * route produces. Test 1 is the one that proves the hand-made shape is the
 * real one.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { PubSubEnvelope } from '../../../../../src/cluster/pubsub/Messages.js';
import { LogLevel, type Logger } from '../../../../../src/Logger.js';
import type { LogContextData } from '../../../../../src/LogContext.js';
import { ReplicatedEventSourcedActor } from '../../../../../src/persistence/ReplicatedEventSourcedActor.js';
import type { ReplicatedEventEnvelope } from '../../../../../src/persistence/ReplicatedEventSourcedActor.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { InMemorySnapshotStore } from '../../../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import { PersistenceExtensionId } from '../../../../../src/persistence/PersistenceExtension.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

const PERSISTENCE_ID = 'authorship-counter';
const TOPIC = `replicated-es:${PERSISTENCE_ID}`;
const WAIT = { timeoutMs: 6_000, intervalMs: 10 } as const;

type AddCommand = { kind: 'add'; n: number };
type Command = AddCommand;
type AddedEvent = { kind: 'added'; n: number };
type Event = AddedEvent;
type State = { value: number };

/**
 * The counter under test.
 *
 * The spy is per instance, not module-level: two replicas run side by side in
 * the first test and a shared array could not say which of them folded what.
 */
class AuthorshipCounter extends ReplicatedEventSourcedActor<Command, Event, State> {
  readonly persistenceId = PERSISTENCE_ID;
  readonly applied: number[] = [];

  initialState(): State { return { value: 0 }; }

  onEvent(state: State, event: Event): State {
    this.applied.push(event.n);
    return { value: state.value + event.n };
  }

  async onCommand(_state: State, command: Command): Promise<void> {
    if (command.kind === 'add') await this.persist({ kind: 'added', n: command.n });
  }

  /** Tight enough that a cross-node subscription propagates inside the test. */
  protected override pubsubGossipIntervalMs(): number { return 25; }

  /** `replicaId` is protected-by-convention only; the tests need to read it. */
  get replica(): string { return this.replicaId; }
}

/**
 * A replica named after a region rather than after its node — the override the
 * `replicaId` docblock shows, and the deployment shape that makes the
 * authorship check a predicate instead of an equality.
 */
class RegionCounter extends AuthorshipCounter {
  /** Which node speaks for which region.  Rewritten per test. */
  static nodesByRegion: Record<string, string> = {};
  /** Whether this instance overrides the check at all. */
  static mapRegions = true;

  override get replicaId(): string { return 'eu-west'; }

  protected override isAuthorizedAuthor(replica: string, origin: NodeAddress): boolean {
    if (!RegionCounter.mapRegions) return super.isAuthorizedAuthor(replica, origin);
    return RegionCounter.nodesByRegion[replica] === origin.toString();
  }
}

type LogRecord = { readonly level: string; readonly message: string };

/** Collects the actor's `WARN`s so a refusal can be told from a silent drop. */
class RecordingLogger implements Logger {
  readonly records: LogRecord[] = [];

  constructor(
    readonly level: LogLevel = LogLevel.Debug,
    private readonly root: RecordingLogger | null = null,
  ) {}

  private get sink(): RecordingLogger { return this.root ?? this; }

  private record(level: string, message: string): void {
    this.sink.records.push({ level, message });
  }

  debug(message: string): void { this.record('debug', message); }
  info(message: string): void { this.record('info', message); }
  warn(message: string): void { this.record('warn', message); }
  error(message: string): void { this.record('error', message); }

  withSource(_source: string): Logger { return new RecordingLogger(this.level, this.sink); }
  withFields(_fields: LogContextData): Logger { return new RecordingLogger(this.level, this.sink); }
}

type Replica = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly ref: ActorRef<Command>;
  readonly instance: AuthorshipCounter;
  readonly journal: InMemoryJournal;
  readonly logger: RecordingLogger;
};

/**
 * Start one replica on its own system.
 *
 * `systemName` is shared between replicas of the same cluster on purpose: the
 * pub-sub mediator is addressed by a well-known path derived from it, so two
 * nodes that disagree about it cannot route a publish to each other.
 */
async function startReplica(
  systemName: string,
  port: number,
  seeds: string[] = [],
  make: () => AuthorshipCounter = () => new AuthorshipCounter(),
): Promise<Replica> {
  const logger = new RecordingLogger();
  const system = ActorSystem.create(systemName, ActorSystemOptions.create().withLogger(logger));
  const journal = new InMemoryJournal();
  system.extension(PersistenceExtensionId).setJournal(journal);
  system.extension(PersistenceExtensionId).setSnapshotStore(new InMemorySnapshotStore());
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 400, downAfterMs: 800 })
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  let instance: AuthorshipCounter | null = null;
  const ref = system.spawn(
    () => {
      const created = make();
      instance = created;
      return created as unknown as Actor<Command>;
    },
    'counter',
  );
  await awaitCondition(() => instance !== null && instance.replica.length > 0, {
    ...WAIT, label: `${systemName}@h:${port}: the replica was constructed`,
  });
  return { system, cluster, ref, instance: instance!, journal, logger };
}

async function stopReplica(replica: Replica): Promise<void> {
  await replica.cluster.leave();
  await replica.system.terminate();
}

/** Deliver on the replication topic, as the mediator does for an origin-subscriber. */
function deliverOnTopic(replica: Replica, envelope: unknown, sendingNode: string): void {
  replica.ref.tell(
    new PubSubEnvelope(TOPIC, envelope, NodeAddress.parse(sendingNode)) as unknown as Command,
  );
}

/**
 * Deliver straight at the actor, with no identity — what
 * `Cluster.dispatchEnvelope` does once a frame's `to` resolves to a path and
 * misses every per-path handler.
 */
function deliverOffTopic(replica: Replica, envelope: unknown): void {
  replica.ref.tell(envelope as unknown as Command);
}

/** A well-formed envelope authored by `author`.  Only the author varies. */
function envelopeFrom(author: string, amount: number, sequence: number): ReplicatedEventEnvelope<Event> {
  return {
    persistenceId: PERSISTENCE_ID,
    replica: author,
    seqAtReplica: sequence,
    eventId: `${author}#${sequence.toString(16).padStart(24, '0')}`,
    vc: { [author]: sequence },
    timestamp: 1_700_000_000_000 + sequence,
    event: { kind: 'added', n: amount },
  };
}

/**
 * Drive the receiver past the messages under test.
 *
 * The mailbox is FIFO and the actor handles one message at a time, so a local
 * `add` told after the deliveries is observable only once every one of them
 * has been handled — which turns each "nothing happened" assertion into a poll
 * on settled state rather than a bet on a fixed delay.
 */
async function drainWithSentinel(replica: Replica, marker: number): Promise<void> {
  replica.ref.tell({ kind: 'add', n: marker });
  await awaitCondition(() => replica.instance.applied.includes(marker), {
    ...WAIT, label: `the sentinel add(${marker}) was folded, so every earlier message is handled`,
  });
}

const warningsMatching = (replica: Replica, needle: string): LogRecord[] =>
  replica.logger.records.filter((r) => r.level === 'warn' && r.message.includes(needle));

describe('replicated envelope authorship — the honest path (#706)', () => {
  test('two replicas on one cluster still exchange events end to end', async () => {
    const alpha = await startReplica('authorship-pair', 70_601);
    const beta = await startReplica('authorship-pair', 70_602, ['authorship-pair@h:70601']);
    try {
      await awaitCondition(
        () => alpha.cluster.upMembers().length === 2 && beta.cluster.upMembers().length === 2,
        { ...WAIT, label: 'both replicas see a two-member cluster' },
      );

      // Re-published until it lands: the subscription has to reach alpha's
      // mediator by gossip first, and a publish that runs before it does is
      // dead-lettered with nothing to retransmit it.
      await awaitCondition(
        () => {
          alpha.ref.tell({ kind: 'add', n: 7 });
          return beta.instance.applied.includes(7);
        },
        { ...WAIT, label: "beta folded an event alpha authored" },
      );

      // Not just folded — attributed, and journalled under alpha's replica id,
      // which is the value the whole check is about.
      const journalled = await beta.journal.read<ReplicatedEventEnvelope<Event>>(PERSISTENCE_ID, 1);
      const fromAlpha = journalled.filter((entry) => entry.event.replica === alpha.instance.replica);
      expect(fromAlpha.length, "beta kept no event authored by alpha").toBeGreaterThan(0);
      expect(warningsMatching(beta, 'dropped a remote envelope')).toEqual([]);
    } finally {
      await stopReplica(beta);
      await stopReplica(alpha);
    }
  }, 30_000);
});

describe('replicated envelope authorship — impersonation (#706)', () => {
  test('a member may not publish under another replica\'s id', async () => {
    const victim = 'authorship-victim@h:70698';
    const attacker = 'authorship-attacker@h:70699';
    const replica = await startReplica('authorship-impersonate', 70_611);
    try {
      // The reported attack: the attacker's own event, attributed to the
      // victim, stamped to sort after everything the victim will ever write.
      const forged = {
        ...envelopeFrom(victim, 1_111, 1),
        timestamp: Number.MAX_SAFE_INTEGER,
      };
      deliverOnTopic(replica, forged, attacker);
      // The control: the same claim, from the node it belongs to.
      deliverOnTopic(replica, envelopeFrom(victim, 2_222, 2), victim);
      await drainWithSentinel(replica, 5);

      expect(
        replica.instance.applied,
        'an event attributed to a replica the sending node does not speak for was folded',
      ).not.toContain(1_111);
      expect(
        replica.instance.applied,
        "the victim's own event was refused too — the check does not discriminate",
      ).toContain(2_222);

      const refusals = warningsMatching(replica, 'may not be written by');
      expect(refusals.length, 'the impersonation was dropped silently').toBe(1);
      expect(refusals[0]!.message).toContain(victim);
      expect(refusals[0]!.message).toContain(attacker);

      // And nothing of the forgery survives in the journal, which is what
      // makes the impersonation permanent rather than transient.
      const journalled = await replica.journal.read<ReplicatedEventEnvelope<Event>>(PERSISTENCE_ID, 1);
      expect(journalled.some((entry) => entry.event.event.n === 1_111)).toBe(false);
    } finally {
      await stopReplica(replica);
    }
  }, 20_000);

  test('an envelope that did not come in on the topic is refused for want of an origin', async () => {
    const peer = 'authorship-peer@h:70697';
    const replica = await startReplica('authorship-offtopic', 70_612);
    try {
      // One envelope, two routes. Only the difference in route may decide it.
      const envelope = envelopeFrom(peer, 3_333, 1);
      deliverOffTopic(replica, envelope);
      await drainWithSentinel(replica, 5);

      expect(
        replica.instance.applied,
        'the pub-sub-free route through Cluster.dispatchEnvelope still absorbs a peer envelope',
      ).not.toContain(3_333);
      const refusals = warningsMatching(replica, 'no authenticated origin');
      expect(refusals.length).toBe(1);

      deliverOnTopic(replica, envelope, peer);
      await drainWithSentinel(replica, 6);
      expect(
        replica.instance.applied,
        'the very same envelope was refused on the topic too, so the route is not what decided it',
      ).toContain(3_333);
    } finally {
      await stopReplica(replica);
    }
  }, 20_000);
});

describe('replicated envelope authorship — a replica id that is not a node address (#706)', () => {
  test('the default check refuses a region name, and the documented override maps it to its node', async () => {
    const usEastNode = 'authorship-region@h:70696';
    const otherNode = 'authorship-region@h:70695';

    RegionCounter.mapRegions = false;
    RegionCounter.nodesByRegion = {};
    const strict = await startReplica('authorship-region', 70_621, [], () => new RegionCounter());
    try {
      // No mapping in place: a region name is not the sending node's address,
      // so the default equality refuses it. That refusal is the reason the
      // hook exists — not a bug to work around by loosening it.
      deliverOnTopic(strict, envelopeFrom('us-east', 4_444, 1), usEastNode);
      await drainWithSentinel(strict, 5);
      expect(strict.instance.applied).not.toContain(4_444);
      expect(warningsMatching(strict, 'may not be written by').length).toBe(1);
    } finally {
      await stopReplica(strict);
    }

    RegionCounter.mapRegions = true;
    RegionCounter.nodesByRegion = { 'us-east': usEastNode, 'eu-west': 'authorship-region@h:70622' };
    const mapped = await startReplica('authorship-region', 70_622, [], () => new RegionCounter());
    try {
      deliverOnTopic(mapped, envelopeFrom('us-east', 5_555, 1), usEastNode);
      deliverOnTopic(mapped, envelopeFrom('us-east', 6_666, 2), otherNode);
      await drainWithSentinel(mapped, 5);

      expect(
        mapped.instance.applied,
        'the mapped node was refused, so the override cannot express a region deployment',
      ).toContain(5_555);
      expect(
        mapped.instance.applied,
        'any node could write as us-east — the mapping is not being consulted',
      ).not.toContain(6_666);
      expect(warningsMatching(mapped, 'may not be written by').length).toBe(1);
    } finally {
      RegionCounter.mapRegions = true;
      RegionCounter.nodesByRegion = {};
      await stopReplica(mapped);
    }
  }, 30_000);
});
