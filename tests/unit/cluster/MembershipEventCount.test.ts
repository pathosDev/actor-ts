/**
 * #1428 — how many times one membership transition is announced.
 *
 * `updateMember` announces every status change itself, through
 * `emitStatusTransition`, and four call sites emitted the same event again right
 * after it: the detector's `unreachable` arm, its no-provider `down` arm, a
 * downing decision being applied, and the operator's `down()`.  Each of those
 * transitions reached a subscriber twice, while the same transition learned
 * through gossip arrived once — so two nodes counted one cluster-wide fact
 * differently.  The second copies were not even faithful copies: the
 * `unreachable` one re-read the member map after the listeners had run, so a
 * listener that downed the peer was told once more that it was unreachable,
 * after it had been removed; and when the downed peer had been leading, the
 * second `MemberDown` arrived after the `LeaderChanged` that the first one
 * caused.
 *
 * Driven ticks, the seam `DowningHoldAnnouncement.test.ts` uses: the detector's
 * sample is back-dated and `failureDetectionTick` is called directly, so every
 * transcript below is exact — what arrived, how many times, and in which order.
 *
 * The detector's no-provider `down` arm removes a peer only under
 * `failure-detector.auto-down` since #1426 — by default it parks it — so the
 * cases that count that arm's announcements opt in.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import {
  MemberDown,
  MemberUnreachable,
  type ClusterEvent,
  type MemberReachable,
  type MemberUp,
} from '../../../src/cluster/ClusterEvents.js';
import type {
  DowningProvider,
  SplitBrainResolverOptionsType,
} from '../../../src/cluster/downing/index.js';
import type { FailureDetectorLike } from '../../../src/cluster/FailureDetector.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { HeartbeatMessage, MemberData, MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const SELF_HOST = '10.0.142.5';
/** Sorts after self, so self stays the leader and no `LeaderChanged` joins the transcript. */
const FOLLOWER_HOST = '10.0.142.9';
/** Sorts before self, so this peer leads for as long as it is `up`. */
const LEADER_HOST = '10.0.142.1';

/** Past `unreachableAfterMs` (2 s), short of `downAfterMs` (5 s). */
const SILENT_BUT_NOT_DOWN_MS = 3_000;
/** Past `downAfterMs`, so the next tick's verdict is `down`. */
const SILENT_PAST_DOWN_MS = 6_000;

/**
 * The window in front of the resolver (#839), at its floor.  The decision path
 * is the subject here, not when the resolver is first asked — `0` is refused by
 * `SplitBrainResolverOptionsValidator`, so 1 ms is as close to "no window" as
 * the options go.
 */
const NO_STABILITY_WINDOW: Partial<SplitBrainResolverOptionsType> = { stableAfterMs: 1 };

/** A provider that downs whatever is unreachable — the decision path, with no strategy in the way. */
const DOWNS_THE_UNREACHABLE: DowningProvider = { decide: (view) => new Set(view.unreachable) };

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
};

/** The private surface these tests drive — the merge, the detector and the heartbeat, by design. */
interface ClusterInternals {
  mergeMember(from: NodeAddress, senderStatus: MemberStatus | undefined, data: MemberData): void;
  failureDetectionTick(): void;
  onHeartbeat(from: NodeAddress, message: HeartbeatMessage): void;
  readonly failureDetector: FailureDetectorLike;
  readonly members: Map<string, Member>;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

/**
 * A one-node cluster with every periodic task pushed past the test's lifetime,
 * so the only tick that ever runs is the one a test calls.  With no seeds the
 * node elects itself `up`.
 */
async function startNode(
  systemName: string, port: number, downing?: DowningProvider, failureDetectorAutoDown = false,
): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, SELF_HOST, port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  let clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withFailureDetector({
      heartbeatIntervalMs: 60_000,
      unreachableAfterMs: 2_000,
      downAfterMs: 5_000,
    })
    .withFailureDetectorAutoDown(failureDetectorAutoDown)
    .withSplitBrainResolver(NO_STABILITY_WINDOW)
    .withGossipIntervalMs(60_000)
    .withPublishStatsIntervalMs(60_000)
    .withTombstonePruneIntervalMs(60_000);
  if (downing !== undefined) clusterOptions = clusterOptions.withDowning(downing);
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster };
}

/**
 * Merge a peer's own record at `status`, as its gossip would carry it.  The
 * peer speaking for itself is the one claim `maySpeakFor` always admits, and an
 * explicit version keeps the order of the merges the order of the test.
 */
