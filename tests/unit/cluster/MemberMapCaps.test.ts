/**
 * #138 — the member map was unbounded, and both paths that create an entry
 * from gossip set unconditionally.
 *
 * The guards in front of the merge all answer *"is this claim believable?"*
 * `maySpeakFor` waves a self-announcement through by design (refusing it would
 * mean no node could ever join), and an active peer may assert third-party
 * records.  Nothing answered *"how many believable claims may one peer make?"*
 *
 * Two caps now do, and the split between them is the point.  A phantom in an
 * active status is a member the failure detector is watching, so it is downed
 * and deleted `downAfterMs` after the attacker stops feeding it — seconds, at
 * the default.  A record gossiped as `removed` is not watched by anything, so
 * only `tombstoneTtlMs` reclaims it, a day later.  The tombstone cap is
 * therefore the load-bearing one, which is the opposite of how the issue
 * ranked the two.
 *
 * Both caps are charged on the **bucket a record moves into**, not on record
 * creation.  Charging only creation left the two caps trading headroom for
 * free — a tombstone re-incarnated as `up` vacated the tombstone bucket
 * without giving up a map slot — so alternating floods grew the map past both
 * while respecting each at every individual step.
 *
 * The tests drive the merge directly rather than through a running cluster:
 * the interesting property is what the map holds after N records, and a
 * background gossip or failure-detector tick would only add nondeterminism.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  Cluster,
  DEFAULT_MAX_MEMBERS,
  DEFAULT_MAX_TOMBSTONES,
} from '../../../src/cluster/Cluster.js';
import { ClusterOptions, ClusterOptionsValidator } from '../../../src/cluster/ClusterOptions.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberData, MemberStatus, WireMessage } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';

type CapOptions = {
  readonly maxMembers?: number;
  readonly maxTombstones?: number;
  readonly tombstoneTtlMs?: number;
  readonly tombstoneMinRetentionMs?: number;
};

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
};

const HOST = '10.0.138.1';

/**
 * A one-node cluster with every timer pushed far out — the tests inject the
 * frames themselves.  With no seeds the node elects itself `up`, so it holds
 * exactly one live member before anything arrives.
 */
async function startNode(systemName: string, port: number, caps: CapOptions = {}): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, HOST, port);
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
    .withGossipIntervalMs(60_000)
    .withTombstonePruneIntervalMs(60_000);
  if (caps.maxMembers !== undefined) clusterOptions.withMaxMembers(caps.maxMembers);
  if (caps.maxTombstones !== undefined) clusterOptions.withMaxTombstones(caps.maxTombstones);
  if (caps.tombstoneTtlMs !== undefined) clusterOptions.withTombstoneTtlMs(caps.tombstoneTtlMs);
  if (caps.tombstoneMinRetentionMs !== undefined) {
    clusterOptions.withTombstoneMinRetentionMs(caps.tombstoneMinRetentionMs);
  }
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster, address };
}

/** The private surface these tests reach through — merge internals, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: WireMessage): void;
  mergeMember(from: NodeAddress, senderStatus: MemberStatus | undefined, data: MemberData): void;
  tombstonePruneTick(): void;
  readonly members: Map<string, Member>;
  readonly tombstoneCount: number;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

function membersOf(cluster: Cluster): Map<string, Member> {
  return internals(cluster).members;
}

function tombstonesIn(cluster: Cluster): number {
  return Array.from(membersOf(cluster).values()).filter((m) => m.status === 'removed').length;
}

function liveIn(cluster: Cluster): number {
  return Array.from(membersOf(cluster).values()).filter((m) => m.status !== 'removed').length;
}

/** A record for an address the node has never seen, as a peer would gossip it. */
function recordFor(systemName: string, index: number, status: MemberStatus): MemberData {
  const address = new NodeAddress(systemName, '10.0.138.99', 20_000 + index);
  const data: MemberData = { address: address.toJSON(), status, version: Date.now(), roles: [] };
  return status === 'removed' ? { ...data, removedAt: Date.now() } : data;
}

