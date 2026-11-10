/**
 * A replica's `seqAtReplica` continues across a restart (found while #1497).
 *
 * `_localSeq` — the counter `persist` mints `seqAtReplica` from — was restored
 * from a snapshot and from nowhere else.  A restart with no snapshot started
 * it at 0 again and minted `1` a second time; a restart from a snapshot with
 * one of the replica's own events in the journal after it re-minted that
 * event's number.  `ReplicatedSnapshot.localSeq` exists precisely so a restart
 * does not issue a number already written, and `snapshot-is-optional`'s
 * fallback — a full replay with no snapshot at all — is exactly the first
 * route.
 *
 * The envelope documents the number as monotonic within a replica, and it is
 * the last tie-break of the canonical order; a re-issued one breaks the first
 * promise and leaves the second with two events it cannot tell apart.
 *
 * Only this replica's own events count: a peer's `seqAtReplica` is that peer's
 * counter and says nothing about this one.
 */
import { describe, expect, test } from 'bun:test';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { gracefulStop } from '../../../../../src/pattern/GracefulStop.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { PersistenceExtensionId } from '../../../../../src/persistence/PersistenceExtension.js';
import { everyNEvents, type SnapshotPolicy } from '../../../../../src/persistence/PersistentActor.js';
import type { ReplicatedSnapshot } from '../../../../../src/persistence/replicated/ReplicatedSnapshot.js';
import {
  ReplicatedEventSourcedActor,
  type ReplicatedEventEnvelope,
} from '../../../../../src/persistence/ReplicatedEventSourcedActor.js';
import { InMemorySnapshotStore } from '../../../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import { assertCompletesWithin } from '../../../../util/AsyncAssertions.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

type AddCommand = { readonly kind: 'add'; readonly amount: number };
type Command = AddCommand;

type AddedEvent = { readonly kind: 'added'; readonly amount: number };
type Event = AddedEvent;

type State = { readonly value: number };

const WAIT = { timeoutMs: 3_000, intervalMs: 5 } as const;

/** Bounds a teardown step, so a wedged actor fails the test rather than the runner. */
const TEARDOWN_BUDGET_MS = 2_000;

type Observations = {
  readonly persisted: number[];
  readonly recovered: State[];
};

class Counter extends ReplicatedEventSourcedActor<Command, Event, State> {
  readonly persistenceId: string;

  constructor(
    persistenceId: string,
    private readonly observations: Observations,
    private readonly policy: SnapshotPolicy<State, Event>,
  ) {
    super();
    this.persistenceId = persistenceId;
  }

  initialState(): State { return { value: 0 }; }

  onEvent(state: State, event: Event): State { return { value: state.value + event.amount }; }

  protected override snapshotPolicy(): SnapshotPolicy<State, Event> { return this.policy; }

  override onRecoveryComplete(state: State): void { this.observations.recovered.push(state); }

  async onCommand(_state: State, command: Command): Promise<void> {
    await this.persist({ kind: 'added', amount: command.amount });
    this.observations.persisted.push(command.amount);
  }
}

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly journal: InMemoryJournal;
  readonly snapshots: InMemorySnapshotStore;
  /** This node's replica id — the default, its cluster address. */
  readonly replicaId: string;
};

async function startNode(name: string, port: number): Promise<Node> {
  const system = ActorSystem.create(name, ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off));
  const journal = new InMemoryJournal();
  const snapshots = new InMemorySnapshotStore();
  system.extension(PersistenceExtensionId).configure({ journal, snapshotStore: snapshots });
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster, journal, snapshots, replicaId: cluster.selfAddress.toString() };
}

async function stopNode(node: Node): Promise<void> {
  await assertCompletesWithin(node.cluster.leave(), TEARDOWN_BUDGET_MS, `${node.system.name}: cluster.leave() settled`);
  await assertCompletesWithin(node.system.terminate(), TEARDOWN_BUDGET_MS, `${node.system.name}: system.terminate() settled`);
}

/** Spawn a replica and wait for its recovery, so the next command meets a recovered actor. */
async function spawnRecovered(
  node: Node,
  persistenceId: string,
  observations: Observations,
  policy: SnapshotPolicy<State, Event>,
  actorName: string,
): Promise<ActorRef<Command | ReplicatedEventEnvelope<Event>>> {
  const before = observations.recovered.length;
  const ref = node.system.spawn(() => new Counter(persistenceId, observations, policy), actorName);
  await awaitCondition(() => observations.recovered.length === before + 1, { ...WAIT, label: `${actorName} recovered` });
  return ref;
}

