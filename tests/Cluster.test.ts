import { match } from 'ts-pattern';
import { describe, expect, test } from 'bun:test';
import {
  Actor,
  ActorSystem,
  ActorSystemOptions,
  LogLevel,
  NoopLogger,
} from '../src/index.js';
import {
  Cluster,
  ClusterOptions,
  ClusterSharding,
  InMemoryTransport,
  Member,
  MemberDown,
  MemberUp,
  NodeAddress,
  StartShardingOptions,
  hashShardId,
  moduloAllocator,
  rendezvousAllocator,
} from '../src/cluster/index.js';
import { awaitCondition, sleep } from './util/AwaitCondition.js';

type NodeHandle = {
  system: ActorSystem;
  cluster: Cluster;
  counts: Map<string, number>;
  region: import('../src/index.js').ActorRef<Command>;
};

type IncrementCommand = { id: string; kind: 'increment' };

type Command = IncrementCommand;

/** Spins up a cluster node backed by the shared InMemoryTransport registry. */
async function startNode(
  systemName: string,
  host: string,
  port: number,
  seeds: string[] = [],
): Promise<NodeHandle> {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, sysOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(host)
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, host, port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(
    system,
    clusterOptions,
  );

  const counts = new Map<string, number>();

  class CountEntity extends Actor<Command> {
    override onReceive(command: Command): void {
      counts.set(command.id, (counts.get(command.id) ?? 0) + 1);
    }
  }

  const sharding = cluster.sharding;
  const startShardingOptions = StartShardingOptions.create<Command>()
    .withTypeName('counter')
    .withEntityActor(CountEntity)
    .withExtractEntityId(message => message.id)
    .withNumShards(8);
  const region = sharding.start<Command>(
    startShardingOptions,
  );

  return { system, cluster, counts, region };
}

async function stopNode(node: NodeHandle): Promise<void> {
  await node.cluster.leave();
  await node.system.terminate();
}

test('three nodes discover each other and transition to Up', async () => {
  const n1 = await startNode('cluster-a', '10.0.0.1', 5001);
  const n2 = await startNode('cluster-a', '10.0.0.2', 5002, ['10.0.0.1:5001']);
  const n3 = await startNode('cluster-a', '10.0.0.3', 5003, ['10.0.0.1:5001']);

  await awaitCondition(
    () => [n1, n2, n3].every(n => n.cluster.upMembers().length === 3),
    { timeoutMs: 4_000, label: 'all three nodes see a 3-member cluster' },
  );

  for (const n of [n1, n2, n3]) {
    const ups = n.cluster.upMembers().map(m => m.address.toString()).sort();
    expect(ups).toEqual([
      'cluster-a@10.0.0.1:5001',
      'cluster-a@10.0.0.2:5002',
      'cluster-a@10.0.0.3:5003',
    ]);
  }

  await stopNode(n1); await stopNode(n2); await stopNode(n3);
});