function gossipPeer(cluster: Cluster, peer: NodeAddress, status: MemberStatus, version: number): void {
  internals(cluster).mergeMember(peer, 'up', {
    address: peer.toJSON(), status, version, roles: [],
  });
}

/**
 * Pretend the last thing heard from `peer` arrived `agoMs` ago — any frame,
 * which is `heardFrom`: liveness, not a heartbeat's inter-arrival sample.
 */
function lastHeardFrom(cluster: Cluster, peer: NodeAddress, agoMs: number): void {
  internals(cluster).failureDetector.heardFrom(peer, Date.now() - agoMs);
}

function detectorTick(cluster: Cluster): void {
  internals(cluster).failureDetectionTick();
}

/**
 * Attach a listener that keeps every event, and drop its subscription replay —
 * `'snapshot'` mode, so the replay is one event to discard — so each entry is
 * one the test's own drive announced.
 */
function recordFrom(cluster: Cluster): ClusterEvent[] {
  const announced: ClusterEvent[] = [];
  cluster.subscribe((event) => { announced.push(event); }, { replayMode: 'snapshot' });
  announced.length = 0;
  return announced;
}

/** The event names in arrival order — compared whole, so a count and an order are one assertion. */
const namesOf = (events: ReadonlyArray<ClusterEvent>): ReadonlyArray<string> =>
  events.map((event) => event.constructor.name);

/** The statuses the `MemberUnreachable` announcements in a transcript carried. */
const unreachableStatusesOf = (events: ReadonlyArray<ClusterEvent>): ReadonlyArray<MemberStatus> =>
  events
    .filter((event): event is MemberUnreachable => event instanceof MemberUnreachable)
    .map((event) => event.member.status);

/** How often the two announcements #1428 is about arrived — the part a counting subscriber sees. */
const countsOf = (events: ReadonlyArray<ClusterEvent>): { readonly unreachable: number; readonly down: number } => ({
  unreachable: events.filter((event) => event instanceof MemberUnreachable).length,
  down: events.filter((event) => event instanceof MemberDown).length,
});

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

