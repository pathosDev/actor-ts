/**
 * #114 — a version far enough in the future does not merely win one merge, it
 * **pre-claims an address nobody has seen yet**.
 *
 * `maySpeakFor` (#562) lets any connection announce its *own* address, because
 * refusing that would mean no node could ever join, and without per-node
 * certificates the `hello` frame carries no credential to check it against
 * (#912).  So a stranger could name an address that is about to exist, date the
 * claim up to the 24 h skew cap ahead, attach the roles it wanted, and leave.
 * The leader's promotion loop then lifted the squat into the active set, and
 * the real node's own record — versioned from its own clock, therefore lower —
 * lost every subsequent merge.
 *
 * The cap that closes it applies to **every** gossiped member version, not only
 * to the record that introduces an address: the narrower reading could be
 * stepped around by introducing the address first (see
 * `GossipMergeCapBypasses.test.ts`).  These tests pin the cap itself, and the
 * counterfactual: widened back to 24 h, the squat still wins.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions, ClusterOptionsValidator } from '../../../src/cluster/ClusterOptions.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { GossipMessage, MemberData, MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';

const MINUTE_MS = 60 * 1_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
};

/**
 * A one-node cluster with every timer pushed far out.  The tests drive the
 * merge by injecting frames, so a background gossip or failure-detector tick
 * would only add nondeterminism.  With no seeds the node elects itself `up`
 * during `join`, which also makes it the leader — the promotion loop that
 * turns a squatted `joining` record into an `up` one is part of what is
 * under test.
 */
async function startNode(
  systemName: string,
  port: number,
  maxVersionSkewMs?: number,
): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, '10.0.114.1', port);
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
      unreachableAfterMs: 120_000,
      downAfterMs: 240_000,
    })
    .withGossipIntervalMs(60_000);
  if (maxVersionSkewMs !== undefined) {
    clusterOptions.withMaxVersionSkewMs(maxVersionSkewMs);
  }
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster, address };
}

/** The private surface these tests reach through — merge internals, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: GossipMessage): void;
  mergeMember(from: NodeAddress, senderStatus: MemberStatus | undefined, data: MemberData): void;
  readonly members: Map<string, Member>;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

/**
 * Gossip frames carry a monotonic per-sender `sequence` since #112, and a
 * receiver refuses one that does not out-number the last it accepted from that
 * peer — so the helper stamps a fresh number for every frame it injects.
 */
let gossipSequence = 0;

/** Deliver a gossip frame as if it arrived on a connection owned by `from`. */
function gossipFrom(cluster: Cluster, from: NodeAddress, members: MemberData[]): void {
  // A minute ahead of the clock: a live node seeds its own counter from
  // `Date.now()` and adds one per frame, so a plain `Date.now()` can land just
  // below it.  Still well inside `maxVersionSkewMs`.
  gossipSequence = Math.max(gossipSequence + 1, Date.now() + 60_000);
  internals(cluster).handleWire(from, {
    kind: 'gossip', from: from.toJSON(), sequence: gossipSequence, members,
  });
}

/** Merge a single record as a sender the cluster already considers active. */
function mergeAsActivePeer(cluster: Cluster, sender: NodeAddress, data: MemberData): void {
  internals(cluster).mergeMember(sender, 'up', data);
}

function memberIn(cluster: Cluster, address: NodeAddress): Member | undefined {
  return internals(cluster).members.get(address.toString());
}

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