test('sharded entities route to exactly one node', async () => {
  const n1 = await startNode('cluster-b', '10.0.1.1', 6001);
  const n2 = await startNode('cluster-b', '10.0.1.2', 6002, ['10.0.1.1:6001']);
  const n3 = await startNode('cluster-b', '10.0.1.3', 6003, ['10.0.1.1:6001']);
  // Wait until every node agrees on the Up set — same cardinality AND set.
  await awaitCondition(
    () => {
      const sets = [n1, n2, n3].map(n =>
        n.cluster.upMembers().map(m => m.address.toString()).sort().join('|'),
      );
      return sets[0] === sets[1] && sets[1] === sets[2] && sets[0].split('|').length === 3;
    },
    { timeoutMs: 4_000, label: 'all three nodes agree on the same 3-member Up set' },
  );
  // A settle rather than a poll: each shard region keeps its own view of the
  // member list and does not expose it, so "every region processed the last
  // MemberUp" has nothing observable to poll for (#418).
  await sleep(150);

  const entityIds = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  // Send every entity id from every node; the entities should all land on
  // the SAME node each time (their deterministic owner).
  for (const id of entityIds) {
    n1.region.tell({ id, kind: 'increment' });
    n2.region.tell({ id, kind: 'increment' });
    n3.region.tell({ id, kind: 'increment' });
  }
  const handled = (): number => entityIds.reduce(
    (total, id) => total + (n1.counts.get(id) ?? 0) + (n2.counts.get(id) ?? 0) + (n3.counts.get(id) ?? 0),
    0,
  );
  await awaitCondition(() => handled() >= entityIds.length * 3, {
    timeoutMs: 4_000,
    label: 'every entity id was handled once per sending node',
  });

  for (const id of entityIds) {
    const hits = [n1.counts.get(id) ?? 0, n2.counts.get(id) ?? 0, n3.counts.get(id) ?? 0];
    const total = hits.reduce((nodeA, nodeB) => nodeA + nodeB, 0);
    const nonZero = hits.filter(h => h > 0).length;
    expect(total).toBe(3);
    expect(nonZero).toBe(1); // exactly one node hosts each entity
  }

  await stopNode(n1); await stopNode(n2); await stopNode(n3);
});

test('shards rebalance when a node leaves', async () => {
  const n1 = await startNode('cluster-c', '10.0.2.1', 7001);
  const n2 = await startNode('cluster-c', '10.0.2.2', 7002, ['10.0.2.1:7001']);
  const n3 = await startNode('cluster-c', '10.0.2.3', 7003, ['10.0.2.1:7001']);
  // Convergence, not 500ms of it: the member list read on the next line
  // decides which entity the whole test follows, so reading it early picks
  // the wrong victim and the failure surfaces four assertions later.
  await awaitCondition(
    () => n1.cluster.upMembers().length === 3
      && n2.cluster.upMembers().length === 3
      && n3.cluster.upMembers().length === 3,
    { timeoutMs: 5_000, label: 'all three nodes see a 3-member cluster' },
  );

  // Find an entity whose owner is node 2.
  const members = n1.cluster.upMembers().map(m => m.address);
  const entityIds = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
  const victim = entityIds.find(id => {
    const shardId = hashShardId(id, 8);
    const owner = moduloAllocator(shardId, members);
    return owner.toString() === 'cluster-c@10.0.2.2:7002';
  });
  expect(victim).toBeDefined();

  // Before: the entity lives on node 2.  Waiting on node 2's own count is
  // what makes the following absence assertion meaningful — under the old
  // fixed sleep, "n1 and n3 saw nothing" could equally mean the message had
  // not been routed anywhere yet.
  n1.region.tell({ id: victim!, kind: 'increment' });
  await awaitCondition(() => (n2.counts.get(victim!) ?? 0) === 1, {
    timeoutMs: 5_000,
    label: 'the entity was handled on its owning node',
  });
  expect(n2.counts.get(victim!) ?? 0).toBe(1);
  expect((n1.counts.get(victim!) ?? 0) + (n3.counts.get(victim!) ?? 0)).toBe(0);

  // Kill node 2 and wait for failure detection + rebalance.
  await stopNode(n2);
  await awaitCondition(
    () => n1.cluster.upMembers().length === 2 && n3.cluster.upMembers().length === 2,
    { timeoutMs: 10_000, label: 'the survivors downed the departed member' },
  );

  // After: survivors should detect the down member and re-own its shards.
  expect(n1.cluster.upMembers().length).toBe(2);
  expect(n3.cluster.upMembers().length).toBe(2);

  // Send to the same entity from node 1; it should now live somewhere still alive.
  n1.region.tell({ id: victim!, kind: 'increment' });
  n1.region.tell({ id: victim!, kind: 'increment' });
  await awaitCondition(
    () => (n1.counts.get(victim!) ?? 0) + (n3.counts.get(victim!) ?? 0) === 2,
    { timeoutMs: 5_000, label: 'both re-sent messages reached the re-owned shard' },
  );

  const afterHits = (n1.counts.get(victim!) ?? 0) + (n3.counts.get(victim!) ?? 0);
  expect(afterHits).toBe(2);

  await stopNode(n1); await stopNode(n3);
  // 30 s, because the four budgets above add up to 25 s and bun's default cap
  // is 5 s — every one of them was nominal, and whichever wait stalled the run
  // said "this test timed out after 5000ms" instead of naming it.  The cap is a
  // backstop that must never be the thing that reports; the budgets are.
}, 30_000);

