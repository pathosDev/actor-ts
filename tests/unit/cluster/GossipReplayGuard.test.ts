/**
 * #112 — the mechanics of the per-sender gossip frame counter.
 *
 * The end-to-end exploit (replaying a downed member's own record to bring it
 * back) lives in `tests/multi-node/cluster-security.test.ts`.  What is pinned
 * here is everything a replay guard can get wrong on its own:
 *
 * - it must **refuse the whole frame**, and say so to an operator through the
 *   existing refusal counter rather than a new metric series (#131);
 * - it must not become a **new denial of service**.  A guard that adopts any
 *   number a peer sends is one frame away from being the exploit #114 closed:
 *   `Number.MAX_SAFE_INTEGER` as the mark would refuse everything the real node
 *   says from then on;
 * - the mark must not **outlive its member**, or the address's next
 *   incarnation — whose counter starts from its own clock — would be refused.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { GossipMessage, MemberData } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { MetricsExtensionId, metricsOf } from '../../../src/metrics/MetricsExtension.js';

const MINUTE_MS = 60 * 1_000;

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
};

type DetectorTiming = {
  readonly heartbeatIntervalMs: number;
  readonly unreachableAfterMs: number;
  readonly downAfterMs: number;
};

/** Far-out timers by default: the tests drive the merge by injecting frames. */
const IDLE_DETECTOR: DetectorTiming = {
  heartbeatIntervalMs: 60_000,
  unreachableAfterMs: 120_000,
  downAfterMs: 240_000,
};

async function startNode(
  systemName: string,
  port: number,
  detector: DetectorTiming = IDLE_DETECTOR,
): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, '10.0.112.1', port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withFailureDetector(detector)
    .withGossipIntervalMs(60_000);
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster, address };
}

/** The private surface these tests reach through — merge internals, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: GossipMessage): void;
  readonly members: Map<string, Member>;
  readonly acceptedGossipSequences: Map<string, number>;
  readonly gossipSequence: number;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

/** Deliver a gossip frame with an explicit sequence, as a peer would. */
function gossipFrom(
  cluster: Cluster, from: NodeAddress, sequence: number, members: MemberData[],
): void {
  internals(cluster).handleWire(from, {
    kind: 'gossip', from: from.toJSON(), sequence, members,
  });
}

/** A peer's self-announcement — the one claim `maySpeakFor` never refuses. */
function selfRecord(peer: NodeAddress): MemberData {
  return { address: peer.toJSON(), status: 'up', version: Date.now(), roles: [] };
}

