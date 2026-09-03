import { match } from 'ts-pattern';
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { ShardMapChanged } from '../../../../../src/cluster/ClusterEvents.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { hashShardId } from '../../../../../src/cluster/sharding/ShardAllocator.js';
import { shardRegionName } from '../../../../../src/internal/SystemPaths.js';
import { regionSegments } from '../../../../util/SystemPaths.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

type IncrementCommand = { id: string; kind: 'increment' };
type GetCommand = { id: string; kind: 'get' };

type Command = IncrementCommand | GetCommand;

const NUM_SHARDS = 16;
const TYPE_NAME = 'entity';

class CounterEntity extends Actor<Command> {
  private value = 0;

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'increment' }, () => this.onIncrement())
      .with({ kind: 'get' }, () => this.onGet())
      .exhaustive();
  }

  private onIncrement(): void { this.value++; }

  private onGet(): void { this.sender.forEach((s) => s.tell(this.value)); }
}

/**
 * Kept as a name so every call site here stays unchanged; the body forwards to
 * the shared helper (#418), which names the awaited state in its timeout message
 * and — unlike the deadline loop it replaces — cannot fall through silently.
 */
const waitFor = (
  predicate: () => boolean,
  timeoutMs = 5_000,
  stepMs = 20,
  label = 'the awaited shard-introspection state',
): Promise<void> => awaitCondition(predicate, { timeoutMs, intervalMs: stepMs, label });

type Node = {
  system: ActorSystem;
  cluster: Cluster;
  region: ActorRef<Command>;
};

async function startNode(systemName: string, port: number, seeds: string[] = []): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(CounterEntity)
    .withExtractEntityId((m) => m.id)
    .withNumShards(NUM_SHARDS);
  const region = cluster.sharding.start<Command>(shardingOptions);
  return { system, cluster, region };
}

async function stopAll(nodes: Node[]): Promise<void> {
  for (const node of nodes) { await node.cluster.leave(); await node.system.terminate(); }
}

/** Which of the given nodes currently hosts `entityId` as a live actor. */
function nodesHosting(nodes: Node[], entityId: string): Node[] {
  return nodes.filter((node) => node.system._resolvePath([
    ...regionSegments(node.system.name, TYPE_NAME),
    `shard-${hashShardId(entityId, NUM_SHARDS)}`,
    `entity-${entityId}`,
  ]).isSome());
}

describe('Shard actors', () => {
  test('an entity lives under its shard, on exactly one node', async () => {
    const systemName = 'shard-tree';
    const base = 45_900;
    const seed = await startNode(systemName, base);
    const other = await startNode(systemName, base + 1, [`${systemName}@h:${base}`]);
    const nodes = [seed, other];

    await waitFor(() => nodes.every((node) => node.cluster.upMembers().length === 2));
    // Membership convergence is not registration: a region registers with the
    // coordinator on the leader, over a retry timer of its own, so a converged
    // cluster can still hold an unregistered region.  This waits on the
    // registration itself, which the fixed sleep here only approximated (#1317).
    //
    // The sleep was never protecting the message: one sent before registration
    // is buffered by the region and delivered once a shard home arrives.  What
    // it was protecting is the ask below, whose own deadline runs while the
    // message waits in that buffer.
    await waitFor(() => nodes.every((node) => node.cluster.sharding.isRegistered(TYPE_NAME)));

    // Two ids that hash into different shards, so at least one of them very
    // likely lands on the non-seed node.
    const entityIds = ['alpha', 'beta', 'gamma', 'delta'];
    for (const entityId of entityIds) seed.region.tell({ id: entityId, kind: 'increment' });
    // Each id waits on its own shard being placed, so they land independently.
    await waitFor(() => entityIds.every((id) => nodesHosting(nodes, id).length > 0));

    for (const entityId of entityIds) {
      expect(nodesHosting(nodes, entityId)).toHaveLength(1);
    }

    await stopAll(nodes);
  }, 20_000);
});