test('rendezvousAllocator keeps most shards stable when one node leaves', async () => {
  const n1 = new NodeAddress('s', 'h', 1);
  const n2 = new NodeAddress('s', 'h', 2);
  const n3 = new NodeAddress('s', 'h', 3);

  const before = [];
  for (let shardId = 0; shardId < 128; shardId++) {
    before.push(rendezvousAllocator(shardId, [n1, n2, n3]));
  }
  const after = [];
  for (let shardId = 0; shardId < 128; shardId++) {
    after.push(rendezvousAllocator(shardId, [n1, n3])); // n2 removed
  }

  // Every shard previously on n1 or n3 must still point to the same node;
  // shards previously on n2 pick one of the survivors.
  for (let i = 0; i < before.length; i++) {
    if (before[i]!.equals(n1) || before[i]!.equals(n3)) {
      expect(after[i]!.equals(before[i]!)).toBe(true);
    } else {
      expect(after[i]!.equals(n1) || after[i]!.equals(n3)).toBe(true);
    }
  }
});

test('leader is the address-sorted first up-member', async () => {
  const n1 = await startNode('cluster-d', '10.0.3.1', 8001);
  const n2 = await startNode('cluster-d', '10.0.3.2', 8002, ['10.0.3.1:8001']);
  // Leadership is only defined once both nodes are in the Up set — reading it
  // before that is what the 400 ms was hoping to avoid.
  await awaitCondition(
    () => n1.cluster.upMembers().length === 2 && n2.cluster.upMembers().length === 2,
    { timeoutMs: 4_000, label: 'both nodes see a 2-member cluster' },
  );

  // Sorted by address string — "10.0.3.1:8001" < "10.0.3.2:8002".
  expect(n1.cluster.isLeader()).toBe(true);
  expect(n2.cluster.isLeader()).toBe(false);

  await stopNode(n1);
  await awaitCondition(() => n2.cluster.isLeader(), {
    timeoutMs: 4_000,
    label: 'the survivor took leadership',
  });
  expect(n2.cluster.isLeader()).toBe(true);

  await stopNode(n2);
});

/**
 * #525 — pins the half of the contract the test above cannot see.  There the
 * lowest-addressed node is also the seed, so address order and join order agree
 * and the assertion holds either way.  Leadership is decided by *address*: the
 * node that joins second leads the moment it is up, if its address sorts first.
 * Documented in `cluster/overview` — this is what keeps that honest.
 */
test('leadership follows address order, not join order', async () => {
  // The seed joins first and has the HIGHER address.
  const first = await startNode('cluster-d2', '10.0.4.2', 8002);
  await awaitCondition(() => first.cluster.isLeader(), {
    timeoutMs: 4_000,
    label: 'the seed leads on its own',
  });

  const later = await startNode('cluster-d2', '10.0.4.1', 8001, ['10.0.4.2:8002']);
  await awaitCondition(() => later.cluster.upMembers().length === 2, {
    timeoutMs: 4_000,
    label: 'the newcomer sees a 2-member cluster',
  });

  // The newcomer takes leadership from the node that was there first.
  await awaitCondition(() => later.cluster.isLeader(), {
    timeoutMs: 4_000,
    label: 'the lower-addressed newcomer took leadership',
  });
  expect(first.cluster.isLeader()).toBe(false);

  await stopNode(later);
  await stopNode(first);
});

