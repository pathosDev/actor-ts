import { describe, expect, test } from 'bun:test';
import {
  Actor,
  ActorSystem,
  ActorSystemOptions,
  Cluster,
  ClusterOptions,
  ClusterSharding,
  InMemoryTransport,
  LogLevel,
  Member,
  MemberDown,
  MemberUp,
  NoopLogger,
  Props,
  NodeAddress,
  StartShardingOptions,
  hashShardId,
  moduloAllocator,
  rendezvousAllocator,
} from '../src/index.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(pred: () => boolean, timeoutMs: number, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(stepMs);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

interface NodeHandle {
  system: ActorSystem;
  cluster: Cluster;
  counts: Map<string, number>;
  region: import('../src/index.js').ActorRef<Command>;
}

type Command = { id: string; op: 'increment' };

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
    .withEntityProps(Props.create(() => new CountEntity()))
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

  await sleep(600);

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
  await waitFor(() => {
    const sets = [n1, n2, n3].map(n =>
      n.cluster.upMembers().map(m => m.address.toString()).sort().join('|'),
    );
    return sets[0] === sets[1] && sets[1] === sets[2] && sets[0].split('|').length === 3;
  }, 2_000);
  // Tiny extra cushion so each region processes the last MemberUp event.
  await sleep(150);

  const entityIds = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  // Send every entity id from every node; the entities should all land on
  // the SAME node each time (their deterministic owner).
  for (const id of entityIds) {
    n1.region.tell({ id, op: 'increment' });
    n2.region.tell({ id, op: 'increment' });
    n3.region.tell({ id, op: 'increment' });
  }
  await sleep(500);

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
  await sleep(500);

  // Find an entity whose owner is node 2.
  const members = n1.cluster.upMembers().map(m => m.address);
  const entityIds = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
  const victim = entityIds.find(id => {
    const shardId = hashShardId(id, 8);
    const owner = moduloAllocator(shardId, members);
    return owner.toString() === 'cluster-c@10.0.2.2:7002';
  });
  expect(victim).toBeDefined();

  // Before: the entity lives on node 2.
  n1.region.tell({ id: victim!, op: 'increment' });
  await sleep(150);
  expect(n2.counts.get(victim!) ?? 0).toBe(1);
  expect((n1.counts.get(victim!) ?? 0) + (n3.counts.get(victim!) ?? 0)).toBe(0);

  // Kill node 2 and wait for failure detection + rebalance.
  await stopNode(n2);
  await sleep(1_200);

  // After: survivors should detect the down member and re-own its shards.
  expect(n1.cluster.upMembers().length).toBe(2);
  expect(n3.cluster.upMembers().length).toBe(2);

  // Send to the same entity from node 1; it should now live somewhere still alive.
  n1.region.tell({ id: victim!, op: 'increment' });
  n1.region.tell({ id: victim!, op: 'increment' });
  await sleep(300);

  const afterHits = (n1.counts.get(victim!) ?? 0) + (n3.counts.get(victim!) ?? 0);
  expect(afterHits).toBe(2);

  await stopNode(n1); await stopNode(n3);
});

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
  await sleep(400);

  // Sorted by address string — "10.0.3.1:8001" < "10.0.3.2:8002".
  expect(n1.cluster.isLeader()).toBe(true);
  expect(n2.cluster.isLeader()).toBe(false);

  await stopNode(n1);
  await sleep(800);
  expect(n2.cluster.isLeader()).toBe(true);

  await stopNode(n2);
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

  await waitFor(() => [n1, n2, n3].every(n => n.cluster.upMembers().length === 3), 2_000);

  // Graceful leave for n1 — survivors tombstone its address.
  await stopNode(n1);
  await waitFor(
    () => [n2, n3].every(n =>
      !n.cluster.upMembers().some(m => m.address.toString() === `${SYS}@${ADDR1}`),
    ),
    2_000,
  );
  expect(n2.cluster.upMembers().length).toBe(2);
  expect(n3.cluster.upMembers().length).toBe(2);

  // Restart n1 on the same host:port.  Survivors carry the
  // tombstone; without the mergeMember fix the rejoin gossip would
  // be rejected and n1 would never reach Up in their views.
  const n1b = await startNode(SYS, '10.0.5.1', 5101, [`10.0.5.2:5102`]);
  await waitFor(
    () => [n1b, n2, n3].every(n => n.cluster.upMembers().length === 3),
    3_000,
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
  await sleep(400);
  expect(seenUp).toContain('cluster-e@10.0.4.2:9002');

  await stopNode(n2);
  await sleep(600);
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
    await waitFor(() => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2, 2000);

    // B leaves gracefully → A holds a tombstone for B.
    await nodeB.cluster.leave();
    await nodeB.system.terminate();
    await waitFor(() => peek(nodeA.cluster).members.has(`${SYS}@10.0.6.2:6002`)
      && peek(nodeA.cluster).members.get(`${SYS}@10.0.6.2:6002`)!.status === 'removed', 2000);
    expect(peek(nodeA.cluster).members.size).toBe(2); // 1 live + 1 tombstone

    // Wait for TTL + one prune interval — the tombstone must be gone.
    await waitFor(() => peek(nodeA.cluster).members.size === 1, 1500);
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
    await waitFor(() => nodeA.cluster.upMembers().length === 1, 1000);

    // Drive the private mergeMember via a synthesized gossip frame.
    const stalePeer = new NodeAddress(SYS, '10.0.6.99', 6099);
    const staleData = {
      address: stalePeer.toJSON(),
      status: 'removed' as const,
      version: 999,
      roles: [] as string[],
      removedAt: Date.now() - 10_000, // way past the 200ms TTL
    };
    (nodeA.cluster as unknown as { mergeMember(d: unknown): void })
      .mergeMember(staleData);

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
    await waitFor(() => nodeA.cluster.upMembers().length === 1, 1000);

    const oldPeer = new NodeAddress(SYS, '10.0.6.21', 6021);
    const noAgeTombstone = {
      address: oldPeer.toJSON(),
      status: 'removed' as const,
      version: 5,
      roles: [] as string[],
      // removedAt deliberately omitted.
    };
    (nodeA.cluster as unknown as { mergeMember(d: unknown): void })
      .mergeMember(noAgeTombstone);

    // Tombstone is in the map — `mergeMember`'s expired-tombstone
    // guard only triggers when `removedAt` IS set.
    expect(peek(nodeA.cluster).members.has(oldPeer.toString())).toBe(true);

    // Wait several prune intervals — tombstone must persist.
    await sleep(300);
    expect(peek(nodeA.cluster).members.has(oldPeer.toString())).toBe(true);
    expect(peek(nodeA.cluster).members.get(oldPeer.toString())!.status).toBe('removed');

    await nodeA.cluster.leave();
    await nodeA.system.terminate();
  });
});