describe('ShardMapChanged', () => {
  test('fires on every node, carrying the assignment map and the regions', async () => {
    const systemName = 'shard-map';
    const base = 46_900;
    const seed = await startNode(systemName, base);
    const other = await startNode(systemName, base + 1, [`${systemName}@h:${base}`]);
    const nodes = [seed, other];

    const seen = new Map<Node, ShardMapChanged[]>([[seed, []], [other, []]]);
    for (const node of nodes) {
      node.cluster.subscribe((event) => {
        if (event instanceof ShardMapChanged) seen.get(node)!.push(event);
      });
    }

    await waitFor(() => nodes.every((node) => node.cluster.upMembers().length === 2));
    // Membership convergence is not registration: a region registers with the
    // coordinator on the leader, over a retry timer of its own, so a converged
    // cluster can still hold an unregistered region.  This waits on the
    // registration itself, which the fixed sleep here only approximated (#1317).
    //
    // The sleep was never protecting the message: one sent before registration
    // is buffered by the region and delivered once a shard home arrives.  What
    // it was protecting is the ask below, whose own deadline runs while the
    // message waits in that buffer.
    await waitFor(() => nodes.every((node) => node.cluster.sharding.isRegistered(TYPE_NAME)));

    for (const entityId of ['m-1', 'm-2', 'm-3', 'm-4']) {
      seed.region.tell({ id: entityId, kind: 'increment' });
    }
    // The first broadcast goes out when the regions register, before any
    // shard has a home — wait for one that actually carries an assignment.
    await waitFor(() => nodes.every((node) => seen.get(node)!.some((e) => e.shards.size > 0)));

    for (const node of nodes) {
      const last = seen.get(node)!.filter((e) => e.shards.size > 0).at(-1)!;
      expect(last.type).toBe(TYPE_NAME);
      expect(last.version).toBeGreaterThan(0);
      expect(last.shards.size).toBeGreaterThan(0);
      // Region detail travels with the event, so the DevTools panel does not
      // have to read the coordinator's DistributedData snapshot.
      expect(last.regions.length).toBeGreaterThan(0);
      for (const region of last.regions) {
        expect(region.path).toContain(shardRegionName(TYPE_NAME));
        expect(region.proxy).toBe(false);
      }
    }

    // A burst of placements is coalesced — four entities do not mean four
    // broadcasts per shard.
    expect(seen.get(seed)!.length).toBeLessThan(NUM_SHARDS);

    await stopAll(nodes);
  }, 20_000);
});

describe('ClusterSharding.shards', () => {
  test('lists every placed shard cluster-wide, with entity counts and refs', async () => {
    const systemName = 'shard-list';
    const base = 46_400;
    const seed = await startNode(systemName, base);
    const other = await startNode(systemName, base + 1, [`${systemName}@h:${base}`]);
    const nodes = [seed, other];

    await waitFor(() => nodes.every((node) => node.cluster.upMembers().length === 2));
    // Membership convergence is not registration: a region registers with the
    // coordinator on the leader, over a retry timer of its own, so a converged
    // cluster can still hold an unregistered region.  This waits on the
    // registration itself, which the fixed sleep here only approximated (#1317).
    //
    // The sleep was never protecting the message: one sent before registration
    // is buffered by the region and delivered once a shard home arrives.  What
    // it was protecting is the ask below, whose own deadline runs while the
    // message waits in that buffer.
    await waitFor(() => nodes.every((node) => node.cluster.sharding.isRegistered(TYPE_NAME)));

    const entityIds = ['s-1', 's-2', 's-3', 's-4', 's-5', 's-6'];
    for (const entityId of entityIds) seed.region.tell({ id: entityId, kind: 'increment' });
    await waitFor(() => entityIds.every((id) => nodesHosting(nodes, id).length === 1));

    const shards = await seed.cluster.sharding.shards<Command>(TYPE_NAME);

    // Every id we touched shows up in exactly one shard's count.
    const totalEntities = shards.reduce((sum, shard) => sum + shard.entityCount, 0);
    expect(totalEntities).toBe(entityIds.length);

    // Shard ids are unique, in range, and each carries a usable ref.
    const shardIds = shards.map((shard) => shard.shardId);
    expect(new Set(shardIds).size).toBe(shardIds.length);
    for (const shard of shards) {
      expect(shard.shardId).toBeGreaterThanOrEqual(0);
      expect(shard.shardId).toBeLessThan(NUM_SHARDS);
      // Holds for a remote ref too since #515 — a RemoteActorRef's path now
      // round-trips back to the path it points at.
      expect(shard.ref.path.toString()).toContain(`shard-${shard.shardId}`);
      expect(shard.regionPath).toContain(shardRegionName(TYPE_NAME));
    }

    // The same query from the other node sees the same placement.
    const fromOther = await other.cluster.sharding.shards<Command>(TYPE_NAME);
    expect(new Set(fromOther.map((s) => s.shardId))).toEqual(new Set(shardIds));
    expect(fromOther.filter((s) => s.local).length).toBe(shards.filter((s) => !s.local).length);

    await stopAll(nodes);
  }, 20_000);

  test('rejects a type that was never started on this node', async () => {
    const systemName = 'shard-list-unknown';
    const base = 46_500;
    const seed = await startNode(systemName, base);

    await expect(seed.cluster.sharding.shards('never-started'))
      .rejects.toThrow(/no region for type 'never-started'/);

    await stopAll([seed]);
  }, 20_000);
});