test('a node that gracefully left can rejoin on the same address', async () => {
  // Regression: `cluster.leave()` tombstones the leaver via
  // `mergeMember`'s strict version monotonicity (incoming v1 from a
  // fresh start ≤ tombstoned vN), which used to pin the address
  // permanently in the `removed` state.  After fixing mergeMember to
  // override `removed`-vs-`joining` for the same address, a restart
  // on that address must converge back to Up across the cluster.
  const SYS = 'cluster-rejoin';
  const ADDR1 = '10.0.5.1:5101';
  const n1 = await startNode(SYS, '10.0.5.1', 5101);
  const n2 = await startNode(SYS, '10.0.5.2', 5102, [ADDR1]);
  const n3 = await startNode(SYS, '10.0.5.3', 5103, [ADDR1]);

  await awaitCondition(() => [n1, n2, n3].every(n => n.cluster.upMembers().length === 3), {
    timeoutMs: 4_000,
    label: 'all three nodes see a 3-member cluster',
  });

  // Graceful leave for n1 — survivors tombstone its address.
  await stopNode(n1);
  await awaitCondition(
    () => [n2, n3].every(n =>
      !n.cluster.upMembers().some(m => m.address.toString() === `${SYS}@${ADDR1}`),
    ),
    { timeoutMs: 4_000, label: 'both survivors tombstoned the leaver' },
  );
  expect(n2.cluster.upMembers().length).toBe(2);
  expect(n3.cluster.upMembers().length).toBe(2);

  // Restart n1 on the same host:port.  Survivors carry the
  // tombstone; without the mergeMember fix the rejoin gossip would
  // be rejected and n1 would never reach Up in their views.
  const n1b = await startNode(SYS, '10.0.5.1', 5101, [`10.0.5.2:5102`]);
  await awaitCondition(
    () => [n1b, n2, n3].every(n => n.cluster.upMembers().length === 3),
    { timeoutMs: 4_000, label: 'the rejoined node reached Up in every view' },
  );
  for (const n of [n1b, n2, n3]) {
    const ups = n.cluster.upMembers().map(m => m.address.toString()).sort();
    expect(ups).toEqual([
      `${SYS}@10.0.5.1:5101`,
      `${SYS}@10.0.5.2:5102`,
      `${SYS}@10.0.5.3:5103`,
    ]);
  }

  await stopNode(n1b); await stopNode(n2); await stopNode(n3);
});

test('MemberUp and departure events fire on the cluster subscription', async () => {
  const n1 = await startNode('cluster-e', '10.0.4.1', 9001);
  const seenUp: string[] = [];
  const seenLeft: string[] = [];
  const seenDown: string[] = [];

  n1.cluster.subscribe(evt => {
    if (evt instanceof MemberUp) seenUp.push(evt.member.address.toString());
    if (evt instanceof MemberDown) seenDown.push(evt.member.address.toString());
    // MemberLeft/Removed cover the graceful-leave path; MemberDown covers a crash.
    if ((evt as { constructor: { name: string } }).constructor.name === 'MemberLeft') {
      seenLeft.push((evt as { member: { address: { toString(): string } } }).member.address.toString());
    }
  });

  const n2 = await startNode('cluster-e', '10.0.4.2', 9002, ['10.0.4.1:9001']);
  await awaitCondition(() => seenUp.includes('cluster-e@10.0.4.2:9002'), {
    timeoutMs: 4_000,
    label: 'the subscription saw MemberUp for the joiner',
  });
  expect(seenUp).toContain('cluster-e@10.0.4.2:9002');

  await stopNode(n2);
  await awaitCondition(
    () => seenLeft.concat(seenDown).includes('cluster-e@10.0.4.2:9002'),
    { timeoutMs: 4_000, label: 'the subscription saw the departure' },
  );
  // Graceful leave emits MemberLeft; ungraceful crash would emit MemberDown.
  expect(seenLeft.concat(seenDown)).toContain('cluster-e@10.0.4.2:9002');

  await stopNode(n1);
});

