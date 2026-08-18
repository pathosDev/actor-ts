/**
 * #940 — the incarnation identifier on `NodeAddress`.
 *
 * `system@host:port` names a *slot*, not a process.  A pod that restarts onto
 * the same address is a different process wearing the same name, and every rule
 * the cluster has about members is written against the slot — which is why "the
 * node that used to be here" and "the node that is here now" cannot currently
 * be told apart.
 *
 * What is pinned here is the identifier and nothing else, because that is
 * deliberately all that landed:
 *
 * - it exists, and a second run at the same `host:port` gets a different one;
 * - it is **not** part of a node's identity — `toString`, `equals` and
 *   `compareTo` ignore it, so every map keyed on the string form, the leader's
 *   lexicographic order and `RefCodec`'s local-vs-remote test are untouched;
 * - it rides the wire, is bounded on arrival, and is **optional** there, so a
 *   peer that predates the field is still understood in both directions;
 * - the one comparison that needs no distributed agreement is made: a peer
 *   cannot restate *this* node's own incarnation.
 *
 * What is deliberately **not** here is any merge rule keyed on a mismatch.  An
 * optional field is bypassed by stripping it, so such a rule would be one an
 * attacker opts out of and a legitimate old peer walks into.  Requiring the
 * field is a wire break across all eight address-bearing frame fields and waits
 * on #823.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { MAX_NODE_INCARNATION_LENGTH } from '../../../src/cluster/Constants.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress, type NodeAddressData } from '../../../src/cluster/NodeAddress.js';
import type { GossipMessage, MemberData } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { isNodeAddressData, wireFrameProblem } from '../../../src/cluster/WireValidation.js';

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
};

/** The private surface these tests read — the member map, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: GossipMessage): void;
  readonly members: Map<string, Member>;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

/**
 * A node that stays in `joining`: `selfElection: 'never'` and no seeds, so
 * nothing promotes it and a peer's `up` claim about it is the one claim
 * `maySpeakFor` lets through (`isOwnPromotion`).
 */
async function startJoiningNode(systemName: string, port: number): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, '10.0.94.1', port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withSelfElection('never')
    .withFailureDetector({
      heartbeatIntervalMs: 60_000, unreachableAfterMs: 120_000, downAfterMs: 240_000,
    })
    .withGossipIntervalMs(60_000);
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster, address };
}

/** Deliver a gossip frame with a fresh, plausible sequence, as a peer would. */
function gossipFrom(
  cluster: Cluster, from: NodeAddress, sequence: number, members: MemberData[],
): void {
  internals(cluster).handleWire(from, {
    kind: 'gossip', from: from.toJSON(), sequence, members,
  });
}

function addressData(overrides: Partial<NodeAddressData> = {}): NodeAddressData {
  return { systemName: 'wire', host: '10.0.94.9', port: 30_000, ...overrides };
}

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

describe('an address says which process is answering at it', () => {
  test('two minted incarnations differ', () => {
    // The whole property, at the primitive: a restart must not be able to
    // inherit the identifier of the process it replaced.
    const drawn = new Set<string>();
    for (let draw = 0; draw < 100; draw++) drawn.add(NodeAddress.mintIncarnation());
    expect(drawn.size).toBe(100);
  });

  test('a second Cluster.join on the same host and port gets a different one', async () => {
    // Sequential rather than concurrent on purpose: this is the restart, which
    // is the case the identifier exists for.
    const first = await startJoiningNode('incarnation-restart', 9_601);
    const firstIncarnation = first.cluster.selfAddress.incarnation;
    expect(firstIncarnation).toBeString();
    expect(firstIncarnation!.length).toBeGreaterThan(0);
    await first.cluster.leave();
    await first.system.terminate();

    const second = await startJoiningNode('incarnation-restart', 9_601);
    nodes.push(second);

    expect(second.cluster.selfAddress.toString()).toBe(first.cluster.selfAddress.toString());
    expect(second.cluster.selfAddress.incarnation).not.toBe(firstIncarnation);
  });

  test('the self member record carries it, and so does the frame built from it', async () => {
    const node = await startJoiningNode('incarnation-self', 9_602);
    nodes.push(node);

    const self = internals(node.cluster).members.get(node.address.toString());
    expect(self?.address.incarnation).toBe(node.cluster.selfAddress.incarnation);
    // `gossipTick` serialises exactly this, so it is what a peer receives.
    expect(self?.toData().address.incarnation).toBe(node.cluster.selfAddress.incarnation);
  });
});

