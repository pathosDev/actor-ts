/**
 * The three ways the gossip merge path's caps were walked around after #114
 * and #138 landed — each written as the attack, not as the absence of a
 * symptom.
 *
 * All three share one shape: a guard that asks *"is this the first time I see
 * this address?"* or *"is there room for one more?"* was evaluated against a
 * map the attacker had just written to, in the same frame or the frame before.
 *
 * 1. **Two records for one address in a single frame.**  `mergeMember` reads
 *    `members.get(...)` afresh per record, so record 1 creates the address
 *    under the tight first-sighting cap and record 2 — same frame, same
 *    address — lands in the `existing` branch, where only the 24 h cap
 *    applied.  Net effect: the attacker's roles and a version 23 h ahead, on
 *    an address nobody owns yet.
 *
 * 2. **The sender fallback as a door-opener.**  A frame with `members: []`
 *    made `onGossip` record the *sender* at version 1, which put the address
 *    on file without it ever passing the first-sighting cap.  The next frame
 *    then found an `existing` record and got the 24 h cap for free.  The
 *    fallback is documented as the reason a rejection "costs one gossip
 *    round" — the same property was the bypass.
 *
 * 3. **Re-incarnation as a headroom pump.**  `existing.status === 'removed'`
 *    plus a higher version wrote through `setMember` with no cap check at
 *    all.  That moves an entry out of the tombstone bucket without freeing a
 *    map slot, so a peer could alternate `removed` / `up` floods and grow
 *    `members` without bound — the exact failure mode the caps exist to stop.
 *
 * The tests drive the wire handler directly: the property under test is what
 * the map holds after N frames, and a background gossip or failure-detector
 * tick would only add nondeterminism.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberData, WireMessage } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { MetricsExtensionId, metricsOf } from '../../../src/metrics/MetricsExtension.js';

const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The window the attacker aims for: inside the 24 h cap, far outside 5 min. */
const SQUAT_SKEW_MS = 23 * HOUR_MS;

const ATTACKER_ROLES = ['shard-host', 'singleton-host'];

type CapOptions = {
  readonly maxMembers?: number;
  readonly maxTombstones?: number;
};

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
};

/**
 * A one-node cluster with every timer pushed far out.  With no seeds the node
 * elects itself `up`, which also makes it the leader — the promotion loop that
 * lifts a squatted `joining` record into the active set is part of the damage
 * under test, so it has to be running.
 */
async function startNode(systemName: string, port: number, caps: CapOptions = {}): Promise<NodeHandle> {
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
    .withGossipIntervalMs(60_000)
    .withTombstonePruneIntervalMs(60_000);
  if (caps.maxMembers !== undefined) clusterOptions.withMaxMembers(caps.maxMembers);
  if (caps.maxTombstones !== undefined) clusterOptions.withMaxTombstones(caps.maxTombstones);
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster, address };
}

/** The private surface these tests reach through — merge internals, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: WireMessage): void;
  readonly members: Map<string, Member>;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

/**
 * Gossip frames carry a monotonic per-sender `sequence` since #112, and a
 * receiver refuses one that does not out-number the last it accepted from that
 * peer.  Several tests here send frame after frame from one address, so the
 * helper stamps a fresh number each time.
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

function memberIn(cluster: Cluster, address: NodeAddress): Member | undefined {
  return internals(cluster).members.get(address.toString());
}

function mapSize(cluster: Cluster): number {
  return internals(cluster).members.size;
}

/** The address the attacker is squatting — the next pod of a StatefulSet. */
function squatTarget(systemName: string): NodeAddress {
  return new NodeAddress(systemName, '10.0.114.9', 9_190);
}

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

