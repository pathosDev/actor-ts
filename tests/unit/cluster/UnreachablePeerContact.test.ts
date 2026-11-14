/**
 * #930, decision D-5 — what this node still sends an `unreachable` member.
 *
 * Heartbeats go to it on every beat, and gossip on every
 * `unreachable-gossip-rounds`-th round.  `PartitionHeal.test.ts` proves the
 * two together heal a partition end to end; these cases pin each half on its
 * own, frame by frame, so the throttle and the heartbeat target set are held
 * to exactly what the decision says rather than to "it healed".
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberData, MemberStatus, WireMessage } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';

const SYSTEM = 'unreachable-contact';
const HOST = '10.0.193.21';
const PEER_HOST = '10.0.193.22';

interface ClusterInternals {
  mergeMember(from: NodeAddress, senderStatus: MemberStatus | undefined, data: MemberData): void;
  updateMember(next: Member): void;
  heartbeatTick(): void;
  gossipTick(): void;
  readonly members: Map<string, Member>;
}

const internals = (cluster: Cluster): ClusterInternals => cluster as unknown as ClusterInternals;

type Sent = { readonly to: string; readonly kind: string };
type NodeHandle = { readonly system: ActorSystem; readonly cluster: Cluster; readonly sent: Sent[] };

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

/** A node whose timers never fire on their own, with every outbound frame recorded. */
async function startNode(port: number, unreachableGossipRounds?: number): Promise<NodeHandle> {
  const address = new NodeAddress(SYSTEM, HOST, port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withScheduler(new ManualScheduler());
  const system = ActorSystem.create(SYSTEM, systemOptions);
  const transport = new InMemoryTransport(address);
  const sent: Sent[] = [];
  const send = transport.send.bind(transport);
  transport.send = (to: NodeAddress, message: WireMessage): void => {
    sent.push({ to: to.toString(), kind: message.kind });
    send(to, message);
  };
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(transport)
    .withFailureDetectorAutoDown(false)
    .withGossipIntervalMs(600_000)
    .withFailureDetector({ heartbeatIntervalMs: 600_000, unreachableAfterMs: 1_200_000, downAfterMs: 2_400_000 });
  if (unreachableGossipRounds !== undefined) clusterOptions.withUnreachableGossipRounds(unreachableGossipRounds);
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster, sent };
  nodes.push(node);
  return node;
}

/** File `peer` as a member and then mark it `status`, the way the detector would. */
function holdPeerAs(node: NodeHandle, peer: NodeAddress, status: MemberStatus): void {
  internals(node.cluster).mergeMember(peer, 'up', { address: peer.toJSON(), status: 'up', version: Date.now(), roles: [] });
  const member = internals(node.cluster).members.get(peer.toString())!;
  if (status !== 'up') internals(node.cluster).updateMember(member.withStatus(status));
}

const framesTo = (node: NodeHandle, peer: NodeAddress, kind: string): number =>
  node.sent.filter((frame) => frame.to === peer.toString() && frame.kind === kind).length;

describe('heartbeats keep going to unreachable members (#930)', () => {
  test('an unreachable member is heartbeated on every beat', async () => {
    const node = await startNode(19_601);
    const peer = new NodeAddress(SYSTEM, PEER_HOST, 19_602);
    holdPeerAs(node, peer, 'unreachable');
    node.sent.length = 0;

    for (let beat = 0; beat < 4; beat++) internals(node.cluster).heartbeatTick();
    expect(framesTo(node, peer, 'heartbeat')).toBe(4);
  });

  test('a downed member is not heartbeated', async () => {
    // `down` is a decision, not an observation; nothing a heartbeat says
    // reverses it, so probing it would only spend frames.
    const node = await startNode(19_611);
    const peer = new NodeAddress(SYSTEM, PEER_HOST, 19_612);
    holdPeerAs(node, peer, 'down');
    node.sent.length = 0;

    internals(node.cluster).heartbeatTick();
    expect(framesTo(node, peer, 'heartbeat')).toBe(0);
  });
});

describe('gossip reaches unreachable members on every n-th round (#930)', () => {
  test('the shipped default sends one frame every third round', async () => {
    const node = await startNode(19_621);
    const peer = new NodeAddress(SYSTEM, PEER_HOST, 19_622);
    holdPeerAs(node, peer, 'unreachable');
    node.sent.length = 0;

    for (let round = 0; round < 9; round++) internals(node.cluster).gossipTick();
    expect(framesTo(node, peer, 'gossip')).toBe(3);
  });

  test('the cadence follows unreachable-gossip-rounds', async () => {
    const node = await startNode(19_631, 2);
    const peer = new NodeAddress(SYSTEM, PEER_HOST, 19_632);
    holdPeerAs(node, peer, 'unreachable');
    node.sent.length = 0;

    for (let round = 0; round < 8; round++) internals(node.cluster).gossipTick();
    expect(framesTo(node, peer, 'gossip')).toBe(4);
  });

  test('0 sends unreachable members no gossip', async () => {
    const node = await startNode(19_641, 0);
    const peer = new NodeAddress(SYSTEM, PEER_HOST, 19_642);
    holdPeerAs(node, peer, 'unreachable');
    node.sent.length = 0;

    for (let round = 0; round < 9; round++) internals(node.cluster).gossipTick();
    expect(framesTo(node, peer, 'gossip')).toBe(0);
  });

  test('a negative or fractional value is refused', async () => {
    await expect(startNode(19_651, -1)).rejects.toThrow(/unreachableGossipRounds/);
    await expect(startNode(19_652, 1.5)).rejects.toThrow(/unreachableGossipRounds/);
  });
});
