/**
 * `ShardRegion` handles cluster events and its own timers on its own turn
 * (#1750).
 *
 * The region took remote frames through its mailbox but ran the
 * `cluster.subscribe` callback, the register retry and the region heartbeat
 * directly — on whatever stack emitted the event or fired the timer, ahead of
 * everything already queued.  So a `MemberRemoved` could overtake a queued
 * `ShardHome` naming the removed node: the invalidation found nothing to
 * clear, the stale home was applied afterwards, and every message for that
 * shard went to a node that no longer existed, for good.
 *
 * Each of the three now only tells the region a private message, and
 * `onShardHome` also refuses a home on a node that is no current member — the
 * one case mailbox order cannot cover, a `ShardHome` that arrives after the
 * event.
 *
 * ## The harness
 *
 * `ShardRegionPendingAsks.test.ts`'s shape: a real single-node cluster, and a
 * region spawned by hand whose resolver misses the coordinator, so it trusts
 * placements minted by this test and asks nobody anything.  The region's
 * `cluster.subscribe` listener is captured, and its two timers are captured by
 * delay, so a test calls each exactly the way the cluster or the scheduler
 * would — synchronously, with whatever it queued ahead of it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { MemberRemoved, type ClusterEvent } from '../../../../src/cluster/ClusterEvents.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { Member } from '../../../../src/cluster/Member.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import { ShardRegion, type ShardRegionConfig } from '../../../../src/cluster/sharding/ShardRegion.js';
import type { ShardingOptionsType } from '../../../../src/cluster/sharding/ShardingOptions.js';
import {
  AuthenticatedShardingMessage,
  type GetShardLocation,
  type RegisterAcknowledgment,
  type RegisterRefused,
  type ShardHome,
  type ShardingMessage,
} from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { NoopLogger } from '../../../../src/Logger.js';
import { CapturingScheduler } from '../../../util/CapturingScheduler.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const TYPE_NAME = 'on-turn';
const NUM_SHARDS = 8;
const FENCE_SHARD = 0;
const SHARD = 3;

/** Delays nothing else in the system uses, so only the region's own timers are captured. */
const REGISTER_RETRY_MS = 7_771;
const HEARTBEAT_MS = 8_881;

type WorkCommand = { readonly kind: 'work'; readonly id: string };

type Command = WorkCommand;

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { /* nothing to do */ }
}

type ClusterListener = (event: ClusterEvent) => void;

/** The region's private state this file reads — only where behaviour cannot show a fact. */
type RegionInternals = {
  readonly shardHomeNodes: ReadonlyMap<number, NodeAddress>;
  readonly buffer: ReadonlyMap<number, readonly unknown[]>;
};

type Harness = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly scheduler: CapturingScheduler;
  readonly region: ActorRef<unknown>;
  readonly instance: () => ShardRegion<Command>;
  /** The listener the region handed `cluster.subscribe`. */
  readonly listener: ClusterListener;
  /** A node staged as an `up` member, with nothing behind it. */
  readonly peer: NodeAddress;
  /** Every node an envelope was handed to the transport for. */
  readonly envelopesTo: NodeAddress[];
  readonly fence: () => Promise<void>;
  readonly tellAsCoordinator: (message: ShardingMessage) => void;
};

let running: { cluster: Cluster; system: ActorSystem } | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* best-effort */ });
    await running.system.terminate().catch(() => { /* best-effort */ });
    running = null;
  }
});

const internalsOf = (region: ShardRegion<Command>): RegionInternals => region as unknown as RegionInternals;

const locationQuery = (shardId: number): GetShardLocation => ({ kind: 'sharding.GetShardLocation', shardId });

function entityOn(shardId: number): string {
  for (let index = 0; index < 10_000; index++) {
    const entityId = `entity-${index}`;
    if (hashShardId(entityId, NUM_SHARDS) === shardId) return entityId;
  }
  throw new Error(`no entity id among the first 10 000 hashes to shard ${shardId}`);
}

