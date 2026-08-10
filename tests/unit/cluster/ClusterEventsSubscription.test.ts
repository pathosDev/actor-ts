/**
 * #161 — what a subscriber is told about the cluster it just attached to, and
 * what it is told about reachability afterwards.
 *
 * Two halves, and the first one is a correctness fix rather than a feature.
 * The replay iterated the raw member map and stopped after `up`, so a late
 * subscriber was told that a day-old tombstone had just joined and that an
 * unreachable peer was merely `joined` — the two states it most needs to know
 * about, reported as the most benign one.  `'snapshot'` mode is the new form
 * on top of that.
 *
 * The second half is `ReachabilityChanged`, which exists because neither
 * existing event answers *"what can this node see"*: `MemberUnreachable` may be
 * a peer's observation arriving in gossip, and it is only ever emitted for a
 * member that was `up`.
 *
 * The tests drive the merge and the detector tick directly instead of running
 * timers.  Reachability is a function of elapsed silence, so it is produced by
 * back-dating the detector's sample — waiting for a threshold would buy
 * nondeterminism and nothing else.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster, type ClusterSubscriptionReplayMode } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import {
  CurrentClusterState,
  MemberJoined,
  MemberUnreachable,
  ReachabilityChanged,
  type ClusterEvent,
} from '../../../src/cluster/ClusterEvents.js';
import type { FailureDetector } from '../../../src/cluster/FailureDetector.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberData, MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';

const SELF_HOST = '10.0.161.1';
const PEER_HOST = '10.0.161.2';

/** Comfortably past `unreachableAfterMs` (2 s) and short of `downAfterMs` (5 s). */
const SILENT_BUT_NOT_DOWN_MS = 3_000;
/** Past `downAfterMs`, so the detector calls the peer gone. */
const SILENT_PAST_DOWN_MS = 6_000;

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
};

/** The private surface these tests drive — merge and detector ticks, by design. */
interface ClusterInternals {
  mergeMember(from: NodeAddress, senderStatus: MemberStatus | undefined, data: MemberData): void;
  failureDetectionTick(): void;
  readonly failureDetector: FailureDetector;
  readonly members: Map<string, Member>;
  readonly reachability: Map<string, boolean>;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

/**
 * A one-node cluster with every periodic task pushed past the test's lifetime.
 * With no seeds the node elects itself `up`, so it starts as a cluster of one
 * that is also its own leader.  The two thresholds keep their defaults — the
 * detector is driven by back-dating its sample, not by waiting for them.
 */
async function startNode(systemName: string, port: number): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, SELF_HOST, port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withFailureDetector({
      heartbeatIntervalMs: 60_000,
      unreachableAfterMs: 2_000,
      downAfterMs: 5_000,
    })
    .withGossipIntervalMs(60_000)
    .withTombstonePruneIntervalMs(60_000);
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster, address };
}

const peerAddress = (systemName: string, port: number): NodeAddress =>
  new NodeAddress(systemName, PEER_HOST, port);

/**
 * Merge a peer's own record, as its gossip would carry it.  `from` is the peer
 * itself, which is the one claim `maySpeakFor` always admits — otherwise no
 * node could ever join.
 */
function gossipSelfRecord(
  cluster: Cluster,
  peer: NodeAddress,
  status: MemberStatus,
  version: number = Date.now(),
): void {
  const data: MemberData = { address: peer.toJSON(), status, version, roles: [] };
  internals(cluster).mergeMember(
    peer,
    'up',
    status === 'removed' ? { ...data, removedAt: Date.now() } : data,
  );
}

/** Pretend the last thing heard from `peer` arrived `agoMs` ago. */
function lastHeardFrom(cluster: Cluster, peer: NodeAddress, agoMs: number): void {
  internals(cluster).failureDetector.heartbeat(peer, Date.now() - agoMs);
}

function subscribeRecording(
  cluster: Cluster,
  replayMode?: ClusterSubscriptionReplayMode,
): { readonly seen: ClusterEvent[]; readonly unsubscribe: () => void } {
  const seen: ClusterEvent[] = [];
  const unsubscribe = cluster.subscribe(
    (event) => { seen.push(event); },
    replayMode === undefined ? undefined : { replayMode },
  );
  return { seen, unsubscribe };
}

const names = (events: ReadonlyArray<ClusterEvent>): ReadonlyArray<string> =>
  events.map((event) => event.constructor.name);

