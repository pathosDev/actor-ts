/**
 * #1104 — a promotion lifts this node's status and nothing else.
 *
 * `maySpeakFor` refuses every claim about `selfAddress` but one: `up` while
 * this node is `joining` or `weakly-up`, because a node cannot promote itself
 * and the leader's decision has to arrive from outside.  The exception asks
 * nothing of the sender, so while a node is joining, a single gossip frame
 * from an address it has never heard of reaches its own record.  Before the
 * fix that record was then merged wholesale, so the stranger also chose the
 * node's **roles** — what shard placement, singleton hosting, routing and
 * downing quorums are computed from — and the node gossiped them onward as
 * its own:
 *
 *     self before: joining ["worker"]
 *     self after : up      ["shard-host","singleton-host"]
 *
 * Pinned here: the frame from the issue still promotes (refusing it would not
 * help — see below) but leaves the roles alone, in the member map, in what
 * `selfMember()` and the `MemberUp` event report and in what the node gossips;
 * and a genuine leader promotion between two real nodes still arrives with
 * the joiner's roles intact.
 *
 * Why the promotion is not refused for a sender without standing: the sender
 * of the frame that carries a joiner's promotion is routinely one the joiner
 * has not merged yet, and the one thing a stranger can always do is announce
 * *itself* as `up` (`subject.equals(from)`), which would grant it that standing
 * one frame later.  A standing rule would delay legitimate promotions and stop
 * no attacker.  What keeps the forged promotion cheap is that the status is
 * the one field of this node's own it can set — a node that is `joining` is
 * already trying to become `up`.  The roles, `removedAt`, the store identities
 * and the configuration facts are taken from what this node itself knows, and
 * a node that knows none of the last two carries none rather than the
 * stranger's.
 *
 * Not pinned here, and not closed: the record's **version** is still taken as
 * sent, bounded only by the #114 skew cap (`maxVersionSkewMs`), so a stranger
 * can push this node's version up to that bound.  Clamping it is tracked in
 * #1797.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { MemberUp, type ClusterEvent } from '../../../src/cluster/ClusterEvents.js';
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

/** The private surface these tests read — the member map and the gossip encoder, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: GossipMessage): void;
  memberDataForGossip(member: Member): MemberData;
  readonly members: Map<string, Member>;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

function quietSystem(systemName: string): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(systemName, systemOptions);
}

/**
 * The issue's setup: `roles: ['worker']`, `selfElection: 'never'` and no
 * seeds, so nothing promotes the node and it stays in `joining` — the window
 * the exception is open in.
 */
async function startJoiningNode(
  systemName: string,
  port: number,
  checkedPaths?: ReadonlyArray<string>,
): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, '10.0.110.1', port);
  const system = quietSystem(systemName);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withRoles(['worker'])
    .withTransport(new InMemoryTransport(address))
    .withSelfElection('never')
    .withFailureDetector({
      heartbeatIntervalMs: 60_000, unreachableAfterMs: 120_000, downAfterMs: 240_000,
    })
    .withGossipIntervalMs(60_000);
  if (checkedPaths !== undefined) {
    clusterOptions.withConfigurationCompatibilityCheckedPaths([...checkedPaths]);
  }
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster, address };
  nodes.push(node);
  return node;
}

/** Deliver a gossip frame with a fresh, plausible sequence, as a peer would. */
function gossipFrom(cluster: Cluster, from: NodeAddress, members: MemberData[]): void {
  internals(cluster).handleWire(from, {
    kind: 'gossip', from: from.toJSON(), sequence: Date.now(), members,
  });
}

function selfRecord(node: NodeHandle): Member | undefined {
  return internals(node.cluster).members.get(node.address.toString());
}

describe('#1104 — a stranger\'s promotion cannot choose this node\'s roles', () => {
  test('the frame from the issue promotes the node and leaves its roles alone', async () => {
    const node = await startJoiningNode('own-promotion-roles', 9_811);
    expect(selfRecord(node)?.status).toBe('joining');
    expect([...selfRecord(node)!.roles]).toEqual(['worker']);

    const events: ClusterEvent[] = [];
    const unsubscribe = node.cluster.subscribe((event) => events.push(event));

    const stranger = new NodeAddress('own-promotion-roles', '10.0.110.66', 9_866);
    gossipFrom(node.cluster, stranger, [{
      address: node.address.toJSON(),
      status: 'up',
      version: Date.now() + 1_000,
      roles: ['shard-host', 'singleton-host'],
    }]);
    unsubscribe();

    const self = selfRecord(node);
    // Still a promotion: refusing it would buy nothing (see the file header).
    expect(self?.status).toBe('up');
    expect([...self!.roles]).toEqual(['worker']);
    // Every surface that reports the record agrees with the map.
    expect([...node.cluster.selfMember()!.roles]).toEqual(['worker']);
    const up = events.find((event): event is MemberUp => event instanceof MemberUp);
    expect(up).toBeDefined();
    expect([...up!.member.roles]).toEqual(['worker']);
    // And the node does not pass the stranger's set on.
    expect(internals(node.cluster).memberDataForGossip(self!).roles).toEqual(['worker']);
  });

  test('a promotion carrying no roles does not strip the node\'s own', async () => {
    // The blanking shape of the same thing — and what a relay that dropped the
    // field would send.
    const node = await startJoiningNode('own-promotion-blank', 9_812);
    const stranger = new NodeAddress('own-promotion-blank', '10.0.110.66', 9_866);
    gossipFrom(node.cluster, stranger, [{
      address: node.address.toJSON(), status: 'up', version: Date.now() + 1_000, roles: [],
    }]);
    expect(selfRecord(node)?.status).toBe('up');
    expect([...selfRecord(node)!.roles]).toEqual(['worker']);
  });

  test('a promotion cannot set a tombstone timestamp on the node\'s own record', async () => {
    const node = await startJoiningNode('own-promotion-removed-at', 9_813);
    const stranger = new NodeAddress('own-promotion-removed-at', '10.0.110.66', 9_866);
    gossipFrom(node.cluster, stranger, [{
      address: node.address.toJSON(),
      status: 'up',
      version: Date.now() + 1_000,
      roles: ['worker'],
      removedAt: Date.now(),
    }]);
    expect(selfRecord(node)?.status).toBe('up');
    expect(selfRecord(node)?.removedAt).toBeUndefined();
  });
});