/** Merge `count` fresh records as a sender the cluster already considers active. */
function floodAsActivePeer(
  cluster: Cluster,
  sender: NodeAddress,
  status: MemberStatus,
  count: number,
  offset = 0,
): void {
  for (let i = 0; i < count; i++) {
    internals(cluster).mergeMember(sender, 'up', recordFor(sender.systemName, offset + i, status));
  }
}

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

describe('the member-map caps (#138)', () => {
  test('an active peer cannot flood the map past maxMembers', async () => {
    const node = await startNode('cap-live', 9_201, { maxMembers: 5 });
    nodes.push(node);
    const peer = new NodeAddress('cap-live', '10.0.138.2', 9_290);

    floodAsActivePeer(node.cluster, peer, 'up', 500);

    // Self already occupies one slot; the cap is on the bucket, not on what
    // gossip added to it.
    expect(liveIn(node.cluster)).toBe(5);
  });

  test('gossiped tombstones are capped separately — the half that actually sticks', async () => {
    const node = await startNode('cap-tombstone', 9_202, { maxTombstones: 7 });
    nodes.push(node);
    const peer = new NodeAddress('cap-tombstone', '10.0.138.2', 9_290);

    floodAsActivePeer(node.cluster, peer, 'removed', 500);

    expect(tombstonesIn(node.cluster)).toBe(7);
  });

  test('the two buckets are independent — a full one does not refuse the other', async () => {
    const node = await startNode('cap-buckets', 9_203, { maxMembers: 4, maxTombstones: 3 });
    nodes.push(node);
    const peer = new NodeAddress('cap-buckets', '10.0.138.2', 9_290);

    floodAsActivePeer(node.cluster, peer, 'removed', 100);
    floodAsActivePeer(node.cluster, peer, 'up', 100, 1_000);

    expect(tombstonesIn(node.cluster)).toBe(3);
    expect(liveIn(node.cluster)).toBe(4);
  });

  test('the sender fallback outside mergeMember is capped too', async () => {
    // `onGossip` records any sender it does not already know, and that insert
    // never went through the merge path's guards — it was the one door #138
    // left open even with the merge capped.  `sender` is the payload's
    // self-declaration, so it is the cheaper of the two addresses to forge:
    // one connection can walk through a whole address range.
    const node = await startNode('cap-sender', 9_204, { maxMembers: 3 });
    nodes.push(node);
    const connection = new NodeAddress('cap-sender', '10.0.138.2', 9_290);

    for (let i = 0; i < 200; i++) {
      const claimed = new NodeAddress('cap-sender', '10.0.138.3', 21_000 + i);
      internals(node.cluster).handleWire(connection, {
        kind: 'gossip',
        from: claimed.toJSON(),
        members: [],
      });
    }

    expect(liveIn(node.cluster)).toBe(3);
  });

  test('0 disables a cap — and shows what the map did before', async () => {
    // The counterfactual.  Uncapped, the same 500 records all land, which is
    // the pre-fix behaviour and the reason the opt-out is `0` rather than a
    // number nobody would reach.
    const node = await startNode('cap-disabled', 9_205, { maxMembers: 0, maxTombstones: 0 });
    nodes.push(node);
    const peer = new NodeAddress('cap-disabled', '10.0.138.2', 9_290);

    floodAsActivePeer(node.cluster, peer, 'removed', 500);

    expect(tombstonesIn(node.cluster)).toBe(500);
  });

  test('ordinary membership is untouched at the default caps', async () => {
    // The regression side: the defaults must be invisible to a real cluster.
    const node = await startNode('cap-default', 9_206);
    nodes.push(node);
    const peer = new NodeAddress('cap-default', '10.0.138.2', 9_290);

    floodAsActivePeer(node.cluster, peer, 'up', 50);

    expect(liveIn(node.cluster)).toBe(51); // 50 peers + self
    expect(DEFAULT_MAX_MEMBERS).toBeGreaterThan(51);
    expect(DEFAULT_MAX_TOMBSTONES).toBeGreaterThan(DEFAULT_MAX_MEMBERS);
  });
});