describe('one membership transition, one announcement (#1428)', () => {
  test('the detector with no provider and auto-down on: up → unreachable → down announces each step once', async () => {
    const node = await startNode('count-detector', 14_281, undefined, true);
    nodes.push(node);
    const peer = new NodeAddress('count-detector', FOLLOWER_HOST, 14_381);
    gossipPeer(node.cluster, peer, 'up', 1);
    const announced = recordFrom(node.cluster);

    lastHeardFrom(node.cluster, peer, SILENT_BUT_NOT_DOWN_MS);
    detectorTick(node.cluster);
    expect(namesOf(announced)).toEqual(['ReachabilityChanged', 'MemberUnreachable']);

    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    detectorTick(node.cluster);
    expect(namesOf(announced)).toEqual([
      'ReachabilityChanged', 'MemberUnreachable', 'MemberDown', 'MemberRemoved',
    ]);
    expect(internals(node.cluster).members.has(peer.toString())).toBe(false);
  });

  test('the detector with no provider and auto-down on: up → down in one round announces down once', async () => {
    const node = await startNode('count-detector-straight-down', 14_282, undefined, true);
    nodes.push(node);
    const peer = new NodeAddress('count-detector-straight-down', FOLLOWER_HOST, 14_382);
    gossipPeer(node.cluster, peer, 'up', 1);
    const announced = recordFrom(node.cluster);

    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    detectorTick(node.cluster);

    expect(namesOf(announced)).toEqual(['ReachabilityChanged', 'MemberDown', 'MemberRemoved']);
  });

  test('a downing decision announces down once', async () => {
    const node = await startNode('count-decision', 14_283, DOWNS_THE_UNREACHABLE);
    nodes.push(node);
    const peer = new NodeAddress('count-decision', FOLLOWER_HOST, 14_383);
    gossipPeer(node.cluster, peer, 'up', 1);
    const announced = recordFrom(node.cluster);

    lastHeardFrom(node.cluster, peer, SILENT_BUT_NOT_DOWN_MS);
    detectorTick(node.cluster);
    expect(namesOf(announced)).toEqual(['ReachabilityChanged', 'MemberUnreachable']);

    // The provider is asked only once the view has held still for the 1 ms
    // window, which is wall-clock — so keep ticking until it has answered.
    // The sample stays short of `down-after`, so every one of these ticks
    // leaves the peer where the first one put it.
    await awaitCondition(() => {
      detectorTick(node.cluster);
      return internals(node.cluster).members.get(peer.toString())?.status === 'removed';
    }, { label: 'the provider downed the unreachable peer' });

    expect(namesOf(announced)).toEqual([
      'ReachabilityChanged', 'MemberUnreachable', 'MemberDown', 'MemberRemoved',
    ]);
  });

  test('the operator’s down() announces down once', async () => {
    const node = await startNode('count-operator', 14_284);
    nodes.push(node);
    const peer = new NodeAddress('count-operator', FOLLOWER_HOST, 14_384);
    gossipPeer(node.cluster, peer, 'up', 1);
    const announced = recordFrom(node.cluster);

    expect(node.cluster.down(peer)).toBe(true);

    expect(namesOf(announced)).toEqual(['MemberDown', 'MemberRemoved']);
  });

  test('a listener that downs the peer on MemberUnreachable is not told again after the removal', async () => {
    // The re-read copy's own defect: it looked the member up again after the
    // listeners had run, and this listener had removed it by then — so it was
    // announced unreachable with status `removed`, after `MemberRemoved`.
    const node = await startNode('count-reentrant', 14_285);
    nodes.push(node);
    const peer = new NodeAddress('count-reentrant', FOLLOWER_HOST, 14_385);
    gossipPeer(node.cluster, peer, 'up', 1);
    // Attached first: a listener behind the one that downs is reached by the
    // nested `MemberDown` and `MemberRemoved` before the outer `MemberUnreachable`
    // gets to it, because dispatch is synchronous and depth-first.  That order is
    // a property of dispatch, not of how often a transition is announced.
    const announced = recordFrom(node.cluster);
    const seenByTheDowningListener: ClusterEvent[] = [];
    node.cluster.subscribe((event) => {
      seenByTheDowningListener.push(event);
      if (event instanceof MemberUnreachable) node.cluster.down(event.member.address);
    }, { replayMode: 'snapshot' });
    seenByTheDowningListener.length = 0;

    lastHeardFrom(node.cluster, peer, SILENT_BUT_NOT_DOWN_MS);
    detectorTick(node.cluster);

    const transcript = ['ReachabilityChanged', 'MemberUnreachable', 'MemberDown', 'MemberRemoved'];
    expect(namesOf(announced)).toEqual(transcript);
    expect(namesOf(seenByTheDowningListener)).toEqual(transcript);
    expect(unreachableStatusesOf(announced)).toEqual(['unreachable']);
    expect(unreachableStatusesOf(seenByTheDowningListener)).toEqual(['unreachable']);
  });

  test('a listener behind one that leaves on MemberUnreachable still hears it, once (#1294)', async () => {
    // While the detector announced twice, the second copy reached the listener
    // that #1294's skip had cost the first one — so the duplicate hid that bug
    // on exactly these paths, and removing it alone would have made such a
    // listener miss the event altogether.
    const node = await startNode('count-behind-a-leaver', 14_286);
    nodes.push(node);
    const peer = new NodeAddress('count-behind-a-leaver', FOLLOWER_HOST, 14_386);
    gossipPeer(node.cluster, peer, 'up', 1);
    let leave: (() => void) | null = null;
    leave = node.cluster.subscribe((event) => {
      if (event instanceof MemberUnreachable) leave?.();
    }, { replayMode: 'snapshot' });
    const announced = recordFrom(node.cluster);

    lastHeardFrom(node.cluster, peer, SILENT_BUT_NOT_DOWN_MS);
    detectorTick(node.cluster);

    expect(namesOf(announced)).toEqual(['ReachabilityChanged', 'MemberUnreachable']);
  });

  test('the detector announces a transition as often as gossip does', async () => {
    // One cluster-wide fact, two ways to learn it: the node that observes the
    // silence, and a node that hears about it.  A subscriber counting
    // transitions has to get the same number on both.
    const observing = await startNode('count-parity-observing', 14_287, undefined, true);
    const hearing = await startNode('count-parity-hearing', 14_288);
    nodes.push(observing, hearing);
    const peerOfObserving = new NodeAddress('count-parity-observing', FOLLOWER_HOST, 14_387);
    const peerOfHearing = new NodeAddress('count-parity-hearing', FOLLOWER_HOST, 14_388);
    gossipPeer(observing.cluster, peerOfObserving, 'up', 1);
    gossipPeer(hearing.cluster, peerOfHearing, 'up', 1);
    const observed = recordFrom(observing.cluster);
    const heard = recordFrom(hearing.cluster);

    lastHeardFrom(observing.cluster, peerOfObserving, SILENT_BUT_NOT_DOWN_MS);
    detectorTick(observing.cluster);
    lastHeardFrom(observing.cluster, peerOfObserving, SILENT_PAST_DOWN_MS);
    detectorTick(observing.cluster);
    gossipPeer(hearing.cluster, peerOfHearing, 'unreachable', 2);
    gossipPeer(hearing.cluster, peerOfHearing, 'down', 3);

    expect(countsOf(heard)).toEqual({ unreachable: 1, down: 1 });
    expect(countsOf(observed)).toEqual(countsOf(heard));
  });
});

