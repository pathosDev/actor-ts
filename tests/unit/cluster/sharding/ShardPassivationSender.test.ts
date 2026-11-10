/**
 * A message that reaches a shard while its entity is passivating keeps its
 * sender.
 *
 * Between a cooperative `Passivate` and the entity's `Terminated`, the shard
 * holds everything addressed to that entity and replays it into the next
 * incarnation.  It used to hold the message alone and replay it with no sender
 * at all, so an entity answering `this.sender` answered nobody: an `ask` that
 * landed in that window timed out, while one answered through `replyTo` —
 * which travels inside the message — resolved.  The case below is that pair,
 * side by side, so a pass cannot come from a window that never opened.
 *
 * The window is held open by the test rather than by a timer: the entity acts
 * on its stop-message only when the test tells it to, and the test tells it
 * directly rather than through the shard, which would buffer that too.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { Passivate } from '../../../../src/cluster/sharding/Passivate.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import type { GetShardLocation, ShardStats } from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const TYPE_NAME = 'entity';
const NUM_SHARDS = 4;
const ENTITY_ID = 'user-1';

/** Long enough for the first placement on a fresh cluster, and for a fence. */
const ASK_TIMEOUT_MS = 2_000;

type PingCommand = { readonly kind: 'ping'; readonly id: string };

/** Answered through `replyTo`, which travels inside the message — the control. */
type PingReplyToCommand = {
  readonly kind: 'ping-reply-to';
  readonly id: string;
  readonly replyTo: ActorRef<string>;
};

/** Makes the entity ask its shard to passivate it, cooperatively. */
type ByeCommand = { readonly kind: 'bye'; readonly id: string };

/** The stop-message the shard hands back once it grants the passivation. */
type StopCommand = { readonly kind: 'stop'; readonly id: string };

/** Sent straight to an incarnation, past the shard: act on the stop-message now. */
type FinishCommand = { readonly kind: 'finish'; readonly id: string };

type Command = PingCommand | PingReplyToCommand | ByeCommand | StopCommand | FinishCommand;

/** Every incarnation of every entity, in start order. */
const incarnations = new Map<string, ActorRef<Command>[]>();

/** Entities holding their stop-message, waiting for the test to release them. */
const holdingStop = new Set<string>();

class Entity extends Actor<Command> {
  override preStart(): void {
    const refs = incarnations.get(this.entityId) ?? [];
    refs.push(this.self);
    incarnations.set(this.entityId, refs);
  }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'ping' }, () => this.onPing())
      .with({ kind: 'ping-reply-to' }, (m) => this.onPingReplyTo(m))
      .with({ kind: 'bye' }, () => this.onBye())
      .with({ kind: 'stop' }, () => this.onStop())
      .with({ kind: 'finish' }, () => this.onFinish())
      .exhaustive();
  }

  private onPing(): void { this.sender.forEach((sender) => sender.tell('pong')); }

  private onPingReplyTo(message: PingReplyToCommand): void { message.replyTo.tell('pong'); }

  private onBye(): void {
    const stopCommand: StopCommand = { kind: 'stop', id: this.entityId };
    this.context.parent.forEach((parent) =>
      parent.tell(new Passivate(stopCommand, this.self) as never, this.self));
  }

  private onStop(): void { holdingStop.add(this.entityId); }

  private onFinish(): void { this.context.stopSelf(); }
}

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly region: ActorRef<Command>;
};

let running: Node | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* teardown is best-effort */ });
    await running.system.terminate().catch(() => { /* teardown is best-effort */ });
    running = null;
  }
  incarnations.clear();
  holdingStop.clear();
});

async function startNode(systemName: string, port: number): Promise<Node> {
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
    .withNumShards(NUM_SHARDS)
    // An idle sweep would end the passivation window on its own schedule.
    .withPassivationIdleMs(0);
  const region = cluster.sharding.start<Command>(shardingOptions);
  running = { system, cluster, region };
  return running;
}

/**
 * What the entity's shard holds, answered only after everything the region
 * routed before the question: the region names the shard after its earlier
 * turns, and the shard answers after the envelopes those turns told it.
 */
async function entitiesOnShard(node: Node): Promise<string[]> {
  const location: GetShardLocation = {
    kind: 'sharding.GetShardLocation',
    shardId: hashShardId(ENTITY_ID, NUM_SHARDS),
  };
  const shard = await (node.region as ActorRef<unknown>).ask<ActorRef<unknown>>(location, ASK_TIMEOUT_MS);
  const stats = await shard.ask<ShardStats>({ kind: 'sharding.GetShardStats' }, ASK_TIMEOUT_MS);
  return [...stats.entityIds];
}

describe('Shard — the passivation buffer keeps each sender', () => {
  test('an ask answered through this.sender resolves across a cooperative passivation', async () => {
    const node = await startNode('passivation-sender', 47_410);
    expect(await node.region.ask<string>({ id: ENTITY_ID, kind: 'ping' }, ASK_TIMEOUT_MS)).toBe('pong');

    node.region.tell({ id: ENTITY_ID, kind: 'bye' });
    await awaitCondition(() => holdingStop.has(ENTITY_ID), {
      timeoutMs: 4_000,
      label: 'the shard granted the passivation and handed back the stop-message',
    });

    // Both reach the shard while it holds the entity as passivating, so both
    // are buffered — the second carries its reply address inside itself.
    const viaSender = node.region.ask<string>({ id: ENTITY_ID, kind: 'ping' }, ASK_TIMEOUT_MS);
    const viaReplyTo = node.region.ask<string>({ id: ENTITY_ID, kind: 'ping-reply-to' }, ASK_TIMEOUT_MS);
    // The fence: once the shard answers this, both envelopes are in its buffer.
    expect(await entitiesOnShard(node)).toEqual([ENTITY_ID]);

    const [first] = incarnations.get(ENTITY_ID) ?? [];
    if (first === undefined) throw new Error('the entity never started');
    first.tell({ kind: 'finish', id: ENTITY_ID });

    const [senderAnswer, replyToAnswer] = await Promise.allSettled([viaSender, viaReplyTo]);
    expect(replyToAnswer).toEqual({ status: 'fulfilled', value: 'pong' });
    expect(senderAnswer).toEqual({ status: 'fulfilled', value: 'pong' });
    // Both were answered by the second incarnation, after the replay.
    expect(incarnations.get(ENTITY_ID)).toHaveLength(2);
  }, 10_000);
});
