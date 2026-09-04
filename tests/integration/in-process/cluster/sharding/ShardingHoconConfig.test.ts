import { match } from 'ts-pattern';
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../../../src/config/HoconParser.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { hashShardId } from '../../../../../src/cluster/sharding/ShardAllocator.js';
import { shardName } from '../../../../../src/cluster/sharding/ShardRegion.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import type { StartShardingOptionsBuilder } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { DeadLetter } from '../../../../../src/SystemMessages.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

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

/** Dead letters seen since the last reset — what `buffer-size` produces on overflow. */
let letters: DeadLetter[] = [];
let subscribedToDeadLetters = false;

const FENCE = 'fence — every earlier letter is already queued';

class DeadLetterListener extends Actor<DeadLetter> {
  override preStart(): void {
    this.system.eventStream.subscribe(this.self, DeadLetter);
    subscribedToDeadLetters = true;
  }
  override onReceive(letter: DeadLetter): void { letters.push(letter); }
}

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

/**
 * Kept as a name so every call site here stays unchanged; the body forwards to
 * the shared helper (#418), which names the awaited state in its timeout message
 * and — unlike the deadline loop it replaces — cannot fall through silently.
 */
const waitFor = (
  predicate: () => boolean,
  timeoutMs = 5_000,
  stepMs = 20,
  label = 'the awaited HOCON-configured sharding state',
): Promise<void> => awaitCondition(predicate, { timeoutMs, intervalMs: stepMs, label });

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
  config: ConfigObject,
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

/**
 * Subscribe the dead-letter listener on a node and hand back the fence.
 *
 * The listener is an ordinary actor, so its mailbox is FIFO: anything
 * published before the fence is delivered before it.  That is what makes
 * "nothing was dead-lettered" a fact rather than a wait that expired.
 */
async function captureDeadLetters(node: Node): Promise<() => Promise<void>> {
  node.system.spawn(DeadLetterListener, 'dead-letter-listener');
  await waitFor(() => subscribedToDeadLetters, 4_000, 20, 'the dead-letter listener subscribed');
  return async () => {
    node.system.deadLetters.tell(FENCE);
    await waitFor(
      () => letters.some((l) => l.message === FENCE),
      4_000, 20, 'the fence letter came back',
    );
  };
}

/** The work commands that were dead-lettered, fence excluded. */
const droppedCommands = (): Command[] =>
  letters.filter((l) => l.message !== FENCE).map((l) => l.message as Command);

afterEach(async () => {
  if (running) {
    await running.cluster.leave();
    await running.system.terminate();
    running = null;
  }
  created = 0;
  stopped = 0;
  letters = [];
  subscribedToDeadLetters = false;
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

    // An absence: nothing may stop the entity inside a test window, so
    // `stopped === 0` is already true at t=0 and there is nothing to poll for.
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

    // An absence: nothing may stop the entity inside a test window, so
    // `stopped === 0` is already true at t=0 and there is nothing to poll for.
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

  /**
   * The three keys #849 wired, driven the same way.
   *
   * `buffer-size` needs a shard that never gets a home, and a proxy-only
   * cluster is the honest way to produce one: `ShardCoordinator` filters
   * proxies out of its allocation candidates, so a region that routes but
   * hosts nothing asks for a home the coordinator has nobody to give.  That
   * is the very state the bound exists for, reproduced without a fault.
   */
  describe('the resilience keys (#849)', () => {
    test('buffer-size = 0 dead-letters instead of buffering', async () => {
      const node = await startNode(
        'hocon-buffer-zero',
        45_406,
        { 'actor-ts': { sharding: { 'buffer-size': 0 } } },
        (builder) => builder.withProxy(true),
      );
      const settle = await captureDeadLetters(node);

      node.region.tell({ id: 'user-1', kind: 'work' });
      await settle();

      expect(droppedCommands()).toEqual([{ id: 'user-1', kind: 'work' }]);
    });

    test('an explicit withBufferSize beats the config file', async () => {
      const node = await startNode(
        'hocon-buffer-explicit',
        45_407,
        { 'actor-ts': { sharding: { 'buffer-size': 0 } } },
        (builder) => { builder.withProxy(true).withBufferSize(8); },
      );
      const settle = await captureDeadLetters(node);

      node.region.tell({ id: 'user-1', kind: 'work' });
      await settle();

      // The file says "never buffer"; the option says 8, and the option wins —
      // so the message is still held, waiting for a home that will not come.
      expect(droppedCommands()).toEqual([]);
    });

    test('shard-region-query-timeout caps a query the coordinator cannot answer', async () => {
      const node = await startNode(
        'hocon-query-timeout',
        45_408,
        { 'actor-ts': { sharding: { 'shard-region-query-timeout': '60ms' } } },
        (builder) => builder.withProxy(true),
      );

      // Same shape as the passivation cases above: the built-in 5 s would
      // outlast the window, so returning inside it is the configured value
      // winning rather than a coincidence of timing.
      const startedAt = Date.now();
      await expect(node.cluster.sharding.shardRefFor('entity', 0)).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    });

    test('an explicit timeoutMs argument still beats the config file', async () => {
      const node = await startNode(
        'hocon-query-explicit',
        45_409,
        { 'actor-ts': { sharding: { 'shard-region-query-timeout': '30s' } } },
        (builder) => builder.withProxy(true),
      );

      const startedAt = Date.now();
      await expect(node.cluster.sharding.shardRefFor('entity', 0, 60)).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    });
  });
});
