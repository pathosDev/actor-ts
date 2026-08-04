import { match } from 'ts-pattern';
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { hashShardId } from '../../../../../src/cluster/sharding/ShardAllocator.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { regionSegments } from '../../../../util/systemPaths.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';

/**
 * A shard ref for a shard on *another* node used to be a plain path ref
 * (#901).  That was fine while an allocated shard always had a running actor,
 * but since #892 an empty one is stopped — and then nothing resolved the path
 * on the owning node, so the message fell through to the envelope catch-all
 * and was dropped.  Remote shard traffic now goes through the owning region,
 * which materialises the shard first.
 */

type WorkCommand = { id: string; kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';
const NUM_SHARDS = 8;
const ENTITY_ID = 'user-1';

let created = 0;

class Entity extends Actor<Command> {
  override preStart(): void { created++; }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void {}
}

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(stepMs);
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

type Node = {
  system: ActorSystem;
  cluster: Cluster;
  region: ActorRef<Command>;
};

let running: Node[] = [];

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
    .withEntityActor(() => new Entity())
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    .withPassivationIdleMs(60)
    .withShardPassivationIdleMs(60);

  const region = cluster.sharding.start<Command>(shardingOptions);
  const node = { system, cluster, region };
  running.push(node);
  return node;
}

/** Which node currently has a live shard actor for `entityId`'s shard. */
function nodesHostingShard(nodes: Node[], entityId: string): Node[] {
  return nodes.filter((node) => node.system._resolvePath([
    ...regionSegments(node.system.name, TYPE_NAME),
    `shard-${hashShardId(entityId, NUM_SHARDS)}`,
  ]).isSome());
}

/** Which node currently has the entity actor itself. */
function nodesHostingEntity(nodes: Node[], entityId: string): Node[] {
  return nodes.filter((node) => node.system._resolvePath([
    ...regionSegments(node.system.name, TYPE_NAME),
    `shard-${hashShardId(entityId, NUM_SHARDS)}`,
    `entity-${entityId}`,
  ]).isSome());
}

afterEach(async () => {
  for (const node of running) {
    await node.cluster.leave();
    await node.system.terminate();
  }
  running = [];
  created = 0;
});

describe('ClusterSharding — remote shard refs across passivation (#901)', () => {
  test('a ref to a passivated remote shard still delivers', async () => {
    const systemName = 'remote-shard-ref';
    const base = 47_400;
    const seed = await startNode(systemName, base);
    const other = await startNode(systemName, base + 1, [`${systemName}@h:${base}`]);
    const nodes = [seed, other];
    await waitFor(() => nodes.every((node) => node.cluster.upMembers().length === 2));
    await sleep(200);

    // Place the shard somewhere, then work out who is *not* hosting it — the
    // allocation strategy picks, so the test must not assume.
    seed.region.tell({ id: ENTITY_ID, kind: 'work' });
    await waitFor(() => created === 1);
    await waitFor(() => nodesHostingEntity(nodes, ENTITY_ID).length === 1);
    const host = nodesHostingEntity(nodes, ENTITY_ID)[0]!;
    const asker = nodes.find((node) => node !== host)!;

    // Entity goes first, then the shard it left empty.
    await waitFor(() => nodesHostingShard(nodes, ENTITY_ID).length === 0, 10_000);

    // The ref is minted on the asking node, for a shard that is not running
    // anywhere.  Before #901 this message went to a path nothing resolved.
    const shardId = hashShardId(ENTITY_ID, NUM_SHARDS);
    const shard = await asker.cluster.sharding.shardRefFor<Command>(TYPE_NAME, shardId);
    shard.tell({ $t: 'sharding.StartEntity', entityId: ENTITY_ID });

    await waitFor(() => created === 2);
    await waitFor(() => nodesHostingEntity([host], ENTITY_ID).length === 1);
  }, 30_000);

  test('the ref keeps the shard path as its identity, not the region path', async () => {
    // Callers compare, log and key maps on `ref.path`; routing through the
    // region must not leak into what the ref claims to be.
    const systemName = 'remote-shard-path';
    const base = 47_402;
    const seed = await startNode(systemName, base);
    const other = await startNode(systemName, base + 1, [`${systemName}@h:${base}`]);
    const nodes = [seed, other];
    await waitFor(() => nodes.every((node) => node.cluster.upMembers().length === 2));
    await sleep(200);

    seed.region.tell({ id: ENTITY_ID, kind: 'work' });
    await waitFor(() => nodesHostingEntity(nodes, ENTITY_ID).length === 1);
    const host = nodesHostingEntity(nodes, ENTITY_ID)[0]!;
    const asker = nodes.find((node) => node !== host)!;

    const shardId = hashShardId(ENTITY_ID, NUM_SHARDS);
    const shard = await asker.cluster.sharding.shardRefFor<Command>(TYPE_NAME, shardId);

    expect(shard.path.toString()).toContain(`shard-${shardId}`);
    expect(shard.toString()).toContain(`shard-${shardId}`);
  }, 30_000);

  test('shards() reports whether each shard actor is materialised', async () => {
    const systemName = 'remote-shard-resident';
    const base = 47_404;
    const seed = await startNode(systemName, base);
    const other = await startNode(systemName, base + 1, [`${systemName}@h:${base}`]);
    const nodes = [seed, other];
    await waitFor(() => nodes.every((node) => node.cluster.upMembers().length === 2));
    await sleep(200);

    seed.region.tell({ id: ENTITY_ID, kind: 'work' });
    await waitFor(() => created === 1);
    await waitFor(() => nodesHostingEntity(nodes, ENTITY_ID).length === 1);
    const host = nodesHostingEntity(nodes, ENTITY_ID)[0]!;
    const asker = nodes.find((node) => node !== host)!;
    const shardId = hashShardId(ENTITY_ID, NUM_SHARDS);

    // Asked from the other node on purpose: listing a *local* shard
    // materialises it, which would be the very thing under test.
    const before = await asker.cluster.sharding.shards<Command>(TYPE_NAME);
    expect(before.find((shard) => shard.shardId === shardId)?.resident).toBe(true);

    await waitFor(() => nodesHostingShard(nodes, ENTITY_ID).length === 0, 10_000);

    const after = await asker.cluster.sharding.shards<Command>(TYPE_NAME);
    const entry = after.find((shard) => shard.shardId === shardId);
    // Still allocated and still listed — just not running.
    expect(entry).toBeDefined();
    expect(entry?.resident).toBe(false);
    expect(entry?.entityCount).toBe(0);
  }, 30_000);
});
