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
import { shardName } from '../../../../../src/cluster/sharding/ShardRegion.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import type { StartShardingOptionsBuilder } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';

/**
 * The `actor-ts.sharding.*` block used to be documented but never read (#834,
 * part of #653).  These tests drive it end to end through
 * `ClusterSharding.start` — the only funnel that feeds both the region and its
 * coordinator — rather than asserting on the reader in isolation.
 */

type WorkCommand = { id: string; kind: 'work' };

type Command = WorkCommand;

/** Incarnation counters — passivation is observable as a stop, then a fresh start. */
let created = 0;
let stopped = 0;

class Entity extends Actor<Command> {
  override preStart(): void { created++; }
  override postStop(): void { stopped++; }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  /** Receiving anything resets the region's idle timer — that is the whole point. */
  private onWork(): void {}
}

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(pred: () => boolean, timeoutMs = 5_000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(stepMs);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

type Node = {
  system: ActorSystem;
  cluster: Cluster;
  region: ActorRef<Command>;
};

let running: Node | null = null;

/**
 * Single-node cluster whose ActorSystem is built on `config`, with a region
 * started from `options` (omitted = nothing explicit, so HOCON alone decides).
 */
async function startNode(
  systemName: string,
  port: number,
  config: Record<string, unknown>,
  options?: (builder: StartShardingOptionsBuilder<Command>) => void,
): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(config);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);

  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName('entity')
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id);
  options?.(shardingOptions);

  const region = cluster.sharding.start<Command>(shardingOptions);
  const node = { system, cluster, region };
  running = node;
  return node;
}

afterEach(async () => {
  if (running) {
    await running.cluster.leave();
    await running.system.terminate();
    running = null;
  }
  created = 0;
  stopped = 0;
});

describe('ClusterSharding — actor-ts.sharding.* HOCON keys', () => {
  test('passivation-idle alone passivates an idle entity', async () => {
    const node = await startNode('hocon-passivate', 45_400, {
      'actor-ts': { sharding: { 'passivation-idle': '120ms' } },
    });

    node.region.tell({ id: 'user-1', kind: 'work' });
    await waitFor(() => created === 1);

    // Nothing else is sent, so the region's idle sweep is the only thing that
    // can stop it.  Before #834 this waited forever.
    await waitFor(() => stopped === 1);

    // And the entity comes back on the next message, same as a manual passivation.
    node.region.tell({ id: 'user-1', kind: 'work' });
    await waitFor(() => created === 2);
  });

  test('the reference default leaves an entity resident through a short idle spell', async () => {
    // `passivation-idle` defaults to 5 minutes, which is also the sweep
    // interval — so nothing may stop this entity anywhere near a test window.
    const node = await startNode('hocon-default', 45_401, {});

    node.region.tell({ id: 'user-1', kind: 'work' });
    await waitFor(() => created === 1);

    await sleep(400);
    expect(stopped).toBe(0);
  });

  test('passivation-idle = 0ms opts back out of the default sweep', async () => {
    // The documented migration off the 5-minute default.  `0` is a real value
    // rather than "unset", so it has to shadow the reference default instead of
    // falling through to it — the same distinction `mergeOptions` draws.
    const node = await startNode('hocon-disabled', 45_405, {
      'actor-ts': { sharding: { 'passivation-idle': '0ms' } },
    });

    node.region.tell({ id: 'user-1', kind: 'work' });
    await waitFor(() => created === 1);

    await sleep(400);
    expect(stopped).toBe(0);
  });

  test('an explicit passivationIdleMs beats the config file', async () => {
    const node = await startNode(
      'hocon-explicit',
      45_402,
      { 'actor-ts': { sharding: { 'passivation-idle': '1 hour' } } },
      (builder) => builder.withPassivationIdleMs(120),
    );

    node.region.tell({ id: 'user-1', kind: 'work' });
    await waitFor(() => created === 1);

    // An hour would outlast the test; 120ms is the explicit option winning.
    await waitFor(() => stopped === 1);
  });

  test('max-entities caps the node and LRU-passivates the coldest entity', async () => {
    const node = await startNode('hocon-cap', 45_404, {
      'actor-ts': { sharding: { 'max-entities': 2 } },
    });

    // Distinct ids in a stable order, so the first one is unambiguously the LRU.
    node.region.tell({ id: 'user-1', kind: 'work' });
    await waitFor(() => created === 1);
    node.region.tell({ id: 'user-2', kind: 'work' });
    await waitFor(() => created === 2);

    // The third entity is one too many: the region evicts `user-1` to make room.
    node.region.tell({ id: 'user-3', kind: 'work' });
    await waitFor(() => created === 3);
    await waitFor(() => stopped === 1);
  });

  test('number-of-shards reaches the region — entity ids hash into the configured space', async () => {
    const node = await startNode('hocon-shards', 45_403, {
      'actor-ts': { sharding: { 'number-of-shards': 4 } },
    });

    const entity = node.cluster.sharding.entityRefFor<Command>('entity', 'user-42');
    const segments = entity.path.toString().split('/');

    expect(segments).toContain(shardName(hashShardId('user-42', 4)));
    // Deterministic proof it is not simply the built-in 64 — the two disagree
    // for this id, which is why it was picked.
    expect(hashShardId('user-42', 4)).not.toBe(hashShardId('user-42', 64));
    expect(segments).not.toContain(shardName(hashShardId('user-42', 64)));
  });
});