describe('ClusterSharding.shardRefFor', () => {
  test('places an untouched shard and answers with its ref', async () => {
    const systemName = 'shard-ref';
    const base = 46_600;
    const seed = await startNode(systemName, base);

    await waitFor(() => seed.cluster.upMembers().length === 1);
    // Same coordinator-registration settle as the two-node cases: the region's
    // registration has no observable, and the asks below carry their own budget.
    await sleep(100);

    const before = await seed.cluster.sharding.shards<Command>(TYPE_NAME);
    expect(before.map((shard) => shard.shardId)).not.toContain(3);

    const shard = await seed.cluster.sharding.shardRefFor<Command>(TYPE_NAME, 3);
    expect(shard.path.toString()).toContain(`${shardRegionName(TYPE_NAME)}/shard-3`);

    const after = await seed.cluster.sharding.shards<Command>(TYPE_NAME);
    expect(after.map((s) => s.shardId)).toContain(3);

    await stopAll([seed]);
  }, 20_000);

  test('a local shard ref answers GetShardStats and starts entities', async () => {
    const systemName = 'shard-stats';
    const base = 46_700;
    const seed = await startNode(systemName, base);

    await waitFor(() => seed.cluster.upMembers().length === 1);
    // Same coordinator-registration settle as the two-node cases: the region's
    // registration has no observable, and the asks below carry their own budget.
    await sleep(100);

    const entityId = 'stats-1';
    const shardId = hashShardId(entityId, NUM_SHARDS);
    const shard = await seed.cluster.sharding.shardRefFor<Command>(TYPE_NAME, shardId);

    const empty = await shard.ask<{ entityCount: number }>({ kind: 'sharding.GetShardStats' }, 3_000);
    expect(empty.entityCount).toBe(0);

    shard.tell({ kind: 'sharding.StartEntity', entityId });
    await waitFor(() => nodesHosting([seed], entityId).length === 1);

    const filled = await shard.ask<{ entityCount: number; entityIds: ReadonlyArray<string> }>(
      { kind: 'sharding.GetShardStats' }, 3_000,
    );
    expect(filled.entityCount).toBe(1);
    expect(filled.entityIds).toEqual([entityId]);

    await stopAll([seed]);
  }, 20_000);

  test('a remote shard ref routes an entity envelope to its entity', async () => {
    const systemName = 'shard-ref-remote';
    const base = 46_800;
    const seed = await startNode(systemName, base);
    const other = await startNode(systemName, base + 1, [`${systemName}@h:${base}`]);
    const nodes = [seed, other];

    await waitFor(() => nodes.every((node) => node.cluster.upMembers().length === 2));
    // Membership convergence is not registration: a region registers with the
    // coordinator on the leader, over a retry timer of its own, so a converged
    // cluster can still hold an unregistered region.  This waits on the
    // registration itself, which the fixed sleep here only approximated (#1317).
    //
    // The sleep was never protecting the message: one sent before registration
    // is buffered by the region and delivered once a shard home arrives.  What
    // it was protecting is the ask below, whose own deadline runs while the
    // message waits in that buffer.
    await waitFor(() => nodes.every((node) => node.cluster.sharding.isRegistered(TYPE_NAME)));

    const candidates = ['r-1', 'r-2', 'r-3', 'r-4', 'r-5', 'r-6', 'r-7', 'r-8'];
    for (const entityId of candidates) seed.region.tell({ id: entityId, kind: 'increment' });
    await waitFor(() => candidates.some((id) => nodesHosting([other], id).length === 1));

    const remoteId = candidates.find((id) => nodesHosting([other], id).length === 1)!;
    const shard = await seed.cluster.sharding.shardRefFor<Command>(
      TYPE_NAME, hashShardId(remoteId, NUM_SHARDS),
    );
    expect(shard.path.toString()).toContain(
      `${shardRegionName(TYPE_NAME)}/shard-${hashShardId(remoteId, NUM_SHARDS)}`,
    );

    shard.tell({
      kind: 'sharding.EntityEnvelope',
      entityId: remoteId,
      message: { id: remoteId, kind: 'increment' },
    });

    // The envelope and the query travel through different refs, so poll for
    // the increment rather than assuming they arrive in order.
    const entity = seed.cluster.sharding.entityRefFor<Command>(TYPE_NAME, remoteId);
    // `=== 2` is safe to poll on even though it is an exact count: the entity is
    // sent exactly two increments and the counter only grows, so 2 is the
    // terminal value rather than one a later arrival could exceed.
    let value = 0;
    await awaitCondition(
      async () => (value = await entity.ask<number>({ kind: 'get' } as Command, 3_000)) === 2,
      { timeoutMs: 5_000, intervalMs: 25, label: 'both increments reached the remote entity' },
    );
    expect(value).toBe(2);

    await stopAll(nodes);
  }, 20_000);
});