function markFor(cluster: Cluster, address: NodeAddress): number | undefined {
  return internals(cluster).acceptedGossipSequences.get(address.toString());
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

describe('the frame a peer already sent is refused whole', () => {
  test('a repeated sequence drops every record in the frame', async () => {
    const node = await startNode('replay-whole', 9_401);
    nodes.push(node);
    const peer = new NodeAddress('replay-whole', '10.0.112.2', 9_490);
    const subject = new NodeAddress('replay-whole', '10.0.112.3', 9_491);

    const sequence = Date.now();
    gossipFrom(node.cluster, peer, sequence, [selfRecord(peer)]);
    expect(markFor(node.cluster, peer)).toBe(sequence);

    // Same number, different payload: the frame is refused before a single
    // record is looked at, so the subject never appears.
    gossipFrom(node.cluster, peer, sequence, [
      { address: subject.toJSON(), status: 'up', version: Date.now(), roles: ['payments'] },
    ]);

    expect(internals(node.cluster).members.has(subject.toString())).toBe(false);
  });

  test('an increasing sequence from the same peer merges every time', async () => {
    // The regression side: the guard refuses a repeat, not the peer.
    const node = await startNode('replay-progress', 9_402);
    nodes.push(node);
    const peer = new NodeAddress('replay-progress', '10.0.112.2', 9_490);
    const subject = new NodeAddress('replay-progress', '10.0.112.3', 9_491);

    const base = Date.now();
    gossipFrom(node.cluster, peer, base, [selfRecord(peer)]);
    gossipFrom(node.cluster, peer, base + 1, [
      { address: subject.toJSON(), status: 'joining', version: base, roles: ['worker'] },
    ]);
    // The version has to clear the +1 the leader's promotion loop already
    // added on top of the merged record — unrelated to the replay guard.
    gossipFrom(node.cluster, peer, base + 2, [
      { address: subject.toJSON(), status: 'leaving', version: base + 100, roles: ['worker'] },
    ]);

    expect(internals(node.cluster).members.get(subject.toString())?.status).toBe('leaving');
    expect(markFor(node.cluster, peer)).toBe(base + 2);
  });

  test('refusals are counted on the existing metric, under a fourth reason', async () => {
    // A fourth label value on `cluster_gossip_records_refused_total`, not a new
    // series: the label set is closed for cardinality (#131), and an operator
    // alerting on "records are being refused at all" should not have to know
    // which guard fired.
    const node = await startNode('replay-metric', 9_403);
    nodes.push(node);
    node.system.extension(MetricsExtensionId).enable();
    const peer = new NodeAddress('replay-metric', '10.0.112.2', 9_490);

    const sequence = Date.now();
    gossipFrom(node.cluster, peer, sequence, [selfRecord(peer)]);
    const records: MemberData[] = [];
    for (let i = 0; i < 5; i++) {
      const address = new NodeAddress('replay-metric', '10.0.112.9', 40_000 + i);
      records.push({ address: address.toJSON(), status: 'up', version: Date.now(), roles: [] });
    }
    gossipFrom(node.cluster, peer, sequence, records);

    const refused = metricsOf(node.system)
      .counter('cluster_gossip_records_refused_total', { reason: 'replayed-frame' });
    expect(refused.value).toBe(5);
  });
});

describe('the guard cannot be turned into a denial of service', () => {
  test('exploit: a frame numbered absurdly far ahead does not become the mark', async () => {
    // The shape of #114 one field to the left.  If any number a peer sends
    // became the high-water mark, `Number.MAX_SAFE_INTEGER` would refuse
    // everything the real node says afterwards — and `MAX_SAFE_INTEGER + 1`
    // rounds back to itself, so not even a restart could escape.
    const node = await startNode('replay-pin', 9_404);
    nodes.push(node);
    const peer = new NodeAddress('replay-pin', '10.0.112.2', 9_490);
    const subject = new NodeAddress('replay-pin', '10.0.112.3', 9_491);

    const base = Date.now();
    gossipFrom(node.cluster, peer, base, [selfRecord(peer)]);
    gossipFrom(node.cluster, peer, Number.MAX_SAFE_INTEGER, [selfRecord(peer)]);

    expect(markFor(node.cluster, peer)).toBe(base);

    // …so the peer's next ordinary frame is still merged.
    gossipFrom(node.cluster, peer, base + 1, [
      { address: subject.toJSON(), status: 'up', version: base, roles: ['worker'] },
    ]);
    expect(internals(node.cluster).members.get(subject.toString())?.status).toBe('up');
  });

  test('the plausibility bound is the same clock-skew budget versions get', async () => {
    // Just inside `maxVersionSkewMs` is adopted; beyond it the frame still
    // merges but is not recorded, so a skewed peer is never silenced by its
    // own clock.
    const node = await startNode('replay-budget', 9_405);
    nodes.push(node);
    const peer = new NodeAddress('replay-budget', '10.0.112.2', 9_490);

    const withinBudget = Date.now() + 4 * MINUTE_MS;
    gossipFrom(node.cluster, peer, withinBudget, [selfRecord(peer)]);
    expect(markFor(node.cluster, peer)).toBe(withinBudget);

    const beyondBudget = Date.now() + 60 * MINUTE_MS;
    gossipFrom(node.cluster, peer, beyondBudget, [selfRecord(peer)]);
    expect(markFor(node.cluster, peer)).toBe(withinBudget);
  });
});

describe('a mark does not outlive its member', () => {
  test('the failure detector deleting a peer clears its mark', async () => {
    // The address's next incarnation seeds its counter from its own clock, not
    // from where the previous one left off — a mark left behind would refuse
    // its first frames.  The FD-down path is the one that *deletes* rather than
    // tombstoning, so it is the one that has to clean up.
    const node = await startNode('replay-eviction', 9_406, {
      heartbeatIntervalMs: 40, unreachableAfterMs: 120, downAfterMs: 240,
    });
    nodes.push(node);
    const peer = new NodeAddress('replay-eviction', '10.0.112.2', 9_490);

    const sequence = Date.now();
    gossipFrom(node.cluster, peer, sequence, [selfRecord(peer)]);
    expect(markFor(node.cluster, peer)).toBe(sequence);

    await waitFor(() => !internals(node.cluster).members.has(peer.toString()));
    expect(markFor(node.cluster, peer)).toBeUndefined();

    // And the peer comes back on a *lower* number, exactly as a restarted
    // process on a rewound clock would.
    gossipFrom(node.cluster, peer, sequence - 5_000, [selfRecord(peer)]);
    expect(internals(node.cluster).members.get(peer.toString())?.status).toBe('up');
  }, 15_000);

  test('this node seeds its own counter above its previous incarnation', async () => {
    // Peers hold a mark per sender, so a fresh process has to start above every
    // frame the previous one at that address ever sent.  Seeding from the wall
    // clock does it: a counter advances by one per gossip frame, and no node
    // gossips a thousand times a second.
    const node = await startNode('replay-epoch', 9_407);
    nodes.push(node);

    const seeded = internals(node.cluster).gossipSequence;
    expect(seeded).toBeGreaterThan(Date.now() - MINUTE_MS);
    expect(seeded).toBeLessThanOrEqual(Date.now());
  });
});
