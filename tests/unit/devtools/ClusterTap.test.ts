/**
 * #161 — the `cluster` stream's two ends of the subscription change.
 *
 * The tap used to build snapshot-mode by hand: subscribe, hold a `replaying`
 * flag, drop everything that arrived while it was set.  That was correct only
 * because the replay happens to be synchronous, and it would have gone quietly
 * wrong the day it stopped being.  It now asks for `replayMode: 'snapshot'` and
 * discards the one event it gets, which is the same intent stated once.
 *
 * The other end is `ReachabilityChanged`, which the panel wants precisely
 * because it disagrees with `status`: status is what the cluster has converged
 * on, `reachable` is what the node serving the DevTools can see, and the two
 * differing is what a partition looks like from inside one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import {
  ClusterStatsPublished,
  LeaderChanged,
  MemberUp,
  type ClusterEvent,
} from '../../../src/cluster/ClusterEvents.js';
import { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { none } from '../../../src/util/Option.js';
import type { MemberData, MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { ClusterMembership } from '../../../src/devtools/internal/ClusterMembership.js';
import { ClusterTap } from '../../../src/devtools/taps/ClusterTap.js';
import type {
  ClusterEventPayload,
  ClusterSnapshotPayload,
  DevToolsStreamPayload,
} from '../../../src/devtools/protocol/index.js';
import { RecordingLogger, type RecordedLog } from '../../util/RecordingLogger.js';

const SELF_HOST = '10.0.161.11';
const PEER_HOST = '10.0.161.12';

type Harness = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
  readonly tap: ClusterTap;
  readonly emitted: DevToolsStreamPayload[];
  /** Everything the system logged, so a test can ask whether the tap reported an event. */
  readonly logger: RecordingLogger;
};

interface ClusterInternals {
  mergeMember(from: NodeAddress, senderStatus: MemberStatus | undefined, data: MemberData): void;
  failureDetectionTick(): void;
  readonly failureDetector: { heartbeat(peer: NodeAddress, now?: number): void };
}

const internals = (cluster: Cluster): ClusterInternals => cluster as unknown as ClusterInternals;

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.tap.uninstall();
    try { await harness.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await harness.system.terminate(); } catch { /* teardown is best-effort */ }
  }
});

/** A one-node cluster with a tap attached, and every timer pushed out of the way. */
async function startTapped(systemName: string, port: number): Promise<Harness> {
  const address = new NodeAddress(systemName, SELF_HOST, port);
  const logger = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Debug);
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
  const emitted: DevToolsStreamPayload[] = [];
  const tap = new ClusterTap(cluster, system, new ClusterMembership(cluster));
  const harness: Harness = { system, cluster, address, tap, emitted, logger };
  harnesses.push(harness);
  return harness;
}

const peerAddress = (systemName: string, port: number): NodeAddress =>
  new NodeAddress(systemName, PEER_HOST, port);

/**
 * Publish one event through the tap and return what was logged about it.
 *
 * "About it" means a line naming the event's class — the one thing the report
 * of an event without an arm is required to carry (#1502), so the match does
 * not depend on the rest of the wording.  Every assertion that an event did
 * NOT reach the unknown path goes through here, and so does the control that
 * an event which did is reported: if this ever stops seeing that report, the
 * control goes red, rather than every absence assertion going quietly green.
 */
function publishAndCollectReports(harness: Harness, event: ClusterEvent): ReadonlyArray<RecordedLog> {
  const before = harness.logger.records.length;
  harness.cluster._publishClusterEvent(event);
  return harness.logger.records
    .slice(before)
    .filter((record) => record.message.includes(event.constructor.name));
}

function gossipSelfRecord(cluster: Cluster, peer: NodeAddress, status: MemberStatus): void {
  internals(cluster).mergeMember(peer, 'up', {
    address: peer.toJSON(), status, version: Date.now(), roles: [],
  });
}

const eventsIn = (payloads: ReadonlyArray<DevToolsStreamPayload>): ReadonlyArray<ClusterEventPayload> =>
  payloads.filter((payload): payload is ClusterEventPayload => payload.kind === 'cluster-event');

describe('ClusterTap — snapshot replay (#161)', () => {
  test('installing against a populated cluster emits nothing', async () => {
    const harness = await startTapped('tap-install', 9_321);
    gossipSelfRecord(harness.cluster, peerAddress('tap-install', 9_391), 'up');

    harness.tap.install((payload) => { harness.emitted.push(payload); });

    // A client that attaches later is handed `snapshot()`, read from the
    // cluster at that moment — re-broadcasting the replay would tell every
    // already-attached client that the whole cluster had just joined again.
    expect(harness.emitted).toEqual([]);
  });

  test('a membership change after install still reaches the stream', async () => {
    const harness = await startTapped('tap-live', 9_322);
    harness.tap.install((payload) => { harness.emitted.push(payload); });

    const peer = peerAddress('tap-live', 9_392);
    gossipSelfRecord(harness.cluster, peer, 'up');

    expect(eventsIn(harness.emitted).map((payload) => payload.event))
      .toEqual(['member-joined', 'member-up']);
    // Each member event re-states the list, because the events alone never say
    // that a departed node is still being remembered.
    expect(harness.emitted.filter((payload) => payload.kind === 'cluster-snapshot').length).toBe(2);
  });

  test('snapshot() reports the live membership', async () => {
    const harness = await startTapped('tap-snapshot', 9_323);
    gossipSelfRecord(harness.cluster, peerAddress('tap-snapshot', 9_393), 'up');
    harness.tap.install((payload) => { harness.emitted.push(payload); });

    const frames = harness.tap.snapshot();

    expect(frames.length).toBe(1);
    const snapshot = frames[0] as ClusterSnapshotPayload;
    expect(snapshot.kind).toBe('cluster-snapshot');
    expect(snapshot.selfAddress).toBe(harness.address.toString());
    expect(snapshot.members.map((member) => member.address).sort())
      .toEqual([harness.address.toString(), 'tap-snapshot@10.0.161.12:9393']);
  });
});

