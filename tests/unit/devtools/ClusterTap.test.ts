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
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberData, MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { ClusterMembership } from '../../../src/devtools/internal/ClusterMembership.js';
import { ClusterTap } from '../../../src/devtools/taps/ClusterTap.js';
import type {
  ClusterEventPayload,
  ClusterSnapshotPayload,
  DevToolsStreamPayload,
} from '../../../src/devtools/protocol/index.js';

const SELF_HOST = '10.0.161.11';
const PEER_HOST = '10.0.161.12';

type Harness = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
  readonly tap: ClusterTap;
  readonly emitted: DevToolsStreamPayload[];
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
  const emitted: DevToolsStreamPayload[] = [];
  const tap = new ClusterTap(cluster, system, new ClusterMembership(cluster));
  const harness: Harness = { system, cluster, address, tap, emitted };
  harnesses.push(harness);
  return harness;
}

const peerAddress = (systemName: string, port: number): NodeAddress =>
  new NodeAddress(systemName, PEER_HOST, port);

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