describe('#1104 — a stranger\'s promotion cannot name this node\'s stores or settings', () => {
  // `withLocalSelfIdentity` used to fall back to the promotion's claims when
  // this node had none of its own.  A node with no persistence then stored a
  // stranger's journal as its own and gossiped it onward, and a peer with a
  // real journal spent its once-per-kind mismatch report on that fiction.

  test('a node that resolved no store identities does not adopt the promotion\'s', async () => {
    const node = await startJoiningNode('own-promotion-identities', 9_814);
    expect(selfRecord(node)?.storageIdentities).toBeUndefined();

    const stranger = new NodeAddress('own-promotion-identities', '10.0.110.66', 9_866);
    gossipFrom(node.cluster, stranger, [{
      address: node.address.toJSON(),
      status: 'up',
      version: Date.now() + 1_000,
      roles: ['worker'],
      storageIdentities: { journal: 'postgres://evil/journal' },
    }]);

    const self = selfRecord(node);
    expect(self?.status).toBe('up');
    expect(self?.storageIdentities).toBeUndefined();
    expect(node.cluster.selfMember()?.storageIdentities).toBeUndefined();
    // What matters to every peer: the node does not state the stranger's journal.
    expect(internals(node.cluster).memberDataForGossip(self!).storageIdentities).toBeUndefined();
  });

  test('a node that has published an identity keeps it over the promotion\'s (#1358)', async () => {
    // The case the old `??` fallback was written for, still held without it:
    // what this node published wins, whatever the promotion says.
    const node = await startJoiningNode('own-promotion-identities-held', 9_815);
    node.cluster.publishStorageIdentity('journal', 'postgres://ours/journal');

    const stranger = new NodeAddress('own-promotion-identities-held', '10.0.110.66', 9_866);
    gossipFrom(node.cluster, stranger, [{
      address: node.address.toJSON(),
      status: 'up',
      version: Date.now() + 1_000,
      roles: ['worker'],
      storageIdentities: { journal: 'postgres://evil/journal', snapshotStore: 'postgres://evil/snapshots' },
    }]);

    const self = selfRecord(node);
    expect(self?.status).toBe('up');
    expect(self?.storageIdentities).toEqual({ journal: 'postgres://ours/journal' });
    expect(internals(node.cluster).memberDataForGossip(self!).storageIdentities)
      .toEqual({ journal: 'postgres://ours/journal' });
  });

  test('a node that publishes no configuration facts does not adopt the promotion\'s', async () => {
    // `checked-paths` empty: the constructor publishes nothing, which is the
    // one state in which the old fallback reached the facts at all.
    const node = await startJoiningNode('own-promotion-facts', 9_816, []);
    expect(internals(node.cluster).memberDataForGossip(selfRecord(node)!).configurationFacts).toBeUndefined();

    const stranger = new NodeAddress('own-promotion-facts', '10.0.110.66', 9_866);
    gossipFrom(node.cluster, stranger, [{
      address: node.address.toJSON(),
      status: 'up',
      version: Date.now() + 1_000,
      roles: ['worker'],
      configurationFacts: { 'actor-ts.remote.max-frame-bytes': '1' },
    }]);

    const self = selfRecord(node);
    expect(self?.status).toBe('up');
    expect(self?.configurationFacts).toBeUndefined();
    expect(internals(node.cluster).memberDataForGossip(self!).configurationFacts).toBeUndefined();
  });
});

describe('#1104 — a genuine leader promotion still arrives', () => {
  test('a joiner with roles reaches up through the leader, its roles intact in both views', async () => {
    const systemName = 'own-promotion-leader';
    const start = async (port: number, roles: string[], seeds: string[]): Promise<NodeHandle> => {
      const address = new NodeAddress(systemName, 'h', port);
      const system = quietSystem(systemName);
      const clusterOptions = ClusterOptions.create()
        .withHost('h')
        .withPort(port)
        .withRoles(roles)
        .withSeeds(seeds)
        .withTransport(new InMemoryTransport(address))
        .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 2_000, downAfterMs: 4_000 })
        .withGossipIntervalMs(40);
      const cluster = await Cluster.join(system, clusterOptions);
      const node = { system, cluster, address };
      nodes.push(node);
      return node;
    };
    const leader = await start(9_821, ['seed'], []);
    const joiner = await start(9_822, ['worker', 'shard-host'], [leader.address.toString()]);

    const joinerIn = (viewer: NodeHandle): Member | undefined =>
      viewer.cluster.getMembers().find((member) => member.address.equals(joiner.address));
    await awaitCondition(
      () => joinerIn(joiner)?.status === 'up' && joinerIn(leader)?.status === 'up',
      { timeoutMs: 4_000, label: 'the joiner is up in its own view and in the leader\'s' },
    );

    expect(new Set(joinerIn(joiner)!.roles)).toEqual(new Set(['worker', 'shard-host']));
    expect(new Set(joinerIn(leader)!.roles)).toEqual(new Set(['worker', 'shard-host']));
  });
});
