/**
 * A leave hands a node's shards off before its peers re-home them (#1465).
 *
 * `Cluster.leave()` used to broadcast the leave and stop the transport, and
 * nothing else: the regions, their entities and the coordinators the node had
 * started kept running.  What that did to a shard the node hosted depends on
 * which node leaves, so both are here:
 *
 * - **A member leaves.**  The leader removes it on the broadcast, its
 *   coordinator re-homes the shards, and the next message for an entity
 *   starts it on the leader — beside the instance still alive on the node that
 *   had left.  For a persistent entity that is a second writer.
 * - **The leader leaves.**  Its own view moves the leadership on before the
 *   broadcast goes out, so its still-running region registers its shards with
 *   the new leader's coordinator — which then homes them on a node that has
 *   left, and every message for them is lost.
 *
 * The fixture makes the window impossible to miss rather than likely to be
 * hit: the entity on the leaving node is in the middle of a journal write when
 * the leave begins, and the write is held until the leave is visibly under way
 * — the leaving region has begun to stop, or the peer has already heard of the
 * leave.  Whichever comes first releases it, so each case waits on an event in
 * every version of `leave()`, never on a delay.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { MemberRemoved } from '../../../../../src/cluster/ClusterEvents.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { LocalActorRef } from '../../../../../src/internal/LocalActorRef.js';
import { LogLevel, NoopLogger, type Logger } from '../../../../../src/Logger.js';
import type { Journal } from '../../../../../src/persistence/Journal.js';
import type { JournalEntry, PersistentEvent } from '../../../../../src/persistence/JournalTypes.js';
import {
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
  PersistentActor,
} from '../../../../../src/persistence/index.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';
import { RecordingLogger } from '../../../../util/RecordingLogger.js';
import { coordinatorSegments, regionSegments } from '../../../../util/SystemPaths.js';

const SYSTEM_NAME = 'leave-hand-off';
const TYPE_NAME = 'orders';
/** Hashes to shard 5 of 8 — odd, so with two regions the second address hosts it. */
const ENTITY_ID = 'order-1';

type PlaceCommand = { readonly kind: 'place'; readonly id: string; readonly note: string };

type Command = PlaceCommand;

type PlacedEvent = { readonly kind: 'placed'; readonly note: string };

type Event = PlacedEvent;

type State = { readonly placed: number };

/**
 * Everything both nodes did, in the order it happened: `started <node> <id>`
 * once an entity has recovered, `stopped <node> <id>`, and
 * `<node> saw <node> removed`.
 */
const timeline: string[] = [];

/** Which node an entity runs on, by the system it was created in. */
const nodeNames = new Map<ActorSystem, string>();

/** Entities live right now, per id, and the most that ever were at once. */
const live = new Map<string, number>();
let mostLiveAtOnce = 0;

/** The state each node's entity recovered to, by node. */
const recoveredPlaced = new Map<string, number>();

class Order extends PersistentActor<Command, Event, State> {
  override get persistenceId(): string { return `${TYPE_NAME}-${this.entityId}`; }

  initialState(): State { return { placed: 0 }; }

  onEvent(state: State): State { return { placed: state.placed + 1 }; }

  onCommand(_state: State, command: Command): Promise<void> {
    return match(command)
      .with({ kind: 'place' }, (c) => this.onPlace(c))
      .exhaustive();
  }

  override onRecoveryComplete(state: State): void {
    const node = this.nodeName();
    recoveredPlaced.set(node, state.placed);
    const count = (live.get(this.entityId) ?? 0) + 1;
    live.set(this.entityId, count);
    mostLiveAtOnce = Math.max(mostLiveAtOnce, count);
    timeline.push(`started ${node} ${this.entityId}`);
  }

  override async postStop(): Promise<void> {
    live.set(this.entityId, (live.get(this.entityId) ?? 1) - 1);
    timeline.push(`stopped ${this.nodeName()} ${this.entityId}`);
    await super.postStop();
  }

  private async onPlace(command: PlaceCommand): Promise<void> {
    await this.persist({ kind: 'placed', note: command.note });
  }

  private nodeName(): string { return nodeNames.get(this.system) ?? 'unknown'; }
}

/**
 * One journal both nodes write to, as a shared store would be — and whose
 * appends can be held open, the way a slow store holds them.
 */
class HoldableJournal implements Journal {
  private readonly inner = new InMemoryJournal();
  private holding = false;
  private readonly held: Array<() => void> = [];

  /** Appends waiting to be let through. */
  get heldAppends(): number { return this.held.length; }

  hold(): void { this.holding = true; }

  release(): void {
    this.holding = false;
    for (const resume of this.held.splice(0)) resume();
  }

  async append<E = unknown>(
    persistenceId: string,
    entries: ReadonlyArray<JournalEntry<E>>,
    expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> {
    if (this.holding) await new Promise<void>((resume) => { this.held.push(resume); });
    return this.inner.append(persistenceId, entries, expectedSeq);
  }

  read<E = unknown>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    return this.inner.read<E>(persistenceId, fromSeq, toSeq);
  }