const subjectsOf = <T extends ClusterEvent>(
  events: ReadonlyArray<ClusterEvent>,
  kind: new (...args: never[]) => T,
): ReadonlyArray<string> =>
  events
    .filter((event): event is T => event instanceof kind)
    .map((event) => (event as unknown as { member: Member }).member.address.toString());

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

describe('the replay a subscriber gets on attach (#161)', () => {
  test('every member arrives as MemberJoined plus the status event it has reached', async () => {
    const node = await startNode('replay-events', 9_301);
    nodes.push(node);
    const upPeer = peerAddress('replay-events', 9_391);
    const joiningPeer = peerAddress('replay-events', 9_392);
    gossipSelfRecord(node.cluster, upPeer, 'up');
    gossipSelfRecord(node.cluster, joiningPeer, 'joining');

    const { seen } = subscribeRecording(node.cluster);

    // Address order, so the sequence is the same on every run: self sorts
    // below both peers (…161.1 < …161.2), and 9391 below 9392.
    expect(names(seen)).toEqual([
      'MemberJoined', 'MemberUp', 'SelfUp',
      'MemberJoined', 'MemberUp',
      'MemberJoined',
      'LeaderChanged',
    ]);
  });

  test('a tombstone is not replayed as a member that just joined', async () => {
    // The map keeps `removed` entries for up to `tombstoneTtlMs` — a day, by
    // default — precisely so stale gossip cannot resurrect the address.  The
    // replay walked that map, so for a day afterwards every new subscriber was
    // told the departed node had just joined.
    const node = await startNode('replay-tombstone', 9_302);
    nodes.push(node);
    const departed = peerAddress('replay-tombstone', 9_393);
    gossipSelfRecord(node.cluster, departed, 'removed');
    expect(internals(node.cluster).members.get(departed.toString())?.status).toBe('removed');

    const { seen } = subscribeRecording(node.cluster);

    expect(subjectsOf(seen, MemberJoined)).toEqual([node.address.toString()]);
    expect(names(seen)).not.toContain('MemberRemoved');
  });

  test('an unreachable member is replayed as unreachable, not merely joined', async () => {
    const node = await startNode('replay-unreachable', 9_303);
    nodes.push(node);
    const lost = peerAddress('replay-unreachable', 9_394);
    gossipSelfRecord(node.cluster, lost, 'unreachable');

    const { seen } = subscribeRecording(node.cluster);

    expect(subjectsOf(seen, MemberUnreachable)).toEqual([lost.toString()]);
  });

  test('snapshot mode replaces the whole burst with one CurrentClusterState', async () => {
    const node = await startNode('replay-snapshot', 9_304);
    nodes.push(node);
    const upPeer = peerAddress('replay-snapshot', 9_395);
    const lostPeer = peerAddress('replay-snapshot', 9_396);
    const departed = peerAddress('replay-snapshot', 9_397);
    gossipSelfRecord(node.cluster, upPeer, 'up');
    gossipSelfRecord(node.cluster, lostPeer, 'unreachable');
    gossipSelfRecord(node.cluster, departed, 'removed');

    const { seen } = subscribeRecording(node.cluster, 'snapshot');

    expect(seen.length).toBe(1);
    const state = seen[0];
    expect(state).toBeInstanceOf(CurrentClusterState);
    const snapshot = state as CurrentClusterState;
    // The tombstone is absent here for the same reason it is absent from the
    // event replay, and `unreachable` is a subset of `members` rather than a
    // set beside it — an unreachable peer is still a member.
    expect(snapshot.members.map((member) => member.address.toString())).toEqual([
      node.address.toString(), upPeer.toString(), lostPeer.toString(),
    ]);
    expect(snapshot.unreachable.map((member) => member.address.toString()))
      .toEqual([lostPeer.toString()]);
    expect(snapshot.leader.toNullable()?.address.toString()).toBe(node.address.toString());
  });

  test('each subscriber gets its own replay, and both then see the live stream', async () => {
    const node = await startNode('replay-multi', 9_305);
    nodes.push(node);

    const first = subscribeRecording(node.cluster);
    const second = subscribeRecording(node.cluster, 'snapshot');
    expect(names(first.seen)).toEqual(['MemberJoined', 'MemberUp', 'SelfUp', 'LeaderChanged']);
    expect(names(second.seen)).toEqual(['CurrentClusterState']);

    gossipSelfRecord(node.cluster, peerAddress('replay-multi', 9_398), 'up');

    // The replay is per-subscriber, the live stream is broadcast — a mode
    // chosen by one listener must not change what the other is sent.
    expect(names(first.seen).slice(4)).toEqual(['MemberJoined', 'MemberUp']);
    expect(names(second.seen).slice(1)).toEqual(['MemberJoined', 'MemberUp']);
  });

  test('an unsubscribed listener stops receiving', async () => {
    const node = await startNode('replay-unsubscribe', 9_306);
    nodes.push(node);
    const { seen, unsubscribe } = subscribeRecording(node.cluster, 'snapshot');
    seen.length = 0;

    unsubscribe();
    gossipSelfRecord(node.cluster, peerAddress('replay-unsubscribe', 9_399), 'up');

    expect(seen).toEqual([]);
  });
});