/* ----------------------- tombstone pruning (#75) ----------------------- */

/** Read-only access to the private members map for tombstone-count assertions. */
type ClusterInternals = { readonly members: ReadonlyMap<string, Member> };
const peek = (cluster: Cluster): ClusterInternals =>
  cluster as unknown as ClusterInternals;

/**
 * Merge a synthesized member record as if it had arrived from `sender` over an
 * established connection, with the sender already an active member.
 *
 * `mergeMember` takes the connection's peer and that peer's standing because a
 * claim about a *third* node is only accepted from a member this node already
 * considers active (#562).  Tests that are about the merge rules themselves —
 * tombstone TTLs, version monotonicity — need to clear that gate first, or
 * they pass because the frame was refused rather than because the rule under
 * test worked.
 */
function mergeAsPeer(cluster: Cluster, sender: NodeAddress, data: unknown): void {
  (cluster as unknown as {
    mergeMember(from: NodeAddress, senderStatus: string, data: unknown): void;
  }).mergeMember(sender, 'up', data);
}

/**
 * Variant of `startNode` that exposes the tombstone knobs.  All other
 * timing parameters mirror the default test setup.
 */
async function startNodeWithTombstoneConfig(
  systemName: string, host: string, port: number, seeds: string[],
  config: { tombstoneTtlMs: number; tombstonePruneIntervalMs: number; tombstoneMinRetentionMs: number },
): Promise<{ system: ActorSystem; cluster: Cluster }> {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, sysOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(host)
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, host, port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80)
    .withTombstoneTtlMs(config.tombstoneTtlMs)
    .withTombstonePruneIntervalMs(config.tombstonePruneIntervalMs)
    .withTombstoneMinRetentionMs(config.tombstoneMinRetentionMs);
  const cluster = await Cluster.join(
    system,
    clusterOptions,
  );
  return { system, cluster };
}

