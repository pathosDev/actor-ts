/**
 * Stopping a ShardRegion used to orphan its shards (#648).
 *
 * `postStop` unsubscribed from cluster events and cancelled four timers — it
 * never told the coordinator.  `RegionTerminated` existed and was handled
 * completely and correctly, but its only construction site in the tree was
 * `onMemberRemoved` synthesising one per region on a departed node.  So with
 * the node still in the cluster, nothing removed the stopped region: the
 * coordinator went on answering `GetShardHome` with it, senders cached that
 * dead home and delivered into a stopped cell, and the messages became dead
 * letters.  Nor did it self-heal — `candidates()` is built from the registry
 * with no liveness check, so the rebalance tick saw a perfectly balanced
 * cluster and moved nothing.  The state was permanent until the node left.
 *
 * Note what the failure mode is *not*: senders do not buffer.  A region
 * buffers only while it has no cached home, and here it has one.
 */
import { match } from 'ts-pattern';
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { hashShardId } from '../../../../../src/cluster/sharding/ShardAllocator.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { regionSegments } from '../../../../util/SystemPaths.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

type WorkCommand = { id: string; kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';
const NUM_SHARDS = 16;

let delivered = 0;

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { delivered++; }
}

type Node = {
  system: ActorSystem;
  cluster: Cluster;
  region: ActorRef<Command>;
};

const running: Node[] = [];

afterEach(async () => {
  for (const node of running.splice(0)) {
    await node.cluster.leave().catch(() => { /* best-effort */ });
    await node.system.terminate().catch(() => { /* best-effort */ });
  }
  delivered = 0;
});

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
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    .withPassivationIdleMs(0);
  const region = cluster.sharding.start<Command>(shardingOptions);
  const node = { system, cluster, region };
  running.push(node);
  return node;
}

/** The region actor itself — `ClusterSharding` hands out a ref, not a handle. */
function regionActor(node: Node): ActorRef<unknown> {
  const resolved = node.system._resolvePath(regionSegments(node.system.name, TYPE_NAME));
  if (resolved.isNone()) throw new Error('region actor not found');
  return resolved.value as ActorRef<unknown>;
}

function hostsShard(node: Node, shardId: number): boolean {
  return node.system._resolvePath([
    ...regionSegments(node.system.name, TYPE_NAME),
    `shard-${shardId}`,
  ]).isSome();
}

describe('ClusterSharding — stopping a region (#648)', () => {
  test('the coordinator reallocates a stopped region\'s shards without a membership change', async () => {
    const systemName = 'region-stop';
    const base = 47_500;
    // The seed is the leader, so it hosts the active coordinator.
    const seed = await startNode(systemName, base);
    const other = await startNode(systemName, base + 1, [`${systemName}@h:${base}`]);
    const nodes = [seed, other];

    await awaitCondition(() => nodes.every((node) => node.cluster.upMembers().length === 2), {
      timeoutMs: 5_000,
      label: 'the two-node cluster converged',
    });

    // `HashAllocationStrategy` places shard n on `sorted[n % 2]`, and the seed
    // sorts first — so an odd shard id belongs to the other node.
    const entityId = ['user-1', 'user-2', 'user-3', 'user-4', 'user-5', 'user-6']
      .find((id) => hashShardId(id, NUM_SHARDS) % 2 === 1);
    expect(entityId).toBeDefined();
    const shardId = hashShardId(entityId!, NUM_SHARDS);

    seed.region.tell({ id: entityId!, kind: 'work' });
    await awaitCondition(() => delivered === 1, {
      timeoutMs: 5_000,
      label: 'the entity came up on the node that owns its shard',
    });
    expect(hostsShard(other, shardId)).toBe(true);
    expect(hostsShard(seed, shardId)).toBe(false);

    // Stop just the region.  The node stays in the cluster, which is the whole
    // point: no `MemberRemoved` fires, so `onMemberRemoved` cannot cover this.
    regionActor(other).stop();

    await awaitCondition(() => hostsShard(seed, shardId), {
      timeoutMs: 5_000,
      label: 'the surviving region was given the orphaned shard',
    });
    // Membership never moved — the reallocation came from the region's own
    // shutdown, not from the failure detector.
    expect(nodes.every((node) => node.cluster.upMembers().length === 2)).toBe(true);

    // And the shard is genuinely usable again, not merely re-listed.
    seed.region.tell({ id: entityId!, kind: 'work' });
    await awaitCondition(() => delivered === 2, {
      timeoutMs: 5_000,
      label: 'traffic reaches the entity at its new home',
    });
  }, 30_000);
});
