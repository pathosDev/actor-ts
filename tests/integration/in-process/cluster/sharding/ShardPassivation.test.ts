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
import type { StartShardingOptionsBuilder } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import type { ShardStats } from '../../../../../src/cluster/sharding/ShardingProtocol.js';
import { regionSegments } from '../../../../util/SystemPaths.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';

/**
 * Shard-level passivation (#892).  A shard used to outlive its entities
 * forever: it appears when the coordinator allocates it here and, apart from a
 * handoff, nothing ever stopped it again.  These drive the region's second
 * sweep end to end — through `ClusterSharding.start`, not against the sweep in
 * isolation — because the part worth protecting is that a stopped shard is
 * invisible to callers.
 */

type WorkCommand = { id: string; kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';
const NUM_SHARDS = 4;

/** Incarnation counters — passivation is observable as a stop, then a fresh start. */
let created = 0;
let stopped = 0;
let delivered = 0;

class Entity extends Actor<Command> {
  override preStart(): void { created++; }
  override postStop(): void { stopped++; }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { delivered++; }
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

let running: Node | null = null;

async function startNode(
  systemName: string,
  port: number,
  options: (builder: StartShardingOptionsBuilder<Command>) => void,
): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);

  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS);
  options(shardingOptions);

  const region = cluster.sharding.start<Command>(shardingOptions);
  const node = { system, cluster, region };
  running = node;
  return node;
}

/** Is the shard actor for `entityId` currently alive in the tree? */
function shardIsUp(node: Node, entityId: string): boolean {
  return node.system._resolvePath([
    ...regionSegments(node.system.name, TYPE_NAME),
    `shard-${hashShardId(entityId, NUM_SHARDS)}`,
  ]).isSome();
}

/** Is the entity actor itself alive? */
function entityIsUp(node: Node, entityId: string): boolean {
  return node.system._resolvePath([
    ...regionSegments(node.system.name, TYPE_NAME),
    `shard-${hashShardId(entityId, NUM_SHARDS)}`,
    `entity-${entityId}`,
  ]).isSome();
}

afterEach(async () => {
  if (running) {
    await running.cluster.leave();
    await running.system.terminate();
    running = null;
  }
  created = 0;
  stopped = 0;
  delivered = 0;
});

describe('ClusterSharding — shard passivation (#892)', () => {
  test('a shard left empty stops after its window', async () => {
    const node = await startNode('shard-passivate', 47_100, (builder) => {
      builder.withPassivationIdleMs(60).withShardPassivationIdleMs(60);
    });

    node.region.tell({ id: 'user-1', kind: 'work' });
    await waitFor(() => created === 1);
    expect(shardIsUp(node, 'user-1')).toBe(true);

    // The entity goes first; only then does the shard's own clock start.
    await waitFor(() => stopped === 1);
    await waitFor(() => !shardIsUp(node, 'user-1'));
  });

  test('the next message brings shard and entity back, transparently', async () => {
    const node = await startNode('shard-recreate', 47_101, (builder) => {
      builder.withPassivationIdleMs(60).withShardPassivationIdleMs(60);
    });

    node.region.tell({ id: 'user-1', kind: 'work' });
    await waitFor(() => created === 1);
    await waitFor(() => !shardIsUp(node, 'user-1'));

    // Ownership survived the stop, so this needs no coordinator round trip.
    node.region.tell({ id: 'user-1', kind: 'work' });
    await waitFor(() => created === 2);
    await waitFor(() => delivered === 2);
    expect(shardIsUp(node, 'user-1')).toBe(true);
    expect(entityIsUp(node, 'user-1')).toBe(true);
  });

  test('no message is lost across repeated passivation cycles', async () => {
    // The regression that matters.  Each round crosses a full stop/recreate,
    // and the sends are unsynchronised with the sweep, so over enough rounds
    // some land while the shard is mid-stop — the case `route` has to buffer
    // rather than deliver into a draining mailbox.
    const node = await startNode('shard-noloss', 47_102, (builder) => {
      builder.withPassivationIdleMs(30).withShardPassivationIdleMs(30);
    });

    const rounds = 25;
    for (let round = 0; round < rounds; round++) {
      node.region.tell({ id: 'user-1', kind: 'work' });
      await sleep(35);
    }

    await waitFor(() => delivered === rounds);
    expect(delivered).toBe(rounds);
  });

  test('a shard holding a live entity is left alone', async () => {
    const node = await startNode('shard-busy', 47_103, (builder) => {
      // Entities never passivate here, so the shard never becomes empty and
      // the shard sweep must find nothing to do however often it runs.
      builder.withPassivationIdleMs(0).withShardPassivationIdleMs(40);
    });

    node.region.tell({ id: 'user-1', kind: 'work' });
    await waitFor(() => created === 1);

    await sleep(300);
    expect(stopped).toBe(0);
    expect(shardIsUp(node, 'user-1')).toBe(true);
  });

  test('shardPassivationIdleMs = 0 keeps the shard while entities still passivate', async () => {
    const node = await startNode('shard-optout', 47_104, (builder) => {
      builder.withPassivationIdleMs(50).withShardPassivationIdleMs(0);
    });

    node.region.tell({ id: 'user-1', kind: 'work' });
    await waitFor(() => created === 1);
    await waitFor(() => stopped === 1);

    // The entity went; the shard must not follow it.
    await sleep(250);
    expect(shardIsUp(node, 'user-1')).toBe(true);
  });

  test('shardRefFor hands out a live ref for a passivated shard', async () => {
    const node = await startNode('shard-ref', 47_105, (builder) => {
      builder.withPassivationIdleMs(60).withShardPassivationIdleMs(60);
    });

    node.region.tell({ id: 'user-1', kind: 'work' });
    await waitFor(() => created === 1);
    await waitFor(() => !shardIsUp(node, 'user-1'));

    // A path-addressed ref would be a dead ref here — nothing resolves that
    // path while the shard is down — so asking for one has to materialise it.
    const shardId = hashShardId('user-1', NUM_SHARDS);
    const ref = await node.cluster.sharding.shardRefFor<Command>(TYPE_NAME, shardId);
    const stats = await ref.ask<ShardStats>({ kind: 'sharding.GetShardStats' }, 2_000);

    expect(stats.shardId).toBe(shardId);
    expect(stats.entityCount).toBe(0);
  });
});