describe('ReachabilityChanged — this node\'s own detector (#161)', () => {
  const reachabilityIn = (events: ReadonlyArray<ClusterEvent>): ReadonlyArray<string> =>
    events
      .filter((event): event is ReachabilityChanged => event instanceof ReachabilityChanged)
      .map((event) => `${event.address}:${event.reachable}`);

  test('fires when the detector stops seeing a peer, and again when it recovers', async () => {
    const node = await startNode('reachability-flap', 9_311);
    nodes.push(node);
    const peer = peerAddress('reachability-flap', 9_391);
    gossipSelfRecord(node.cluster, peer, 'up');
    const { seen } = subscribeRecording(node.cluster, 'snapshot');
    seen.length = 0;

    lastHeardFrom(node.cluster, peer, SILENT_BUT_NOT_DOWN_MS);
    internals(node.cluster).failureDetectionTick();
    expect(reachabilityIn(seen)).toEqual([`${peer}:false`]);

    internals(node.cluster).failureDetector.heartbeat(peer);
    internals(node.cluster).failureDetectionTick();
    expect(reachabilityIn(seen)).toEqual([`${peer}:false`, `${peer}:true`]);
  });

  test('fires for a peer whose member status never moves, where MemberUnreachable fires for nothing', async () => {
    // The gap that motivates the event.  `MemberUnreachable` is only emitted
    // for a member that was `up`, so a peer that falls silent while `joining`
    // produces no reachability signal at all until the eviction cascade — by
    // which point it is not a warning, it is a report.
    const node = await startNode('reachability-joining', 9_312);
    nodes.push(node);
    const peer = peerAddress('reachability-joining', 9_392);
    gossipSelfRecord(node.cluster, peer, 'joining');
    const { seen } = subscribeRecording(node.cluster, 'snapshot');
    seen.length = 0;

    lastHeardFrom(node.cluster, peer, SILENT_BUT_NOT_DOWN_MS);
    internals(node.cluster).failureDetectionTick();

    expect(reachabilityIn(seen)).toEqual([`${peer}:false`]);
    expect(names(seen)).not.toContain('MemberUnreachable');
    expect(internals(node.cluster).members.get(peer.toString())?.status).toBe('joining');
  });

  test('a peer that has only ever been healthy produces nothing', async () => {
    // Otherwise every tick would announce every member as still fine, and the
    // one transition that matters would be buried in it.
    const node = await startNode('reachability-quiet', 9_313);
    nodes.push(node);
    const peer = peerAddress('reachability-quiet', 9_393);
    gossipSelfRecord(node.cluster, peer, 'up');
    const { seen } = subscribeRecording(node.cluster, 'snapshot');
    seen.length = 0;

    internals(node.cluster).failureDetectionTick();
    internals(node.cluster).failureDetectionTick();

    expect(reachabilityIn(seen)).toEqual([]);
  });

  test('the verdict is dropped with the member, so a re-incarnation is not a recovery', async () => {
    // The detector's sample is forgotten when a peer is evicted, and `decide`
    // answers `'healthy'` for an address it has no sample for.  A verdict left
    // behind would turn the next node on that address into a peer that came
    // back — and it would be an entry the member-map caps never counted.
    const node = await startNode('reachability-reincarnation', 9_314);
    nodes.push(node);
    const peer = peerAddress('reachability-reincarnation', 9_394);
    gossipSelfRecord(node.cluster, peer, 'up');
    const { seen } = subscribeRecording(node.cluster, 'snapshot');
    seen.length = 0;

    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    internals(node.cluster).failureDetectionTick();
    expect(reachabilityIn(seen)).toEqual([`${peer}:false`]);
    expect(internals(node.cluster).members.has(peer.toString())).toBe(false);
    expect(internals(node.cluster).reachability.has(peer.toString())).toBe(false);

    seen.length = 0;
    gossipSelfRecord(node.cluster, peer, 'up', Date.now() + 1_000);
    internals(node.cluster).failureDetectionTick();

    expect(reachabilityIn(seen)).toEqual([]);
  });
});