describe('a downed leader: MemberDown is announced before LeaderChanged, and only then (#1428)', () => {
  test('the detector with no provider and auto-down on', async () => {
    const node = await startNode('count-leader-detector', 14_289, undefined, true);
    nodes.push(node);
    const leader = new NodeAddress('count-leader-detector', LEADER_HOST, 14_389);
    gossipPeer(node.cluster, leader, 'up', 1);
    expect(node.cluster.leader().toNullable()?.address.toString()).toBe(leader.toString());
    const announced = recordFrom(node.cluster);

    lastHeardFrom(node.cluster, leader, SILENT_PAST_DOWN_MS);
    detectorTick(node.cluster);

    expect(namesOf(announced)).toEqual([
      'ReachabilityChanged', 'MemberDown', 'LeaderChanged', 'MemberRemoved',
    ]);
  });

  test('the operator’s down()', async () => {
    const node = await startNode('count-leader-operator', 14_290);
    nodes.push(node);
    const leader = new NodeAddress('count-leader-operator', LEADER_HOST, 14_390);
    gossipPeer(node.cluster, leader, 'up', 1);
    const announced = recordFrom(node.cluster);

    expect(node.cluster.down(leader)).toBe(true);

    expect(namesOf(announced)).toEqual(['MemberDown', 'LeaderChanged', 'MemberRemoved']);
  });

  test('the detector’s unreachable arm: the leader moves once, after the one MemberUnreachable', async () => {
    // Not `down`, but the same pair: an `unreachable` leader is no longer `up`,
    // so leadership moves at this transition already.
    const node = await startNode('count-leader-unreachable', 14_291);
    nodes.push(node);
    const leader = new NodeAddress('count-leader-unreachable', LEADER_HOST, 14_391);
    gossipPeer(node.cluster, leader, 'up', 1);
    const announced = recordFrom(node.cluster);

    lastHeardFrom(node.cluster, leader, SILENT_BUT_NOT_DOWN_MS);
    detectorTick(node.cluster);

    expect(namesOf(announced)).toEqual(['ReachabilityChanged', 'MemberUnreachable', 'LeaderChanged']);
  });
});

describe('what the dedupe deliberately leaves alone (#1428)', () => {
  test('a recovered peer is announced up and reachable, once each', async () => {
    // The heartbeat path looks like the four that were changed — `updateMember`
    // followed by an explicit emit — and is not a duplicate: the transition
    // announces `MemberUp`, and `MemberReachable` is a reachability event no
    // status maps to.  `ClusterSingletonManager` reconciles on that `MemberUp`.
    const node = await startNode('count-recovery', 14_292);
    nodes.push(node);
    const peer = new NodeAddress('count-recovery', FOLLOWER_HOST, 14_392);
    gossipPeer(node.cluster, peer, 'up', 1);
    lastHeardFrom(node.cluster, peer, SILENT_BUT_NOT_DOWN_MS);
    detectorTick(node.cluster);
    expect(internals(node.cluster).members.get(peer.toString())?.status).toBe('unreachable');
    const announced = recordFrom(node.cluster);

    internals(node.cluster).onHeartbeat(peer, {
      kind: 'heartbeat', from: peer.toJSON(), seq: 1, ts: Date.now(),
    });

    expect(namesOf(announced)).toEqual(['MemberUp', 'MemberReachable']);
    expect(announced.map((event) => (event as MemberUp | MemberReachable).member.status))
      .toEqual(['up', 'up']);
  });
});
