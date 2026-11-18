/**
 * #1797 — a promotion cannot date this node's own record ahead.
 *
 * `maySpeakFor` admits one claim about `selfAddress` from any sender: `up`
 * while this node is `joining` or `weakly-up` (`isOwnPromotion`).  #1104 made
 * that record keep everything this node owns except the status, but the
 * **version** was still taken as sent, bounded only by the #114 skew cap.  A
 * stranger could therefore date the node's own record up to
 * `maxVersionSkewMs` (5 min) ahead, the node gossiped it on as its own, and a
 * restart inside that window lost to the ghost: the new incarnation's seed
 * version sat below it.
 *
 * Pinned here: a promotion moves the record at most one step past what this
 * node holds — `withStatus`'s own step, which is all a genuine leader
 * promotion ever takes — and peers that learn the record from this node
 * converge on the clamped version.  A genuine promotion and the `weakly-up`
 * tie at equal versions still land.
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
import { awaitCondition } from '../../util/AwaitCondition.js';

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
};

/** The private surface these tests read — the member map and the wire entry point, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: GossipMessage): void;
  readonly members: Map<string, Member>;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

const FOUR_MINUTES_MS = 4 * 60_000;

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

type StartOptions = {
  readonly seeds?: string[];
  readonly gossipIntervalMs?: number;
  readonly weaklyUpAfterMs?: number;
  readonly checkedPaths?: string[];
};

async function startNode(systemName: string, port: number, options: StartOptions = {}): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, 'h', port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(options.seeds ?? [])
    .withTransport(new InMemoryTransport(address))
    // Nothing promotes a seedless node but the frames these tests send.
    .withSelfElection('never')
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 2_000, downAfterMs: 4_000 })
    .withGossipIntervalMs(options.gossipIntervalMs ?? 60_000);
  if (options.weaklyUpAfterMs !== undefined) clusterOptions.withWeaklyUpAfterMs(options.weaklyUpAfterMs);
  if (options.checkedPaths !== undefined) {
    clusterOptions.withConfigurationCompatibilityCheckedPaths(options.checkedPaths);
  }
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster, address };
  nodes.push(node);
  return node;
}

function gossipFrom(cluster: Cluster, from: NodeAddress, members: MemberData[]): void {
  internals(cluster).handleWire(from, {
    kind: 'gossip', from: from.toJSON(), sequence: Date.now(), members,
  });
}

function selfRecord(node: NodeHandle): Member {
  const self = internals(node.cluster).members.get(node.address.toString());
  if (self === undefined) throw new Error(`no self record on ${node.address}`);
  return self;
}

function promote(node: NodeHandle, version: number): void {
  const stranger = new NodeAddress(node.address.systemName, '10.0.179.7', 9_799);
  // The address as this node gossips it, incarnation included — what a
  // leader promoting from the node's own record would send.
  gossipFrom(node.cluster, stranger, [{
    address: selfRecord(node).address.toJSON(), status: 'up', version, roles: [],
  }]);
}

describe('#1797 — a promotion moves this node\'s version one step at most', () => {
  test('a stranger\'s promotion dated four minutes ahead lands at the local version + 1', async () => {
    const node = await startNode('own-promotion-version', 9_831);
    const before = selfRecord(node);
    expect(before.status).toBe('joining');

    promote(node, Date.now() + FOUR_MINUTES_MS);

    const after = selfRecord(node);
    expect(after.status).toBe('up');
    expect(after.version).toBe(before.version + 1);
  });

  test('a promotion that restates every field this node owns is clamped too', async () => {
    // No roles, no published facts or identities: the record differs from
    // what this node would build only in status and version, so the
    // substitution's no-change shortcut must still look at the version.
    const node = await startNode('own-promotion-restated', 9_836, { checkedPaths: [] });
    const before = selfRecord(node);
    promote(node, Date.now() + FOUR_MINUTES_MS);
    expect(selfRecord(node).status).toBe('up');
    expect(selfRecord(node).version).toBe(before.version + 1);
  });

  test('a promotion at exactly the next version is taken as sent', async () => {
    const node = await startNode('own-promotion-next', 9_832);
    const before = selfRecord(node);
    promote(node, before.version + 1);
    expect(selfRecord(node).status).toBe('up');
    expect(selfRecord(node).version).toBe(before.version + 1);
  });

  test('the weakly-up tie at an equal version still promotes', async () => {
    const node = await startNode('own-promotion-tie', 9_833, { weaklyUpAfterMs: 1 });
    await awaitCondition(() => selfRecord(node).status === 'weakly-up', {
      timeoutMs: 2_000, label: 'the node moves itself to weakly-up',
    });
    const weaklyUp = selfRecord(node);

    // The leader promoted from the `joining` record and reached the same
    // version the node's own `weakly-up` step did (#935).
    promote(node, weaklyUp.version);

    expect(selfRecord(node).status).toBe('up');
    expect(selfRecord(node).version).toBe(weaklyUp.version);
  });

  test('a peer that learns the record from this node converges on the clamped version', async () => {
    const systemName = 'own-promotion-converge';
    const target = await startNode(systemName, 9_834, { gossipIntervalMs: 40 });
    const seeded = selfRecord(target).version;
    promote(target, Date.now() + FOUR_MINUTES_MS);
    expect(selfRecord(target).version).toBe(seeded + 1);

    const peer = await startNode(systemName, 9_835, {
      seeds: [target.address.toString()], gossipIntervalMs: 40,
    });
    const targetIn = (viewer: NodeHandle): Member | undefined =>
      viewer.cluster.getMembers().find((member) => member.address.equals(target.address));
    await awaitCondition(
      () => targetIn(peer)?.status === 'up'
        && peer.cluster.getMembers().find((member) => member.address.equals(peer.address))?.status === 'up',
      { timeoutMs: 4_000, label: 'the peer joined and holds the target as up' },
    );

    expect(targetIn(peer)!.version).toBe(selfRecord(target).version);
    expect(targetIn(peer)!.version).toBe(seeded + 1);
  });
});