  highestSeq(persistenceId: string): Promise<number> { return this.inner.highestSeq(persistenceId); }

  delete(persistenceId: string, toSeq: number): Promise<void> { return this.inner.delete(persistenceId, toSeq); }

  persistenceIds(): Promise<string[]> { return this.inner.persistenceIds(); }
}

type Node = {
  readonly name: string;
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly region: ActorRef<Command>;
};

const running: Node[] = [];
let journal = new HoldableJournal();

afterEach(async () => {
  journal.release();
  for (const node of running.splice(0)) {
    await node.cluster.leave().catch(() => { /* teardown is best-effort */ });
    await node.system.terminate().catch(() => { /* teardown is best-effort */ });
  }
  timeline.length = 0;
  nodeNames.clear();
  live.clear();
  mostLiveAtOnce = 0;
  recoveredPlaced.clear();
  journal = new HoldableJournal();
});

/** What a case varies about a node; everything else is the same on both. */
type NodeSettings = {
  readonly handOffTimeoutMs?: number;
  readonly rememberEntities?: boolean;
  readonly logger?: Logger;
};

async function startNode(name: string, port: number, seeds: string[], settings: NodeSettings): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(settings.logger ?? new NoopLogger())
    .withLogLevel(settings.logger === undefined ? LogLevel.Off : LogLevel.Warn);
  const system = ActorSystem.create(SYSTEM_NAME, systemOptions);
  nodeNames.set(system, name);
  system.extension(PersistenceExtensionId).configure({ journal, snapshotStore: new InMemorySnapshotStore() });
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(new NodeAddress(SYSTEM_NAME, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Order)
    .withExtractEntityId((message) => message.id)
    .withNumShards(8)
    .withPassivationIdleMs(0)
    .withRememberEntities(settings.rememberEntities ?? false);
  if (settings.handOffTimeoutMs !== undefined) shardingOptions.withHandOffTimeoutMs(settings.handOffTimeoutMs);
  const region = cluster.sharding.start<Command>(shardingOptions);
  const node = { name, system, cluster, region };
  running.push(node);
  return node;
}

/** A, the founder and so the leader. */
async function founder(port: number, settings: NodeSettings = {}): Promise<Node> {
  const nodeA = await startNode('A', port, [], settings);
  await awaitCondition(() => nodeA.cluster.upMembers().length === 1, {
    timeoutMs: 4_000,
    label: 'A founded the cluster',
  });
  return nodeA;
}

/** B, joining the founder on `founderPort`. */
function member(port: number, founderPort: number, settings: NodeSettings = {}): Promise<Node> {
  return startNode('B', port, [`${SYSTEM_NAME}@h:${founderPort}`], settings);
}

async function bothUpAndRegistered(nodes: ReadonlyArray<Node>): Promise<void> {
  await awaitCondition(() => nodes.every((node) => node.cluster.upMembers().length === nodes.length), {
    timeoutMs: 4_000,
    label: 'both nodes are up in one cluster',
  });
  await awaitCondition(() => nodes.every((node) => node.cluster.sharding.isRegistered(TYPE_NAME)), {
    timeoutMs: 4_000,
    label: 'both regions are registered with the coordinator',
  });
}

function place(note: string): PlaceCommand {
  return { kind: 'place', id: ENTITY_ID, note };
}

async function firstWriteLanded(): Promise<void> {
  await awaitCondition(async () => (await journal.highestSeq(`${TYPE_NAME}-${ENTITY_ID}`)) === 1, {
    timeoutMs: 4_000,
    label: 'the entity wrote its first event',
  });
}

/** Whether `node`'s region for the type has begun to stop. */
function regionStopping(node: Node): boolean {
  return node.system._resolvePath(regionSegments(SYSTEM_NAME, TYPE_NAME))
    .exists((region) => region instanceof LocalActorRef && region.getCell().isStopping());
}

/**
 * `leaving` leaves while the entity it hosts is mid-write; then `staying` is
 * sent traffic for that entity until it runs there.  Asserts the hand-off:
 * one live home throughout, the leave heard only once the entity had
 * stopped, and the new home starting from the write that was in flight.
 */