/** Persist each amount in turn and wait until the last one has been written. */
async function persistAll(
  ref: ActorRef<Command | ReplicatedEventEnvelope<Event>>,
  observations: Observations,
  amounts: ReadonlyArray<number>,
): Promise<void> {
  for (const amount of amounts) ref.tell({ kind: 'add', amount });
  const last = amounts[amounts.length - 1]!;
  await awaitCondition(() => observations.persisted.includes(last), { ...WAIT, label: `add(${last}) was persisted` });
}

/** This replica's own envelopes, in journal order. */
async function ownEnvelopes(node: Node, persistenceId: string): Promise<ReplicatedEventEnvelope<Event>[]> {
  const events = await node.journal.read<ReplicatedEventEnvelope<Event>>(persistenceId, 1);
  return events.map((e) => e.event).filter((e) => e.replica === node.replicaId);
}

const NEVER: SnapshotPolicy<State, Event> = () => false;

describe('ReplicatedEventSourcedActor — seqAtReplica continues across a restart (found while #1497)', () => {
  test('without a snapshot: the full replay restores the counter from this replica\'s own events', async () => {
    const node = await startNode('local-sequence-replay', 83_301);
    try {
      // A peer's event with a far higher number of its own, ahead of ours: it
      // must not move this replica's counter.
      const peer = 'local-sequence-peer@h:83399';
      const peerEnvelope: ReplicatedEventEnvelope<Event> = {
        persistenceId: 'ls-replay',
        replica: peer,
        seqAtReplica: 50,
        eventId: `${peer}#${'50'.padStart(24, '0')}`,
        vc: { [peer]: 50 },
        timestamp: 1_700_000_000_000,
        event: { kind: 'added', amount: 100 },
      };
      await node.journal.append('ls-replay', [{ event: peerEnvelope, tags: ['replicated-es'] }], 0);

      const observations: Observations = { persisted: [], recovered: [] };
      const first = await spawnRecovered(node, 'ls-replay', observations, NEVER, 'first');
      await persistAll(first, observations, [1, 2, 3]);
      expect(await gracefulStop(first, TEARDOWN_BUDGET_MS)).toBe(true);

      const second = await spawnRecovered(node, 'ls-replay', observations, NEVER, 'second');
      expect(observations.recovered[1]).toEqual({ value: 106 });
      await persistAll(second, observations, [4]);

      const own = await ownEnvelopes(node, 'ls-replay');
      expect(own.map((e) => e.event.amount)).toEqual([1, 2, 3, 4]);
      expect(own.map((e) => e.seqAtReplica)).toEqual([1, 2, 3, 4]);
      expect(own.map((e) => e.vc[node.replicaId])).toEqual([1, 2, 3, 4]);
    } finally {
      await stopNode(node);
    }
  });

  test('from a snapshot: an own event in the journal after it is not re-numbered', async () => {
    const node = await startNode('local-sequence-snapshot', 83_302);
    try {
      const observations: Observations = { persisted: [], recovered: [] };
      // Snapshot after the second event, so the third is in the delta.
      const policy = everyNEvents<State, Event>(2);
      const first = await spawnRecovered(node, 'ls-snapshot', observations, policy, 'first');
      await persistAll(first, observations, [1, 2, 3]);
      await awaitCondition(async () => {
        const stored = (await node.snapshots.loadLatest<ReplicatedSnapshot<Event, State>>('ls-snapshot')).toNullable();
        return stored !== null && stored.state.journalSeqAtSnapshot === 2 && stored.state.localSeq === 2;
      }, { ...WAIT, label: 'the snapshot after the second event was written' });
      expect(await gracefulStop(first, TEARDOWN_BUDGET_MS)).toBe(true);

      const second = await spawnRecovered(node, 'ls-snapshot', observations, policy, 'second');
      expect(observations.recovered[1]).toEqual({ value: 6 });
      await persistAll(second, observations, [4]);

      const own = await ownEnvelopes(node, 'ls-snapshot');
      expect(own.map((e) => e.event.amount)).toEqual([1, 2, 3, 4]);
      expect(own.map((e) => e.seqAtReplica)).toEqual([1, 2, 3, 4]);
    } finally {
      await stopNode(node);
    }
  });
});