describe('ClusterSharding.entityRefFor', () => {
  test('addresses an entity by id, without a routing key in the message', async () => {
    const systemName = 'entity-ref-local';
    const base = 46_000;
    const seed = await startNode(systemName, base);

    await waitFor(() => seed.cluster.upMembers().length === 1);
    // Same coordinator-registration settle as the two-node cases: the region's
    // registration has no observable, and the asks below carry their own budget.
    await sleep(100);

    const entity = seed.cluster.sharding.entityRefFor<Command>(TYPE_NAME, 'counter-1');
    entity.tell({ kind: 'increment' } as Command);
    entity.tell({ kind: 'increment' } as Command);
    const value = await entity.ask<number>({ kind: 'get' } as Command, 3_000);

    expect(value).toBe(2);

    await stopAll([seed]);
  }, 20_000);

  test('reaches an entity hosted on another node', async () => {
    const systemName = 'entity-ref-remote';
    const base = 46_100;
    const seed = await startNode(systemName, base);
    const other = await startNode(systemName, base + 1, [`${systemName}@h:${base}`]);
    const nodes = [seed, other];

    await waitFor(() => nodes.every((node) => node.cluster.upMembers().length === 2));
    // Membership convergence is not registration: a region registers with the
    // coordinator on the leader, over a retry timer of its own, so a converged
    // cluster can still hold an unregistered region.  This waits on the
    // registration itself, which the fixed sleep here only approximated (#1317).
    //
    // The sleep was never protecting the message: one sent before registration
    // is buffered by the region and delivered once a shard home arrives.  What
    // it was protecting is the ask below, whose own deadline runs while the
    // message waits in that buffer.
    await waitFor(() => nodes.every((node) => node.cluster.sharding.isRegistered(TYPE_NAME)));

    // Warm every candidate id from the seed, then pick one the *other* node
    // ended up hosting — that is the ref path we actually want to exercise.
    const candidates = ['a-1', 'a-2', 'a-3', 'a-4', 'a-5', 'a-6', 'a-7', 'a-8'];
    for (const entityId of candidates) seed.region.tell({ id: entityId, kind: 'increment' });
    await waitFor(() => candidates.some((id) => nodesHosting([other], id).length === 1));

    const remoteId = candidates.find((id) => nodesHosting([other], id).length === 1)!;
    const entity = seed.cluster.sharding.entityRefFor<Command>(TYPE_NAME, remoteId);
    entity.tell({ kind: 'increment' } as Command);
    const value = await entity.ask<number>({ kind: 'get' } as Command, 3_000);

    // One increment through the region during warm-up, one through the handle.
    expect(value).toBe(2);

    await stopAll(nodes);
  }, 20_000);

  test('identifies the entity: same id equal, different id not', async () => {
    const systemName = 'entity-ref-identity';
    const base = 46_200;
    const seed = await startNode(systemName, base);

    const sharding = seed.cluster.sharding;
    const first = sharding.entityRefFor<Command>(TYPE_NAME, 'same');
    const second = sharding.entityRefFor<Command>(TYPE_NAME, 'same');
    const third = sharding.entityRefFor<Command>(TYPE_NAME, 'other');

    expect(first.equals(second)).toBe(true);
    expect(first.equals(third)).toBe(false);
    expect(first.path.toString()).toContain(`/shard-${hashShardId('same', NUM_SHARDS)}/entity-same`);

    await stopAll([seed]);
  }, 20_000);

  test('rejects a type that was never started on this node', async () => {
    const systemName = 'entity-ref-unknown';
    const base = 46_300;
    const seed = await startNode(systemName, base);

    expect(() => seed.cluster.sharding.entityRefFor('never-started', 'x'))
      .toThrow(/no region for type 'never-started'/);

    await stopAll([seed]);
  }, 20_000);
});