async function leaveMidWriteAndRehome(leaving: Node, staying: Node): Promise<void> {
  const heard = `${staying.name} saw ${leaving.name} removed`;
  staying.cluster.subscribe((event) => {
    if (event instanceof MemberRemoved && event.member.address.equals(leaving.cluster.selfAddress)) {
      timeline.push(heard);
    }
  });

  journal.hold();
  leaving.region.tell(place(`written while ${leaving.name} leaves`));
  await awaitCondition(() => journal.heldAppends === 1, {
    timeoutMs: 4_000,
    label: `the entity on ${leaving.name} is mid-write`,
  });

  const left = leaving.cluster.leave();
  await awaitCondition(() => regionStopping(leaving) || timeline.includes(heard), {
    timeoutMs: 4_000,
    label: `${leaving.name}'s region began to stop, or ${staying.name} heard of the leave`,
  });
  journal.release();

  // Every message before the entity runs on `staying` may still land on the
  // leaving region and be lost; the case is about where the entity runs.
  const startedOnStaying = `started ${staying.name} ${ENTITY_ID}`;
  await awaitCondition(() => {
    if (!timeline.includes(startedOnStaying)) staying.region.tell(place(`through ${staying.name}`));
    return timeline.includes(startedOnStaying);
  }, { timeoutMs: 4_000, label: `the entity runs on ${staying.name}` });
  await left;

  expect(mostLiveAtOnce).toBe(1);
  const stoppedOnLeaving = timeline.indexOf(`stopped ${leaving.name} ${ENTITY_ID}`);
  expect(stoppedOnLeaving).toBeGreaterThan(-1);
  expect(stoppedOnLeaving).toBeLessThan(timeline.indexOf(heard));
  expect(stoppedOnLeaving).toBeLessThan(timeline.indexOf(startedOnStaying));
  // The write in flight when the leave began landed, and the new home
  // started from it rather than from the state before it.
  expect(recoveredPlaced.get(staying.name)).toBe(2);
  expect(leaving.system._resolvePath(regionSegments(SYSTEM_NAME, TYPE_NAME)).isNone()).toBe(true);
  expect(leaving.system._resolvePath(coordinatorSegments(SYSTEM_NAME, TYPE_NAME)).isNone()).toBe(true);
}

describe('a leave hands the shards off before the peers re-home them (#1465)', () => {
  test('a member that leaves: its entity stops, its write lands, before the leader runs it', async () => {
    const nodeA = await founder(62_442);
    const nodeB = await member(62_443, 62_442);
    await bothUpAndRegistered([nodeA, nodeB]);
    // Placed with both regions registered, so the hash puts it on B.
    nodeA.region.tell(place('first'));
    await firstWriteLanded();
    expect(timeline).toEqual([`started B ${ENTITY_ID}`]);

    await leaveMidWriteAndRehome(nodeB, nodeA);
  }, 20_000);

  test('the leader that leaves: its entity stops, its write lands, before the new leader runs it', async () => {
    const nodeA = await founder(62_440);
    // Placed while A's region is the only one, so A — the leader — hosts it.
    nodeA.region.tell(place('first'));
    await firstWriteLanded();
    expect(timeline).toEqual([`started A ${ENTITY_ID}`]);
    const nodeB = await member(62_441, 62_440);
    await bothUpAndRegistered([nodeA, nodeB]);

    await leaveMidWriteAndRehome(nodeA, nodeB);
  }, 20_000);

  test('with remember-entities, the leader that leaves has its entity restarted on the member unasked', async () => {
    // Regions stop before the coordinator, so the coordinator still active on
    // the leaving leader hears its own region go, re-homes the shard on B and
    // ships it the remembered entity — no message for it is sent after the
    // leave, and a coordinator stopped first would have re-homed nothing.
    const remembering: NodeSettings = { rememberEntities: true };
    const nodeA = await founder(62_444, remembering);
    nodeA.region.tell(place('first'));
    await firstWriteLanded();
    expect(timeline).toEqual([`started A ${ENTITY_ID}`]);
    const nodeB = await member(62_445, 62_444, remembering);
    await bothUpAndRegistered([nodeA, nodeB]);

    await nodeA.cluster.leave();

    await awaitCondition(() => timeline.includes(`started B ${ENTITY_ID}`), {
      timeoutMs: 4_000,
      label: 'the remembered entity restarted on B without being sent anything',
    });
    expect(mostLiveAtOnce).toBe(1);
    expect(timeline.indexOf(`stopped A ${ENTITY_ID}`)).toBeLessThan(timeline.indexOf(`started B ${ENTITY_ID}`));
    expect(recoveredPlaced.get('B')).toBe(1);
  }, 20_000);

  test("a hand-off that cannot finish is cut short at the type's hand-off timeout, and the leave goes on", async () => {
    // The type's own bound, not the shipped ten seconds: with those the leave
    // would still be waiting when the wait below gives up.
    const logger = new RecordingLogger(LogLevel.Warn);
    const nodeA = await founder(62_446, { handOffTimeoutMs: 300, logger });
    nodeA.region.tell(place('first'));
    await firstWriteLanded();
    journal.hold();
    nodeA.region.tell(place('held for the whole leave'));
    await awaitCondition(() => journal.heldAppends === 1, {
      timeoutMs: 4_000,
      label: 'the entity on A is mid-write',
    });

    let settled = false;
    const left = nodeA.cluster.leave().then(() => { settled = true; });
    await awaitCondition(() => settled, {
      timeoutMs: 3_000,
      label: "the leave went on once the type's hand-off timeout ran out",
    });
    // It did not wait for the write, which is still held.
    expect(journal.heldAppends).toBe(1);
    expect(logger.records.some((record) => record.level === 'warn'
      && record.message.includes(`the region for '${TYPE_NAME}' did not stop within its hand-off timeout of 300 ms`)))
      .toBe(true);
    journal.release();
    await left;
  }, 20_000);
});