describe('#114 — the version cap cannot be walked up in two steps', () => {
  test('two records for the same address in one frame do not lift the second past the cap', async () => {
    const node = await startNode('two-records', 9_301);
    nodes.push(node);
    const claimed = squatTarget('two-records');

    // Record 1 is an ordinary first sighting and passes on its own merits.
    // Record 2 is the exploit: same address, same frame, dated 23 h ahead and
    // carrying the roles the attacker actually wants.  It used to land because
    // record 1 had already created the entry, which put record 2 in the branch
    // governed by the generous cap.
    gossipFrom(node.cluster, claimed, [
      { address: claimed.toJSON(), status: 'joining', version: Date.now(), roles: [] },
      {
        address: claimed.toJSON(),
        status: 'joining',
        version: Date.now() + SQUAT_SKEW_MS,
        roles: ATTACKER_ROLES,
      },
    ]);

    const stored = memberIn(node.cluster, claimed);
    expect(stored).toBeDefined();
    expect(Array.from(stored!.roles)).toEqual([]);
    // The version the map holds must stay something the real owner's own
    // wall-clock can still beat.
    expect(stored!.version).toBeLessThan(Date.now() + HOUR_MS);
    expect(node.cluster.upMembersWithRole('singleton-host')).toHaveLength(0);
  });

  test('and the address stays winnable by the node that really owns it', async () => {
    const node = await startNode('two-records-owner', 9_302);
    nodes.push(node);
    const claimed = squatTarget('two-records-owner');

    gossipFrom(node.cluster, claimed, [
      { address: claimed.toJSON(), status: 'joining', version: Date.now(), roles: [] },
      {
        address: claimed.toJSON(),
        status: 'joining',
        version: Date.now() + SQUAT_SKEW_MS,
        roles: ATTACKER_ROLES,
      },
    ]);

    // The real node starts and announces itself the ordinary way.
    const ownVersion = Date.now() + 1_000;
    gossipFrom(node.cluster, claimed, [
      { address: claimed.toJSON(), status: 'joining', version: ownVersion, roles: ['worker'] },
    ]);

    const stored = memberIn(node.cluster, claimed);
    expect(Array.from(stored!.roles)).toEqual(['worker']);
    expect(stored!.version).toBeGreaterThanOrEqual(ownVersion);
  });

  test('the sender fallback does not hand the next frame the wider cap', async () => {
    const node = await startNode('fallback-door', 9_303);
    nodes.push(node);
    const claimed = squatTarget('fallback-door');

    // Frame 1: no member records at all.  `onGossip` still puts the connection's
    // self-declared address on file — that fallback is what makes a refusal
    // cost one gossip round instead of being permanent, and it is also what
    // used to turn the *next* frame into an `existing`-branch merge.
    gossipFrom(node.cluster, claimed, []);
    expect(memberIn(node.cluster, claimed)).toBeDefined();

    // Frame 2: the squat, 23 h ahead, with the roles.
    gossipFrom(node.cluster, claimed, [{
      address: claimed.toJSON(),
      status: 'joining',
      version: Date.now() + SQUAT_SKEW_MS,
      roles: ATTACKER_ROLES,
    }]);

    const stored = memberIn(node.cluster, claimed);
    expect(Array.from(stored!.roles)).toEqual([]);
    expect(stored!.version).toBeLessThan(Date.now() + HOUR_MS);
    expect(node.cluster.upMembersWithRole('singleton-host')).toHaveLength(0);
  });

  test('an ordinary record still merges onto an address already on file', async () => {
    // The regression side of the same rule: closing the walk-up must not
    // freeze a member whose clock is merely a little ahead.
    const node = await startNode('ordinary-update', 9_304);
    nodes.push(node);
    const peer = squatTarget('ordinary-update');

    gossipFrom(node.cluster, peer, [
      { address: peer.toJSON(), status: 'joining', version: Date.now(), roles: ['worker'] },
    ]);
    const laterVersion = Date.now() + MINUTE_MS;
    gossipFrom(node.cluster, peer, [
      { address: peer.toJSON(), status: 'leaving', version: laterVersion, roles: ['worker'] },
    ]);

    expect(memberIn(node.cluster, peer)!.status).toBe('leaving');
    expect(memberIn(node.cluster, peer)!.version).toBe(laterVersion);
  });

  test('refused records are counted once per frame, not logged once per record', async () => {
    const node = await startNode('refusal-metric', 9_305);
    nodes.push(node);
    node.system.extension(MetricsExtensionId).enable();
    const claimed = squatTarget('refusal-metric');

    const records: MemberData[] = [];
    for (let i = 0; i < 5; i++) {
      records.push({
        address: claimed.toJSON(),
        status: 'joining',
        version: Date.now() + SQUAT_SKEW_MS + i,
        roles: ATTACKER_ROLES,
      });
    }
    gossipFrom(node.cluster, claimed, records);

    const refused = metricsOf(node.system)
      .counter('cluster_gossip_records_refused_total', { reason: 'version-skew' });
    expect(refused.value).toBe(5);
  });
});