describe('the incarnation is not part of a node identity', () => {
  const base = new NodeAddress('identity', '10.0.94.2', 9_690);
  const sameSlot = new NodeAddress('identity', '10.0.94.2', 9_690, NodeAddress.mintIncarnation());
  const otherSlot = new NodeAddress('identity', '10.0.94.2', 9_691, NodeAddress.mintIncarnation());

  test('toString, equals and compareTo ignore it', () => {
    // Everything downstream is keyed on the string form: `Cluster.members` and
    // its siblings, `TcpTransport.byPeer`, `RefCodec`'s local-vs-remote test,
    // and the leader's lexicographic order.  Folding the incarnation in would
    // make two views of one node two nodes.
    expect(sameSlot.toString()).toBe(base.toString());
    expect(sameSlot.equals(base)).toBe(true);
    expect(base.equals(sameSlot)).toBe(true);
    expect(sameSlot.compareTo(base)).toBe(0);
    // …and it does not accidentally make two different slots equal either.
    expect(otherSlot.equals(base)).toBe(false);
  });

  test('the member map is reachable with an incarnation-free address', async () => {
    const node = await startJoiningNode('incarnation-key', 9_603);
    nodes.push(node);

    const plain = new NodeAddress('incarnation-key', node.address.host, 9_603);
    expect(plain.incarnation).toBeUndefined();
    expect(internals(node.cluster).members.has(plain.toString())).toBe(true);
  });

  test('a seed string cannot carry one', () => {
    // `parse` is what a seed list, a `SeedProvider` and an operator's config go
    // through, and none of them knows which process is answering.
    expect(NodeAddress.parse('seeds@10.0.94.3:2552').incarnation).toBeUndefined();
  });
});

describe('it rides the wire, bounded, and optional in both directions', () => {
  test('toJSON omits it when unset and carries it when set', () => {
    expect(new NodeAddress('wire', 'h', 1).toJSON()).toEqual({
      systemName: 'wire', host: 'h', port: 1,
    });
    expect(new NodeAddress('wire', 'h', 1, 'abc').toJSON()).toEqual({
      systemName: 'wire', host: 'h', port: 1, incarnation: 'abc',
    });
  });

  test('fromJSON round-trips it, and accepts a peer that sends none', () => {
    const carried = NodeAddress.fromJSON(addressData({ incarnation: 'a-b-c' }));
    expect(carried.incarnation).toBe('a-b-c');
    // The mixed-version direction: a peer predating the field is understood.
    expect(NodeAddress.fromJSON(addressData()).incarnation).toBeUndefined();
  });

  test('fromJSON refuses a malformed incarnation rather than coercing it', () => {
    expect(() => NodeAddress.fromJSON(addressData({ incarnation: '' })))
      .toThrow(/Invalid node address/);
    expect(() => NodeAddress.fromJSON(
      addressData({ incarnation: 'x'.repeat(MAX_NODE_INCARNATION_LENGTH + 1) }),
    )).toThrow(/Invalid node address/);
    expect(() => NodeAddress.fromJSON(
      addressData({ incarnation: 42 as unknown as string }),
    )).toThrow(/Invalid node address/);
  });

  test('the decode guard holds it to a length, and lets an absent one through', () => {
    expect(isNodeAddressData(addressData())).toBe(true);
    expect(isNodeAddressData(addressData({ incarnation: 'ok' }))).toBe(true);
    expect(isNodeAddressData(
      addressData({ incarnation: 'x'.repeat(MAX_NODE_INCARNATION_LENGTH) }),
    )).toBe(true);
    // An address rides on every member record of every frame, so an unbounded
    // one is retained per member and re-gossiped to every peer.
    expect(isNodeAddressData(
      addressData({ incarnation: 'x'.repeat(MAX_NODE_INCARNATION_LENGTH + 1) }),
    )).toBe(false);
    expect(isNodeAddressData(addressData({ incarnation: '' }))).toBe(false);
    expect(isNodeAddressData(addressData({ incarnation: {} as unknown as string }))).toBe(false);
  });

  test('a frame whose member address carries a bad incarnation is refused whole', () => {
    // `isNodeAddressData` is the single gate for all eight address-bearing wire
    // fields, so the bound reaches every one of them through this one guard.
    const good: MemberData = {
      address: addressData({ incarnation: 'fine' }), status: 'up', version: 1, roles: [],
    };
    const bad: MemberData = {
      address: addressData({ port: 30_001, incarnation: 'x'.repeat(MAX_NODE_INCARNATION_LENGTH + 1) }),
      status: 'up',
      version: 1,
      roles: [],
    };
    expect(wireFrameProblem({
      kind: 'gossip', from: addressData(), sequence: Date.now(), members: [good],
    } as unknown as { kind: string })).toBeNull();
    expect(wireFrameProblem({
      kind: 'gossip', from: addressData(), sequence: Date.now(), members: [good, bad],
    } as unknown as { kind: string })).toContain('member[1]');
    expect(wireFrameProblem({
      kind: 'hello', self: addressData({ incarnation: '' }),
    } as unknown as { kind: string })).toContain('`self`');
  });

  test('a gossiped peer incarnation survives the merge and is re-gossiped', async () => {
    const node = await startJoiningNode('incarnation-merge', 9_604);
    nodes.push(node);
    const peer = new NodeAddress('incarnation-merge', '10.0.94.2', 9_690, 'peer-run-one');

    gossipFrom(node.cluster, peer, Date.now(), [
      { address: peer.toJSON(), status: 'up', version: Date.now(), roles: ['payments'] },
    ]);

    const stored = internals(node.cluster).members.get(peer.toString());
    expect(stored?.address.incarnation).toBe('peer-run-one');
    expect(stored?.toData().address.incarnation).toBe('peer-run-one');
  });
});

