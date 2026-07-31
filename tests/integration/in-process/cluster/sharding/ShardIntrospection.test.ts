import { match } from 'ts-pattern';
import { describe, expect, test } from 'bun:test';
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
import { Props } from '../../../../../src/Props.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';

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

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 20): Promise<void> {
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
    .withEntityProps(Props.create(() => new CounterEntity()))
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
  const segments = [
    'user',
    `sharding-${TYPE_NAME}`,
    `shard-${hashShardId(entityId, NUM_SHARDS)}`,
    `entity-${entityId}`,
  ];
  return nodes.filter((node) => node.system._resolvePath(segments).isSome());
}

describe('Shard actors', () => {
  test('an entity lives under its shard, on exactly one node', async () => {
    const systemName = 'shard-tree';
    const base = 45_900;
    const seed = await startNode(systemName, base);
    const other = await startNode(systemName, base + 1, [`${systemName}@h:${base}`]);
    const nodes = [seed, other];

    await waitFor(() => nodes.every((node) => node.cluster.upMembers().length === 2));
    await sleep(200);

    // Two ids that hash into different shards, so at least one of them very
    // likely lands on the non-seed node.
    for (const entityId of ['alpha', 'beta', 'gamma', 'delta']) {
      seed.region.tell({ id: entityId, kind: 'increment' });
    }
    await waitFor(() => nodesHosting(nodes, 'alpha').length === 1);

    for (const entityId of ['alpha', 'beta', 'gamma', 'delta']) {
      expect(nodesHosting(nodes, entityId)).toHaveLength(1);
    }

    await stopAll(nodes);
  }, 20_000);
});

describe('ClusterSharding.entityRefFor', () => {
  test('addresses an entity by id, without a routing key in the message', async () => {
    const systemName = 'entity-ref-local';
    const base = 46_000;
    const seed = await startNode(systemName, base);

    await waitFor(() => seed.cluster.upMembers().length === 1);
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
    await sleep(200);

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