describe('cap accounting stays in step with the map', () => {
  test('pruning expired tombstones gives the bucket its headroom back', async () => {
    // The drift test.  The tombstone count is maintained incrementally — an
    // O(n) rescan per record would be its own denial of service — so every
    // path that removes a tombstone has to decrement it.  A prune that failed
    // to would leave the cap permanently full, which is a liveness bug wearing
    // a security fix's clothes.
    const node = await startNode('cap-prune', 9_207, {
      maxTombstones: 4,
      tombstoneTtlMs: 1,
      tombstoneMinRetentionMs: 1,
    });
    nodes.push(node);
    const peer = new NodeAddress('cap-prune', '10.0.138.2', 9_290);

    floodAsActivePeer(node.cluster, peer, 'removed', 20);
    expect(tombstonesIn(node.cluster)).toBe(4);

    // `removedAt` was stamped at merge time and the TTL is 1 ms, so a prune
    // pass on the next turn of the loop drops all four.
    await new Promise((resolve) => setTimeout(resolve, 5));
    internals(node.cluster).tombstonePruneTick();
    expect(tombstonesIn(node.cluster)).toBe(0);
    expect(internals(node.cluster).tombstoneCount).toBe(0);

    // And the bucket accepts again, rather than staying full forever.
    floodAsActivePeer(node.cluster, peer, 'removed', 20, 100);
    expect(tombstonesIn(node.cluster)).toBe(4);
  });

  test('a re-incarnation moves an entry from the tombstone bucket to the live one', async () => {
    const node = await startNode('cap-reincarnation', 9_208, { maxMembers: 8, maxTombstones: 1 });
    nodes.push(node);
    const peer = new NodeAddress('cap-reincarnation', '10.0.138.2', 9_290);
    const subject = new NodeAddress('cap-reincarnation', '10.0.138.3', 9_390);

    internals(node.cluster).mergeMember(peer, 'up', {
      address: subject.toJSON(),
      status: 'removed',
      version: Date.now(),
      roles: [],
      removedAt: Date.now(),
    });
    expect(internals(node.cluster).tombstoneCount).toBe(1);

    // The address restarts and out-versions its own tombstone.
    internals(node.cluster).mergeMember(peer, 'up', {
      address: subject.toJSON(),
      status: 'up',
      version: Date.now() + 1_000,
      roles: [],
    });

    expect(internals(node.cluster).tombstoneCount).toBe(0);
    expect(tombstonesIn(node.cluster)).toBe(0);
    // Which is what lets the next gossiped tombstone in again.
    floodAsActivePeer(node.cluster, peer, 'removed', 3, 500);
    expect(tombstonesIn(node.cluster)).toBe(1);
  });

  test('a revival is refused when the live bucket is full, and stays a tombstone', async () => {
    // A revival vacates the tombstone bucket and occupies a live slot, so it is
    // a bucket change and the live cap decides.  Unchecked, it handed the
    // tombstone bucket its headroom back without giving up a map slot, which is
    // what let alternating floods grow the map past both caps.
    const node = await startNode('cap-revival-full', 9_210, { maxMembers: 1, maxTombstones: 4 });
    nodes.push(node);
    const peer = new NodeAddress('cap-revival-full', '10.0.138.2', 9_290);
    const subject = new NodeAddress('cap-revival-full', '10.0.138.3', 9_390);

    // `maxMembers: 1` is already spent on self, so nothing live may be added.
    internals(node.cluster).mergeMember(peer, 'up', {
      address: subject.toJSON(),
      status: 'removed',
      version: Date.now(),
      roles: [],
      removedAt: Date.now(),
    });
    expect(internals(node.cluster).tombstoneCount).toBe(1);

    internals(node.cluster).mergeMember(peer, 'up', {
      address: subject.toJSON(),
      status: 'up',
      version: Date.now() + 1_000,
      roles: [],
    });

    expect(membersOf(node.cluster).get(subject.toString())?.status).toBe('removed');
    expect(internals(node.cluster).tombstoneCount).toBe(1);
    expect(liveIn(node.cluster)).toBe(1);
  });

  test('a live member gossiped as removed is refused when the tombstone bucket is full', async () => {
    // The mirror image.  Refusing leaves the member live, where the failure
    // detector reclaims it within `downAfterMs` — slower, but it cannot be used
    // to free a live slot while keeping the map entry.
    const node = await startNode('cap-conversion-full', 9_211, { maxMembers: 8, maxTombstones: 1 });
    nodes.push(node);
    const peer = new NodeAddress('cap-conversion-full', '10.0.138.2', 9_290);
    const subject = new NodeAddress('cap-conversion-full', '10.0.138.3', 9_390);

    internals(node.cluster).mergeMember(peer, 'up', {
      address: subject.toJSON(),
      status: 'up',
      version: Date.now(),
      roles: [],
    });
    floodAsActivePeer(node.cluster, peer, 'removed', 5, 700);
    expect(tombstonesIn(node.cluster)).toBe(1);

    internals(node.cluster).mergeMember(peer, 'up', {
      address: subject.toJSON(),
      status: 'removed',
      version: Date.now() + 1_000,
      roles: [],
      removedAt: Date.now(),
    });

    expect(membersOf(node.cluster).get(subject.toString())?.status).toBe('up');
    expect(internals(node.cluster).tombstoneCount).toBe(1);
  });

  test('a status change inside one bucket is a free in-place update', async () => {
    // Only a bucket *change* is charged.  `up → unreachable` on a full live
    // bucket must still merge, or the cap would freeze the cluster it protects.
    const node = await startNode('cap-in-bucket', 9_212, { maxMembers: 2 });
    nodes.push(node);
    const peer = new NodeAddress('cap-in-bucket', '10.0.138.2', 9_290);
    const subject = new NodeAddress('cap-in-bucket', '10.0.138.3', 9_390);

    internals(node.cluster).mergeMember(peer, 'up', {
      address: subject.toJSON(),
      status: 'up',
      version: Date.now(),
      roles: [],
    });
    expect(liveIn(node.cluster)).toBe(2); // self + subject, the cap exactly

    internals(node.cluster).mergeMember(peer, 'up', {
      address: subject.toJSON(),
      status: 'unreachable',
      version: Date.now() + 1_000,
      roles: [],
    });

    expect(membersOf(node.cluster).get(subject.toString())?.status).toBe('unreachable');
  });

  test('a member this node tombstones itself is never refused by the cap', async () => {
    // `leave` / downing / `down()` convert a record this node already holds.
    // Capping its own bookkeeping would lose the suppression that stops stale
    // gossip resurrecting the address — a liveness bug, not a defence.
    const node = await startNode('cap-local', 9_209, { maxTombstones: 1 });
    nodes.push(node);
    const peer = new NodeAddress('cap-local', '10.0.138.2', 9_290);
    const leaver = new NodeAddress('cap-local', '10.0.138.4', 9_490);

    // Fill the tombstone bucket from gossip …
    floodAsActivePeer(node.cluster, peer, 'removed', 5);
    expect(tombstonesIn(node.cluster)).toBe(1);

    // … then have a real member announce its own departure.
    internals(node.cluster).mergeMember(leaver, undefined, {
      address: leaver.toJSON(),
      status: 'up',
      version: Date.now(),
      roles: [],
    });
    internals(node.cluster).handleWire(leaver, { kind: 'leave', node: leaver.toJSON() });

    expect(membersOf(node.cluster).get(leaver.toString())?.status).toBe('removed');
    expect(internals(node.cluster).tombstoneCount).toBe(2);
  });
});

describe('ClusterOptionsValidator — the caps', () => {
  const validate = (settings: CapOptions): void => {
    new ClusterOptionsValidator().validate({ host: HOST, port: 2_552, ...settings });
  };

  test('0 passes on both — it is the documented opt-out', () => {
    expect(() => validate({ maxMembers: 0, maxTombstones: 0 })).not.toThrow();
  });

  test('a positive integer passes', () => {
    expect(() => validate({ maxMembers: 250, maxTombstones: 2_500 })).not.toThrow();
  });

  test('negatives and fractions are refused', () => {
    expect(() => validate({ maxMembers: -1 })).toThrow(/maxMembers/);
    expect(() => validate({ maxTombstones: 1.5 })).toThrow(/maxTombstones/);
  });

  test('tombstoneMinRetentionMs accepts 0 — it means "derive", not "no floor"', () => {
    // It used to be rejected; the HOCON leaf now ships `0s` as its documented
    // default, and a file that spells a default out must behave like one that
    // omits it (#841).
    expect(() => validate({ tombstoneMinRetentionMs: 0 })).not.toThrow();
  });
});
