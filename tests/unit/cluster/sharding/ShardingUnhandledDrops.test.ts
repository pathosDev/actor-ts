/**
 * What the sharding actors decline is observable.
 *
 * A declined message goes through `Actor.unhandled`: it becomes a `DeadLetter`
 * naming the actor that declined it, and it ticks
 * `actor_unhandled_total{class}` — the one rate signal that is there by
 * default, since the dead-letter store, and with it `actor_dead_letters_total`,
 * is `off` unless a deployment turns it on.
 *
 * The node is a single-member cluster, so it is its own leader and hosts the
 * coordinator, and the region accepts directives from this node only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import type { ShardStats } from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { NoopLogger } from '../../../../src/Logger.js';
import { MetricsExtensionId } from '../../../../src/metrics/MetricsExtension.js';
import type { MetricsRegistry } from '../../../../src/metrics/Metrics.js';
import { DeadLetter } from '../../../../src/SystemMessages.js';
import { TestKit } from '../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../src/testkit/TestKitOptions.js';
import type { TestProbe } from '../../../../src/testkit/TestProbe.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const TYPE_NAME = 'entity';
const NUM_SHARDS = 4;

/** How long a fence or a dead letter may take before the test names the step. */
const RECEIVE_TIMEOUT_MS = 2_000;

type WorkCommand = { readonly kind: 'work'; readonly id: string };

type Command = WorkCommand;

/** Every entity id that reached `preStart`, in start order. */
let started: string[] = [];

class Entity extends Actor<Command> {
  override preStart(): void { started.push(this.entityId); }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { /* the spawn is the whole observation */ }
}

type Node = {
  readonly kit: TestKit;
  readonly cluster: Cluster;
  readonly registry: MetricsRegistry;
  readonly probe: TestProbe;
  readonly region: ActorRef<Command>;
};

const nodes: Node[] = [];

afterEach(async () => {
  for (const node of nodes.splice(0)) {
    await node.cluster.leave().catch(() => { /* teardown is best-effort */ });
    await node.kit.system.terminate().catch(() => { /* teardown is best-effort */ });
  }
  started = [];
});

const address = (name: string, port: number): NodeAddress => new NodeAddress(name, 'h', port);

async function startNode(name: string, port: number): Promise<Node> {
  const kit = TestKit.create(name, TestKitOptions.create().withLogger(new NoopLogger()));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(address(name, port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  const registry = kit.system.extension(MetricsExtensionId).enable();
  const probe = kit.createTestProbe();
  kit.system.eventStream.subscribe(probe, DeadLetter);
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    // A sweep firing mid-test would stop entities for reasons of its own.
    .withPassivationIdleMs(0);
  const region = cluster.sharding.start<Command>(shardingOptions);
  const node: Node = { kit, cluster, registry, probe, region };
  nodes.push(node);
  return node;
}

function countFor(registry: MetricsRegistry, className: string): number {
  return registry.collect()
    .filter((s) => s.name === 'actor_unhandled_total' && s.labels['class'] === className)
    .reduce((total, sample) => total + sample.value, 0);
}

/** `count` entity ids that all hash into one shard. */
function idsOnOneShard(count: number): string[] {
  const shardId = hashShardId('user-0', NUM_SHARDS);
  const found: string[] = [];
  for (let index = 0; found.length < count && index < 10_000; index++) {
    const candidate = `user-${index}`;
    if (hashShardId(candidate, NUM_SHARDS) === shardId) found.push(candidate);
  }
  if (found.length < count) throw new Error(`only ${found.length} of ${count} ids share a shard`);
  return found;
}

/** The next dead letter addressed to `recipient` whose message has `kind`. */
async function letterFor(node: Node, recipient: ActorRef<unknown>, kind: string): Promise<DeadLetter> {
  return await node.probe.fishForMessage<DeadLetter>(
    (m) => m instanceof DeadLetter
      && m.recipient.path.toString() === recipient.path.toString()
      && (m.message as { kind?: unknown } | null)?.kind === kind,
    RECEIVE_TIMEOUT_MS,
  );
}

describe('Shard — a stats query with nowhere to answer is declined', () => {
  test('the shard keeps its entities, and the query is a dead letter naming it', async () => {
    const node = await startNode('unhandled-shard-stats', 47_520);
    const [first, second] = idsOnOneShard(2) as [string, string];
    node.region.tell({ id: first, kind: 'work' });
    node.region.tell({ id: second, kind: 'work' });
    await awaitCondition(() => started.length === 2, {
      timeoutMs: 4_000,
      label: 'both entities started in their shard',
    });
    const shard = await node.cluster.sharding.shardRefFor(TYPE_NAME, hashShardId(first, NUM_SHARDS));

    // A `tell` can leave `replyTo` out, and nothing guarantees what sits there
    // otherwise — the type is a promise the sender keeps, not one the shard
    // can rely on.  Both used to throw inside the shard.
    shard.tell({ kind: 'sharding.GetShardStats' } as never);
    shard.tell({ kind: 'sharding.GetShardStats', replyTo: 'not-a-ref' } as never);

    // Answered after both, by the same shard: a throw would have restarted it,
    // and a restarted shard starts with no entities at all.
    const stats = await shard.ask<ShardStats>({ kind: 'sharding.GetShardStats' }, RECEIVE_TIMEOUT_MS);
    expect([...stats.entityIds].sort()).toEqual([first, second].sort());
    expect([...started].sort()).toEqual([first, second].sort());

    const missing = await letterFor(node, shard, 'sharding.GetShardStats');
    expect(missing.message).toEqual({ kind: 'sharding.GetShardStats' });
    const notARef = await letterFor(node, shard, 'sharding.GetShardStats');
    expect(notARef.message).toEqual({ kind: 'sharding.GetShardStats', replyTo: 'not-a-ref' });
    expect(countFor(node.registry, 'Shard')).toBe(2);
  });
});