describe('#138 — the caps bound the map across bucket changes', () => {
  test('a removed/up flood cannot pump the map past the two caps', async () => {
    // The attack: gossip a block of fresh addresses as `removed` (admitted by
    // the tombstone cap), then the same block as `up` with a higher version.
    // The re-incarnation branch used to write straight through `setMember`,
    // which gave the tombstone bucket its headroom back *without* giving up a
    // map slot — so the next block was admitted too, and the one after that.
    const maxMembers = 5;
    const maxTombstones = 5;
    const node = await startNode('reincarnation-pump', 9_306, { maxMembers, maxTombstones });
    nodes.push(node);
    const peer = new NodeAddress('reincarnation-pump', '10.0.138.2', 9_290);

    // The peer has to be an active member for its third-party claims to carry
    // authority — exactly the standing #562 grants a promoted node.
    gossipFrom(node.cluster, peer, [
      { address: peer.toJSON(), status: 'up', version: Date.now(), roles: [] },
    ]);

    const blockSize = 10;
    const sizes: number[] = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      const block: NodeAddress[] = [];
      for (let i = 0; i < blockSize; i++) {
        block.push(new NodeAddress('reincarnation-pump', '10.0.138.99', 20_000 + cycle * 100 + i));
      }
      gossipFrom(node.cluster, peer, block.map((address) => ({
        address: address.toJSON(),
        status: 'removed' as const,
        version: Date.now(),
        roles: [],
        removedAt: Date.now(),
      })));
      gossipFrom(node.cluster, peer, block.map((address) => ({
        address: address.toJSON(),
        status: 'up' as const,
        version: Date.now() + 1_000,
        roles: [],
      })));
      sizes.push(mapSize(node.cluster));
    }

    // Self + the peer + at most one full live bucket + one full tombstone
    // bucket.  Before the fix this read 6, 11, 16, 21, 26, 31.
    const ceiling = maxMembers + maxTombstones + 1;
    for (const size of sizes) expect(size).toBeLessThanOrEqual(ceiling);
    // And it is genuinely flat by the end, not merely slow.
    expect(sizes[5]).toBe(sizes[4]!);
  });

  test('a live member gossiped as removed cannot pump the tombstone bucket either', async () => {
    // The mirror image of the same hole: converting a live entry into a
    // tombstone also changes bucket, and going unchecked it frees a live slot
    // for the next block while keeping the map entry.
    const maxMembers = 5;
    const maxTombstones = 5;
    const node = await startNode('conversion-pump', 9_307, { maxMembers, maxTombstones });
    nodes.push(node);
    const peer = new NodeAddress('conversion-pump', '10.0.138.2', 9_290);

    gossipFrom(node.cluster, peer, [
      { address: peer.toJSON(), status: 'up', version: Date.now(), roles: [] },
    ]);

    const blockSize = 10;
    for (let cycle = 0; cycle < 6; cycle++) {
      const block: NodeAddress[] = [];
      for (let i = 0; i < blockSize; i++) {
        block.push(new NodeAddress('conversion-pump', '10.0.138.98', 30_000 + cycle * 100 + i));
      }
      gossipFrom(node.cluster, peer, block.map((address) => ({
        address: address.toJSON(),
        status: 'up' as const,
        version: Date.now(),
        roles: [],
      })));
      gossipFrom(node.cluster, peer, block.map((address) => ({
        address: address.toJSON(),
        status: 'removed' as const,
        version: Date.now() + 1_000,
        roles: [],
        removedAt: Date.now(),
      })));
    }

    expect(mapSize(node.cluster)).toBeLessThanOrEqual(maxMembers + maxTombstones + 1);
  });

  test('cap refusals are counted for operators', async () => {
    const node = await startNode('cap-metric', 9_308, { maxMembers: 2 });
    nodes.push(node);
    node.system.extension(MetricsExtensionId).enable();
    const peer = new NodeAddress('cap-metric', '10.0.138.2', 9_290);

    gossipFrom(node.cluster, peer, [
      { address: peer.toJSON(), status: 'up', version: Date.now(), roles: [] },
    ]);
    const records: MemberData[] = [];
    for (let i = 0; i < 20; i++) {
      const address = new NodeAddress('cap-metric', '10.0.138.99', 40_000 + i);
      records.push({ address: address.toJSON(), status: 'up', version: Date.now(), roles: [] });
    }
    gossipFrom(node.cluster, peer, records);

    const refused = metricsOf(node.system)
      .counter('cluster_gossip_records_refused_total', { reason: 'map-cap' });
    expect(refused.value).toBe(20);
  });
});
