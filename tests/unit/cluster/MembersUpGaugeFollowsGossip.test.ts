/**
 * #994 follow-up — `cluster_members_up` follows every change to the member
 * map, the ones learned through gossip included.
 *
 * The gauge was set in `updateMember` only, which is the route for changes
 * this node makes itself.  A status learned from a peer goes through the
 * gossip merge, which writes the map with `setMember` and never touched the
 * gauge, so a member another node promoted, marked unreachable or downed left
 * the figure where it was until this node changed something of its own.  The
 * troubleshooting runbook's flapping query is `changes(cluster_members_up[15m])`,
 * so a stale gauge made a documented diagnostic report a quiet cluster.
 *
 * Metrics are off by default in a test system; each case enables the registry.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { GossipMessage, MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import type { MetricsRegistry } from '../../../src/metrics/Metrics.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';

const SYSTEM = 'members-up-gauge';
const HOST = '10.0.196.1';
const PEER_HOST = '10.0.196.2';
const SUBJECT_HOST = '10.0.196.3';

interface ClusterInternals {
  handleWire(from: NodeAddress, message: GossipMessage): void;
  deleteMember(key: string): void;
  readonly members: Map<string, Member>;
}

const internals = (cluster: Cluster): ClusterInternals => cluster as unknown as ClusterInternals;

type NodeHandle = { readonly system: ActorSystem; readonly cluster: Cluster; readonly registry: MetricsRegistry };

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

async function startNode(port: number): Promise<NodeHandle> {
  const address = new NodeAddress(SYSTEM, HOST, port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withScheduler(new ManualScheduler());
  const system = ActorSystem.create(SYSTEM, systemOptions);
  const registry = system.extension(MetricsExtensionId).enable();
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withFailureDetectorAutoDown(false)
    .withGossipIntervalMs(600_000)
    .withFailureDetector({ heartbeatIntervalMs: 600_000, unreachableAfterMs: 1_200_000, downAfterMs: 2_400_000 });
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster, registry };
  nodes.push(node);
  return node;
}

let sequence = 0;
function gossip(node: NodeHandle, sender: NodeAddress, subject: NodeAddress, status: MemberStatus, version: number): void {
  sequence = Math.max(sequence + 1, Date.now());
  internals(node.cluster).handleWire(sender, {
    kind: 'gossip',
    from: sender.toJSON(),
    sequence,
    members: [{ address: subject.toJSON(), status, version, roles: [] }],
  });
}

const membersUp = (node: NodeHandle): number | undefined =>
  node.registry.collect().find((sample) => sample.name === 'cluster_members_up')?.value;

describe('cluster_members_up follows gossip-merged changes', () => {
  test('a member learned up, then unreachable, then removed through gossip moves the gauge each time', async () => {
    const node = await startNode(19_701);
    const peer = new NodeAddress(SYSTEM, PEER_HOST, 19_702);
    const subject = new NodeAddress(SYSTEM, SUBJECT_HOST, 19_703);
    const version = Date.now();
    expect(membersUp(node)).toBe(1);

    gossip(node, peer, peer, 'up', version);
    expect(membersUp(node)).toBe(2);

    gossip(node, peer, subject, 'up', version);
    expect(membersUp(node)).toBe(3);

    gossip(node, peer, subject, 'unreachable', version + 1);
    expect(membersUp(node)).toBe(2);

    gossip(node, peer, subject, 'up', version + 2);
    expect(membersUp(node)).toBe(3);

    gossip(node, peer, subject, 'removed', version + 3);
    expect(membersUp(node)).toBe(2);
  });
});

describe('cluster_members_up follows a deleted member', () => {
  test('deleting an up member lowers the gauge', async () => {
    // The other write door: the detector's auto-down removal and the
    // replacement of a restarted run delete the entry instead of storing a
    // tombstone, so the gauge has to follow `deleteMember` as well.
    const node = await startNode(19_711);
    const peer = new NodeAddress(SYSTEM, PEER_HOST, 19_712);
    gossip(node, peer, peer, 'up', Date.now());
    expect(membersUp(node)).toBe(2);

    internals(node.cluster).deleteMember(peer.toString());
    expect(membersUp(node)).toBe(1);
  });
});