describe('a peer cannot restate this node own incarnation', () => {
  test('a promotion carrying a forged incarnation lands, with the local one kept', async () => {
    // `maySpeakFor` lets exactly one claim about self through — the leader's
    // promotion out of `joining` — and it is merged wholesale, address included.
    // The three fields the string form is built from had to match for the record
    // to be about this node at all; the incarnation did not, so before the fix
    // the self record's identifier was whatever the last peer to promote us
    // happened to say.
    const node = await startJoiningNode('incarnation-promote', 9_605);
    nodes.push(node);
    const selfKey = node.address.toString();
    const localIncarnation = node.cluster.selfAddress.incarnation;
    expect(internals(node.cluster).members.get(selfKey)?.status).toBe('joining');

    const leader = new NodeAddress('incarnation-promote', '10.0.94.2', 9_690);
    gossipFrom(node.cluster, leader, Date.now(), [{
      address: { systemName: 'incarnation-promote', host: node.address.host, port: 9_605,
        incarnation: 'forged-by-a-peer' },
      status: 'up',
      version: Date.now() + 10_000,
      roles: ['payments'],
    }]);

    const self = internals(node.cluster).members.get(selfKey);
    // The promotion still lands — substituting the address is not a refusal, and
    // a node joining a cluster whose leader predates the field must still reach
    // `up`.
    expect(self?.status).toBe('up');
    expect(self?.address.incarnation).toBe(localIncarnation);
    expect(self?.toData().address.incarnation).toBe(localIncarnation);
  });

  test('a promotion that blanks the incarnation does not blank the local one', async () => {
    // The mixed-version shape of the same thing: a leader running the previous
    // version sends no incarnation at all.
    const node = await startJoiningNode('incarnation-blank', 9_606);
    nodes.push(node);
    const selfKey = node.address.toString();
    const localIncarnation = node.cluster.selfAddress.incarnation;

    const leader = new NodeAddress('incarnation-blank', '10.0.94.2', 9_690);
    gossipFrom(node.cluster, leader, Date.now(), [{
      address: { systemName: 'incarnation-blank', host: node.address.host, port: 9_606 },
      status: 'up',
      version: Date.now() + 10_000,
      roles: [],
    }]);

    const self = internals(node.cluster).members.get(selfKey);
    expect(self?.status).toBe('up');
    expect(self?.address.incarnation).toBe(localIncarnation);
  });
});