describe('ClusterTap — reachability (#161)', () => {
  test('a lost peer arrives as reachability-changed carrying its member', async () => {
    const harness = await startTapped('tap-reachability', 9_324);
    const peer = peerAddress('tap-reachability', 9_394);
    gossipSelfRecord(harness.cluster, peer, 'up');
    harness.tap.install((payload) => { harness.emitted.push(payload); });

    internals(harness.cluster).failureDetector.heartbeat(peer, Date.now() - 3_000);
    internals(harness.cluster).failureDetectionTick();

    const reachability = eventsIn(harness.emitted)
      .filter((payload) => payload.event === 'reachability-changed');
    expect(reachability.length).toBe(1);
    expect(reachability[0]!.reachable).toBe(false);
    expect(reachability[0]!.member?.address).toBe(peer.toString());
  });

  test('the recovery is reported too', async () => {
    const harness = await startTapped('tap-recovery', 9_325);
    const peer = peerAddress('tap-recovery', 9_395);
    gossipSelfRecord(harness.cluster, peer, 'up');
    harness.tap.install((payload) => { harness.emitted.push(payload); });

    internals(harness.cluster).failureDetector.heartbeat(peer, Date.now() - 3_000);
    internals(harness.cluster).failureDetectionTick();
    internals(harness.cluster).failureDetector.heartbeat(peer);
    internals(harness.cluster).failureDetectionTick();

    expect(
      eventsIn(harness.emitted)
        .filter((payload) => payload.event === 'reachability-changed')
        .map((payload) => payload.reachable),
    ).toEqual([false, true]);
  });
});

describe('ClusterTap — the periodic stats sample (#842)', () => {
  test('a stats sample produces no payload at all', async () => {
    // Not a membership change, so the cluster panel has nothing to render —
    // and `StatsTap` already streams the same figures on its own ticker, so
    // forwarding them here would give one number two periodic sources.
    const harness = await startTapped('tap-stats', 9_326);
    gossipSelfRecord(harness.cluster, peerAddress('tap-stats', 9_396), 'up');
    harness.tap.install((payload) => { harness.emitted.push(payload); });

    const reports = publishAndCollectReports(
      harness,
      new ClusterStatsPublished(2, 2, 0, harness.cluster.leader(), harness.address),
    );

    expect(harness.emitted).toEqual([]);
    // Silence alone is not the arm: without it the sample falls through to the
    // unknown-event path, which forwards nothing either.  Only that path's
    // report tells the two apart (#1502).
    expect(reports).toEqual([]);
  });

  test('a membership change through the same door still reports (#842)', async () => {
    // The control arm: `_publishClusterEvent` is not a channel the tap
    // ignores, so the assertion above is about the event and not about the
    // door it came through.
    const harness = await startTapped('tap-stats-control', 9_327);
    harness.tap.install((payload) => { harness.emitted.push(payload); });

    gossipSelfRecord(harness.cluster, peerAddress('tap-stats-control', 9_397), 'up');

    expect(eventsIn(harness.emitted).length).toBeGreaterThan(0);
  });

  test('the compiler is NOT what keeps this event out of onMemberEvent (#842)', () => {
    // Measured while adding the arm above, and it refutes what
    // `onShardRegistrationEvent`'s comment implies about the whole family:
    // deleting the `ClusterStatsPublished` arm AND dropping the type from
    // `onMemberEvent`'s `Exclude` compiles clean.  At the time the runtime
    // difference was nil too, because `onUnknownEvent` was an empty method, so
    // nothing at all noticed the arm going away.  The stats test above does
    // now, by the unknown-event report (#1502); the compiler still does not.
    //
    // The mechanism is this assignment, which is why it is written as one
    // rather than described: `ClusterStatsPublished` carries
    // `leader: Option<Member>`, so it is structurally assignable to
    // `LeaderChanged`, and `Exclude` works by assignability — the union member
    // removes itself. This line stops compiling the day the shape changes,
    // which is the day the compiler starts guarding the arm again.
    const asLeaderChanged: LeaderChanged =
      new ClusterStatsPublished(3, 2, 1, none, new NodeAddress('probe', 'h', 1));

    expect(asLeaderChanged.leader.isSome()).toBe(false);
  });
});

describe('ClusterTap — an event with no arm (#1502)', () => {
  test('is reported once, at debug, by its class name', async () => {
    // The tap listens in-process, so every event it receives is a member of
    // this build's union, and one that reaches no arm is a gap in the tap —
    // never a newer node's event.  It used to vanish without a trace.  A
    // subclass is the one way to publish such an event without deleting an
    // arm: the member-event lookup keys on the exact constructor, so
    // `MemberUp`'s entry does not cover it.
    class UnmappedMemberEvent extends MemberUp {}
    const harness = await startTapped('tap-unknown', 9_328);
    harness.tap.install((payload) => { harness.emitted.push(payload); });
    const member = new Member(peerAddress('tap-unknown', 9_398), 'up', 1);

    const reports = publishAndCollectReports(harness, new UnmappedMemberEvent(member));

    expect(harness.emitted).toEqual([]);
    expect(reports.map((record) => record.level)).toEqual(['debug']);
  });
});