async function startRegion(systemName: string, port: number): Promise<Harness> {
  const scheduler = new CapturingScheduler();
  const system = ActorSystem.create(
    systemName,
    ActorSystemOptions.create().withLogger(new NoopLogger()).withScheduler(scheduler),
  );
  const transport = new InMemoryTransport(new NodeAddress(systemName, 'h', port));
  const envelopesTo: NodeAddress[] = [];
  const send = transport.send.bind(transport);
  transport.send = (to: NodeAddress, message: WireMessage): void => {
    if (message.kind === 'envelope') envelopesTo.push(to);
    try { send(to, message); } catch { /* nothing listens on a staged peer */ }
  };
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(transport)
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  running = { cluster, system };
  await awaitCondition(() => !cluster.leader().isNone(), {
    timeoutMs: 4_000,
    label: 'the single-node cluster elected itself leader',
  });

  // A member the cluster knows and nothing runs on — the node a shard is
  // placed on and then removed.
  const peer = new NodeAddress(systemName, 'peer', port);
  (cluster as unknown as { readonly members: Map<string, Member> }).members
    .set(peer.toString(), new Member(peer, 'up', 1));

  const shardingOptions: ShardingOptionsType<Command> = {
    typeName: TYPE_NAME,
    entityActor: Entity,
    extractEntityId: (message) => message.id,
    numShards: NUM_SHARDS,
    registerRetryIntervalMs: REGISTER_RETRY_MS,
    staleRegionDetection: true,
    regionHeartbeatIntervalMs: HEARTBEAT_MS,
    passivationIdleMs: 0,
  };
  const config: ShardRegionConfig<Command> = ShardRegion.settingsToConfig<Command>(shardingOptions, cluster, () => null);

  let listener: ClusterListener | null = null;
  const subscribe = cluster.subscribe.bind(cluster);
  cluster.subscribe = (candidate: ClusterListener): (() => void) => {
    listener = candidate;
    return subscribe(candidate);
  };
  scheduler.capture(REGISTER_RETRY_MS);
  scheduler.capture(HEARTBEAT_MS);
  let instance: ShardRegion<Command> | null = null;
  const region = system.spawn<unknown>(() => {
    instance = new ShardRegion<Command>(config);
    return instance as unknown as Actor<unknown>;
  }, 'region');

  const tellAsCoordinator = (message: ShardingMessage): void => {
    region.tell(new AuthenticatedShardingMessage(cluster.selfAddress, message));
  };
  // An id outside the range is refused on the region's turn whatever state it
  // is in — a refused region answers it too — so the refusal is the fence.
  const fence = async (): Promise<void> => {
    try {
      await region.ask(locationQuery(-1), 2_000);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  };

  const home: ShardHome = {
    kind: 'sharding.ShardHome',
    shardId: FENCE_SHARD,
    region: region.path.toString(),
    node: cluster.selfAddress.toJSON(),
  };
  tellAsCoordinator(home);
  await fence();
  cluster.subscribe = subscribe;
  if (listener === null) throw new Error('the region subscribed to nothing');

  return {
    system,
    cluster,
    scheduler,
    region,
    instance: () => {
      if (instance === null) throw new Error('the region has not been constructed');
      return instance;
    },
    listener,
    peer,
    envelopesTo,
    fence,
    tellAsCoordinator,
  };
}

function placeOn(harness: Harness, node: NodeAddress): void {
  const home: ShardHome = {
    kind: 'sharding.ShardHome',
    shardId: SHARD,
    region: harness.region.path.toString(),
    node: node.toJSON(),
  };
  harness.tellAsCoordinator(home);
}

function removeMember(harness: Harness, node: NodeAddress): void {
  (harness.cluster as unknown as { readonly members: Map<string, Member> }).members.delete(node.toString());
}

/** Route one message for shard {@link SHARD} and report where it went. */
async function routeOnce(harness: Harness): Promise<{ sentToPeer: boolean; buffered: number }> {
  const before = harness.envelopesTo.length;
  harness.region.tell({ kind: 'work', id: entityOn(SHARD) } satisfies WorkCommand);
  await harness.fence();
  return {
    sentToPeer: harness.envelopesTo.slice(before).some((to) => to.equals(harness.peer)),
    buffered: internalsOf(harness.instance()).buffer.get(SHARD)?.length ?? 0,
  };
}

/**
 * Record, in order, every call the region makes to the named private methods,
 * still running each one.  The order is the finding: a timer that runs off
 * the region's turn is called ahead of a message queued before it fired.
 */
function recordCalls(target: object, methods: readonly string[]): string[] {
  const calls: string[] = [];
  const record = target as Record<string, (...parameters: unknown[]) => unknown>;
  for (const method of methods) {
    const original = record[method]!;
    record[method] = function (this: unknown, ...parameters: unknown[]): unknown {
      calls.push(method);
      return original.apply(this, parameters);
    };
  }
  return calls;
}

describe('a MemberRemoved cannot overtake a queued ShardHome (#1750)', () => {
  test('the reproduction: a ShardHome queued ahead of the removal leaves no home, and traffic buffers', async () => {
    const harness = await startRegion('1750-reproduction', 44_520);

    // One synchronous step, as in the issue: the home is queued, the cluster
    // records the removal and emits the event.
    placeOn(harness, harness.peer);
    removeMember(harness, harness.peer);
    harness.listener(new MemberRemoved(new Member(harness.peer, 'removed', 1)));
    await harness.fence();

    expect(internalsOf(harness.instance()).shardHomeNodes.has(SHARD)).toBe(false);
    expect(await routeOnce(harness)).toEqual({ sentToPeer: false, buffered: 1 });
  }, 20_000);

  test('mailbox order alone: the event is applied behind the home it was emitted after', async () => {
    // The member is left in the view, so the membership check in `onShardHome`
    // cannot be what clears the home — only the event's place in the mailbox.
    const harness = await startRegion('1750-order', 44_522);

    placeOn(harness, harness.peer);
    harness.listener(new MemberRemoved(new Member(harness.peer, 'removed', 1)));
    await harness.fence();

    expect(internalsOf(harness.instance()).shardHomeNodes.has(SHARD)).toBe(false);
  }, 20_000);

  test('a ShardHome arriving after the removal names no member and is refused', async () => {
    const harness = await startRegion('1750-late-home', 44_524);
    removeMember(harness, harness.peer);
    harness.listener(new MemberRemoved(new Member(harness.peer, 'removed', 1)));
    await harness.fence();

    placeOn(harness, harness.peer);
    await harness.fence();

    expect(internalsOf(harness.instance()).shardHomeNodes.has(SHARD)).toBe(false);
    expect(await routeOnce(harness)).toEqual({ sentToPeer: false, buffered: 1 });
  }, 20_000);

  test('the control: a ShardHome on a current member is taken', async () => {
    const harness = await startRegion('1750-control', 44_526);
    placeOn(harness, harness.peer);
    await harness.fence();

    expect(internalsOf(harness.instance()).shardHomeNodes.get(SHARD)?.equals(harness.peer)).toBe(true);
    expect((await routeOnce(harness)).sentToPeer).toBe(true);
  }, 20_000);
});

describe('the region\'s timers act on its turn (#1750)', () => {
  test('the register retry runs behind an acknowledgment already queued, and then does nothing', async () => {
    const harness = await startRegion('1750-register-retry', 44_528);
    await awaitCondition(() => harness.scheduler.capturedAt(REGISTER_RETRY_MS) > 0, {
      timeoutMs: 4_000,
      label: 'the region armed its register retry',
    });
    const calls = recordCalls(harness.instance(), ['onRegisterAcknowledgment', 'ensureRegistered']);

    const acknowledgment: RegisterAcknowledgment = {
      kind: 'sharding.RegisterAcknowledgment',
      coordinator: 'coordinator',
    };
    harness.tellAsCoordinator(acknowledgment);
    harness.scheduler.fire(REGISTER_RETRY_MS);
    await harness.fence();

    // The acknowledgment answered the registration the retry was for, so the
    // retry has nothing left to do — it used to re-target the coordinator and
    // send `Register` again before the acknowledgment was even read.
    expect(calls).toEqual(['onRegisterAcknowledgment']);
  }, 20_000);

  test('the heartbeat runs behind a refusal already queued', async () => {
    const harness = await startRegion('1750-heartbeat', 44_530);
    const calls = recordCalls(harness.instance(), ['onRegisterRefused', 'sendRegionHeartbeat']);

    const refusal: RegisterRefused = {
      kind: 'sharding.RegisterRefused',
      coordinator: 'coordinator',
      numShards: NUM_SHARDS + 1,
      regionNumShards: NUM_SHARDS,
    };
    harness.tellAsCoordinator(refusal);
    harness.scheduler.fire(HEARTBEAT_MS);
    await harness.fence();

    expect(calls).toEqual(['onRegisterRefused', 'sendRegionHeartbeat']);
  }, 20_000);
});
