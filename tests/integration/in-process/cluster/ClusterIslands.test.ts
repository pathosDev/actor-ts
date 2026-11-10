/**
 * #1176 — two clusters of the same name, formed while a startup partition kept
 * them apart, meet once it heals.
 *
 * A node stopped dialling its seeds once it was up, and gossip only goes to
 * members already in the map, so the two islands never sent each other a
 * frame again and the fork lasted until one side restarted.  Now each node
 * keeps dialling the seeds it has not met, the meeting is detected and logged,
 * the other island's frames are refused rather than merged, and with
 * `down-smaller-island` on the smaller island downs itself.
 *
 * In-process, over `InMemoryTransport`: the "partition" is simply that each
 * island's founder was started with no seed reaching the other, and the
 * "heal" is the re-dial reaching a node that exists all along.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { SelfRemoved, type ClusterEvent } from '../../../../src/cluster/ClusterEvents.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { LogLevel } from '../../../../src/Logger.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';

type Node = { readonly system: ActorSystem; readonly cluster: Cluster; readonly log: RecordingLogger; readonly events: ClusterEvent[] };

let nodes: Node[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

const SYSTEM = 'islands';

async function startNode(port: number, seeds: number[], downSmallerIsland: boolean): Promise<Node> {
  const log = new RecordingLogger();
  const system = ActorSystem.create(SYSTEM, ActorSystemOptions.create().withLogger(log).withLogLevel(LogLevel.Info));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(SYSTEM, 'h', port)))
    .withSeeds(seeds.map((seed) => `${SYSTEM}@h:${seed}`))
    .withSeedRetryIntervalMs(30)
    .withGossipIntervalMs(30)
    .withDownSmallerIsland(downSmallerIsland);
  const cluster = await Cluster.join(system, clusterOptions);
  const events: ClusterEvent[] = [];
  cluster.subscribe((event) => events.push(event), { replayMode: 'snapshot' });
  const node = { system, cluster, log, events };
  nodes.push(node);
  return node;
}

/**
 * Island A: two nodes, founded at port `base`, whose second member also names
 * `base + 10` as a seed — the founder of island B, unreachable while A forms
 * because B starts later.  Island B: one node that founds itself.
 */
async function formIslands(base: number, downSmallerIsland: boolean): Promise<{ a1: Node; a2: Node; b: Node }> {
  const a1 = await startNode(base, [], downSmallerIsland);
  const a2 = await startNode(base + 1, [base, base + 10], downSmallerIsland);
  await awaitCondition(() => a1.cluster.upMembers().length === 2 && a2.cluster.upMembers().length === 2, {
    timeoutMs: 4_000, label: 'island A formed',
  });
  const b = await startNode(base + 10, [], downSmallerIsland);
  await awaitCondition(() => b.cluster.selfMember()?.status === 'up', { timeoutMs: 4_000, label: 'island B founded itself' });
  return { a1, a2, b };
}

const reportedIsland = (node: Node): boolean =>
  node.log.records.some((record) => record.level === 'error' && record.message.includes('a second cluster named'));

describe('two same-name clusters from a startup partition meet, and are not merged (#1176)', () => {
  test('the re-dial reaches the other island; both sides report it and neither admits the other', async () => {
    const { a1, a2, b } = await formIslands(46_100, false);

    await awaitCondition(() => reportedIsland(b) && reportedIsland(a2), {
      timeoutMs: 4_000, label: 'both islands reported the other',
    });
    expect(a1.cluster.upMembers()).toHaveLength(2);
    expect(a2.cluster.upMembers()).toHaveLength(2);
    expect(b.cluster.upMembers()).toHaveLength(1);
    expect(b.events.some((event) => event instanceof SelfRemoved)).toBe(false);
  }, 15_000);

  test('the larger island re-dialling the smaller one makes the smaller one learn of it too', async () => {
    // Only island A's second node names island B as a seed; B dials nobody.
    // B's one answer is what tells A — and here A is the one that re-dials, so
    // the mutual report rests on that answer.
    const { a2, b } = await formIslands(46_300, true);

    await awaitCondition(() => reportedIsland(a2), { timeoutMs: 4_000, label: 'the dialling island learned of the other' });
    await awaitCondition(() => b.events.some((event) => event instanceof SelfRemoved), {
      timeoutMs: 4_000, label: 'the island that dials nobody still learned it is the smaller one',
    });
  }, 15_000);

  test('with down-smaller-island on, the one-node island downs itself and the two-node one carries on', async () => {
    const { a1, a2, b } = await formIslands(46_200, true);

    await awaitCondition(() => b.events.some((event) => event instanceof SelfRemoved), {
      timeoutMs: 4_000, label: 'the smaller island downed itself',
    });
    expect(a1.cluster.upMembers()).toHaveLength(2);
    expect(a2.cluster.selfMember()?.status).toBe('up');
  }, 15_000);
});

describe('a probe from a member of this cluster is not a foreign island (#1176)', () => {
  type WireEntry = { handleWire(from: NodeAddress, message: unknown): void };
  let sequence = Date.now();
  const probe = (node: Node, sender: NodeAddress, listsReceiver: boolean): void => {
    sequence += 1;
    const members = [{ address: sender.toJSON(), status: 'up', version: Date.now(), roles: [] }];
    if (listsReceiver) members.push(node.cluster.selfMember()!.toData() as never);
    (node.cluster as unknown as WireEntry).handleWire(sender, {
      kind: 'gossip', from: sender.toJSON(), sequence, members, islandProbe: true,
    });
  };

  test('a sender whose membership lists this node is a member not heard of yet, and is admitted', async () => {
    const node = await startNode(46_400, [], false);
    await awaitCondition(() => node.cluster.selfMember()?.status === 'up', { label: 'the node is up' });
    const sender = new NodeAddress(SYSTEM, 'h', 46_401, 'sender-run');

    probe(node, sender, true);

    expect(reportedIsland(node)).toBe(false);
    expect(node.cluster.getMembers().some((member) => member.address.equals(sender))).toBe(true);
  });

  test('the same probe without this node in it is a foreign island, refused', async () => {
    const node = await startNode(46_410, [], false);
    await awaitCondition(() => node.cluster.selfMember()?.status === 'up', { label: 'the node is up' });
    const sender = new NodeAddress(SYSTEM, 'h', 46_411, 'sender-run');

    probe(node, sender, false);

    expect(reportedIsland(node)).toBe(true);
    expect(node.cluster.getMembers().some((member) => member.address.equals(sender))).toBe(false);
  });
});