describe('Cluster tombstone pruning (#75)', () => {
  test('tombstone created on graceful leave is dropped from the members map after TTL', async () => {
    // Tight test values: TTL 200ms + min-retention 80ms keep the test
    // fast while staying well above the 80ms gossip cadence so peers
    // converge before pruning kicks in.
    const SYS = 'cluster-tombstone-prune';
    const nodeA = await startNodeWithTombstoneConfig(
      SYS, '10.0.6.1', 6001, [],
      { tombstoneTtlMs: 200, tombstonePruneIntervalMs: 60, tombstoneMinRetentionMs: 80 },
    );
    const nodeB = await startNodeWithTombstoneConfig(
      SYS, '10.0.6.2', 6002, ['10.0.6.1:6001'],
      { tombstoneTtlMs: 200, tombstonePruneIntervalMs: 60, tombstoneMinRetentionMs: 80 },
    );
    await awaitCondition(
      () => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
      { timeoutMs: 4_000, label: 'both nodes see a 2-member cluster' },
    );

    // B leaves gracefully → A holds a tombstone for B.
    await nodeB.cluster.leave();
    await nodeB.system.terminate();
    await awaitCondition(
      () => peek(nodeA.cluster).members.has(`${SYS}@10.0.6.2:6002`)
        && peek(nodeA.cluster).members.get(`${SYS}@10.0.6.2:6002`)!.status === 'removed',
      { timeoutMs: 4_000, label: 'A holds a tombstone for the leaver' },
    );
    expect(peek(nodeA.cluster).members.size).toBe(2); // 1 live + 1 tombstone

    // Wait for TTL + one prune interval — the tombstone must be gone.
    await awaitCondition(() => peek(nodeA.cluster).members.size === 1, {
      timeoutMs: 4_000,
      label: 'the tombstone was pruned',
    });
    expect(peek(nodeA.cluster).members.size).toBe(1);
    expect(nodeA.cluster.upMembers().length).toBe(1);

    await nodeA.cluster.leave();
    await nodeA.system.terminate();
  });

  test('mergeMember rejects an incoming tombstone whose removedAt is older than the TTL', async () => {
    // Synthesize a stale tombstone gossip from a "ghost" peer — the
    // sort of frame a slow peer might emit after sleeping past the
    // TTL.  Without the guard this address would land in the local
    // `members` map and never get cleaned up by the prune pass
    // (because addresses we *only* learned about as already-expired
    // shouldn't be added in the first place).
    const SYS = 'cluster-tombstone-stale-merge';
    const nodeA = await startNodeWithTombstoneConfig(
      SYS, '10.0.6.10', 6010, [],
      { tombstoneTtlMs: 200, tombstonePruneIntervalMs: 60, tombstoneMinRetentionMs: 80 },
    );
    await awaitCondition(() => nodeA.cluster.upMembers().length === 1, {
      timeoutMs: 4_000,
      label: 'the single node reached Up',
    });

    // Drive the private mergeMember via a synthesized gossip frame.
    // The sender is given standing on purpose: without it the authority rule
    // (#562) refuses the frame first, and this test would pass without ever
    // reaching the TTL guard it exists to pin.
    const gossipSender = new NodeAddress(SYS, '10.0.6.98', 6098);
    const stalePeer = new NodeAddress(SYS, '10.0.6.99', 6099);
    const staleData = {
      address: stalePeer.toJSON(),
      status: 'removed' as const,
      version: 999,
      roles: [] as string[],
      removedAt: Date.now() - 10_000, // way past the 200ms TTL
    };
    mergeAsPeer(nodeA.cluster, gossipSender, staleData);

    expect(peek(nodeA.cluster).members.has(stalePeer.toString())).toBe(false);

    await nodeA.cluster.leave();
    await nodeA.system.terminate();
  });

  test('tombstone with no removedAt (mixed-version peer) is preserved across prune passes', async () => {
    // Tombstones gossiped by a node pre-dating the `removedAt` field
    // arrive without the timestamp.  We have no age info, so we keep
    // them — they drop out naturally when the old peer is upgraded
    // or restarts.  Verifies prune-tick doesn't accidentally evict
    // them on the strength of "no removedAt = ancient" (which would
    // re-introduce the resurrection bug for mixed-version clusters).
    const SYS = 'cluster-tombstone-mixed-version';
    const nodeA = await startNodeWithTombstoneConfig(
      SYS, '10.0.6.20', 6020, [],
      { tombstoneTtlMs: 100, tombstonePruneIntervalMs: 50, tombstoneMinRetentionMs: 50 },
    );
    await awaitCondition(() => nodeA.cluster.upMembers().length === 1, {
      timeoutMs: 4_000,
      label: 'the single node reached Up',
    });

    const gossipSender = new NodeAddress(SYS, '10.0.6.22', 6022);
    const oldPeer = new NodeAddress(SYS, '10.0.6.21', 6021);
    const noAgeTombstone = {
      address: oldPeer.toJSON(),
      status: 'removed' as const,
      version: 5,
      roles: [] as string[],
      // removedAt deliberately omitted.
    };
    mergeAsPeer(nodeA.cluster, gossipSender, noAgeTombstone);

    // Tombstone is in the map — `mergeMember`'s expired-tombstone
    // guard only triggers when `removedAt` IS set.
    expect(peek(nodeA.cluster).members.has(oldPeer.toString())).toBe(true);

    // An absence, so a fixed wait: the tombstone has to survive several 50 ms
    // prune passes, and that is already true at t=0 (#418).
    await sleep(300);
    expect(peek(nodeA.cluster).members.has(oldPeer.toString())).toBe(true);
    expect(peek(nodeA.cluster).members.get(oldPeer.toString())!.status).toBe('removed');

    await nodeA.cluster.leave();
    await nodeA.system.terminate();
  });
});