describe('the gossip version-skew cap (#114)', () => {
  test('a stranger cannot pre-claim an address with a far-future version', async () => {
    const node = await startNode('skew-squat', 9_101);
    nodes.push(node);

    // An address that does not exist yet — the next pod of a StatefulSet, a
    // node being replaced.  The attacker announces *itself* under it, which
    // is the one claim `maySpeakFor` never refuses, and dates it an hour
    // ahead: comfortably inside the 24 h cap that guards every other merge.
    const claimed = new NodeAddress('skew-squat', '10.0.114.9', 9_190);
    const squattedVersion = Date.now() + 60 * MINUTE_MS;
    gossipFrom(node.cluster, claimed, [{
      address: claimed.toJSON(),
      status: 'joining',
      version: squattedVersion,
      roles: ['shard-host', 'singleton-host'],
    }]);

    // The address does turn up: `onGossip` records any sender it does not
    // already know.  What it does not get is anything the frame asked for —
    // no roles, and a version the real owner can beat with its own clock.
    const stored = memberIn(node.cluster, claimed);
    expect(stored).toBeDefined();
    expect(Array.from(stored!.roles)).toEqual([]);
    expect(stored!.version).toBeLessThan(Date.now());
  });

  test('the real owner of the address still wins it, roles and all', async () => {
    const node = await startNode('skew-owner', 9_102);
    nodes.push(node);
    const claimed = new NodeAddress('skew-owner', '10.0.114.9', 9_190);

    gossipFrom(node.cluster, claimed, [{
      address: claimed.toJSON(),
      status: 'joining',
      version: Date.now() + 60 * MINUTE_MS,
      roles: ['shard-host', 'singleton-host'],
    }]);

    // The node that really owns the address starts and announces itself the
    // ordinary way — version seeded from its own wall-clock.
    const ownVersion = Date.now();
    gossipFrom(node.cluster, claimed, [{
      address: claimed.toJSON(),
      status: 'joining',
      version: ownVersion,
      roles: ['worker'],
    }]);

    const stored = memberIn(node.cluster, claimed);
    expect(Array.from(stored!.roles)).toEqual(['worker']);
    // Leader promotion bumps the version by one on top of the merged record.
    expect(stored!.version).toBeGreaterThanOrEqual(ownVersion);
    expect(stored!.status).toBe('up');
  });

  test('widened back to 24 h, the squat wins and the owner never lands', async () => {
    // The counterfactual, and the reason the default is what it is: with a
    // single generous cap this is exactly the pre-fix behaviour.
    const node = await startNode('skew-widened', 9_103, DAY_MS);
    nodes.push(node);
    const claimed = new NodeAddress('skew-widened', '10.0.114.9', 9_190);

    gossipFrom(node.cluster, claimed, [{
      address: claimed.toJSON(),
      status: 'joining',
      version: Date.now() + 60 * MINUTE_MS,
      roles: ['shard-host', 'singleton-host'],
    }]);
    gossipFrom(node.cluster, claimed, [{
      address: claimed.toJSON(),
      status: 'joining',
      version: Date.now(),
      roles: ['worker'],
    }]);

    const stored = memberIn(node.cluster, claimed);
    expect(Array.from(stored!.roles)).toEqual(['shard-host', 'singleton-host']);
    // And the leader has already lifted the phantom into the active set.
    expect(stored!.status).toBe('up');
    expect(node.cluster.upMembersWithRole('singleton-host')).toHaveLength(1);
  });

  test('a first sighting inside the cap is accepted verbatim', async () => {
    // The regression side: an ordinary join carries a version a hair ahead of
    // the receiver's clock, and must arrive with its roles intact.
    const node = await startNode('skew-ordinary', 9_104);
    nodes.push(node);
    const peer = new NodeAddress('skew-ordinary', '10.0.114.9', 9_190);
    const version = Date.now() + 1_000;

    gossipFrom(node.cluster, peer, [{
      address: peer.toJSON(),
      status: 'joining',
      version,
      roles: ['worker'],
    }]);

    const stored = memberIn(node.cluster, peer);
    expect(Array.from(stored!.roles)).toEqual(['worker']);
    expect(stored!.version).toBeGreaterThanOrEqual(version);
  });

  test('an address already on file is held to the same cap', async () => {
    // The cap used to stop at the branch that *creates* a record, on the
    // reasoning that refusing an update freezes a member the cluster is using.
    // That split is what made it walk-around-able: an attacker introduces the
    // address itself and then updates it.  So an update carries the same
    // budget, and a relay cannot pre-date a third party's record either.
    const node = await startNode('skew-existing', 9_105);
    nodes.push(node);
    const relay = new NodeAddress('skew-existing', '10.0.114.8', 9_180);
    const subject = new NodeAddress('skew-existing', '10.0.114.9', 9_190);

    const ownVersion = Date.now();
    mergeAsActivePeer(node.cluster, relay, {
      address: subject.toJSON(),
      status: 'joining',
      version: ownVersion,
      roles: ['worker'],
    });

    mergeAsActivePeer(node.cluster, relay, {
      address: subject.toJSON(),
      status: 'up',
      version: Date.now() + 60 * MINUTE_MS,
      roles: ['worker'],
    });

    expect(memberIn(node.cluster, subject)!.version).toBeLessThan(Date.now() + MINUTE_MS);
  });

  test('an update inside the cap merges as before', async () => {
    // The regression side: the cap must be invisible to a member whose clock
    // is merely a hair ahead, which is every real one.
    const node = await startNode('skew-ordinary-update', 9_107);
    nodes.push(node);
    const relay = new NodeAddress('skew-ordinary-update', '10.0.114.8', 9_180);
    const subject = new NodeAddress('skew-ordinary-update', '10.0.114.9', 9_190);

    mergeAsActivePeer(node.cluster, relay, {
      address: subject.toJSON(),
      status: 'joining',
      version: Date.now(),
      roles: ['worker'],
    });
    const laterVersion = Date.now() + MINUTE_MS;
    mergeAsActivePeer(node.cluster, relay, {
      address: subject.toJSON(),
      status: 'leaving',
      version: laterVersion,
      roles: ['worker'],
    });

    expect(memberIn(node.cluster, subject)!.status).toBe('leaving');
    expect(memberIn(node.cluster, subject)!.version).toBe(laterVersion);
  });

  test('the cap is per node, for deployments whose clocks run loose', async () => {
    const node = await startNode('skew-tuned', 9_106, 30 * MINUTE_MS);
    nodes.push(node);
    const peer = new NodeAddress('skew-tuned', '10.0.114.9', 9_190);
    // Ten minutes ahead: refused at the default, admitted here.
    const version = Date.now() + 10 * MINUTE_MS;

    gossipFrom(node.cluster, peer, [{
      address: peer.toJSON(),
      status: 'joining',
      version,
      roles: ['worker'],
    }]);

    expect(Array.from(memberIn(node.cluster, peer)!.roles)).toEqual(['worker']);
  });
});

describe('ClusterOptionsValidator — maxVersionSkewMs', () => {
  const validate = (maxVersionSkewMs: number): void => {
    new ClusterOptionsValidator().validate({
      host: '10.0.114.1',
      port: 2_552,
      maxVersionSkewMs,
    });
  };

  test('a positive number of milliseconds passes', () => {
    expect(() => validate(30 * MINUTE_MS)).not.toThrow();
  });

  test('zero and negatives are refused — there is no off switch', () => {
    expect(() => validate(0)).toThrow(/maxVersionSkewMs/);
    expect(() => validate(-1)).toThrow(/maxVersionSkewMs/);
  });

  test('leaving it unset passes — it falls through to the built-in default', () => {
    expect(() => new ClusterOptionsValidator().validate({ host: '10.0.114.1', port: 2_552 }))
      .not.toThrow();
  });
});
