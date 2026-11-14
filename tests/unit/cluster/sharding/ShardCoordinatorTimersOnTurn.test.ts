/**
 * `ShardCoordinator`'s timers and its `MemberRemoved` handling act on its own
 * turn (#1750).
 *
 * Outside the lease's acquire retry and the leader change (#952), every timer
 * the coordinator arms ran its handler in the scheduler's callback — the
 * rebalance tick, the hand-off timeout, the statistics deadline and the
 * shard-map publish — and the `MemberRemoved` listener ran in the cluster's
 * `emit`.  Each decided on the coordinator's maps while a frame that changes
 * them could still be waiting in the mailbox: a rebalance judged a region
 * whose heartbeat was queued, a hand-off timed out with its `HandOffComplete`
 * already in.  Each now only tells the coordinator a private message.
 *
 * Every case queues a relevant message, then fires the captured timer (or
 * emits the event) exactly as the scheduler (or the cluster) would — and
 * records the order the coordinator's handlers run in.  The queued message has
 * to come first.
 *
 * The harness is `HandOffTimeout.test.ts`'s: a real single-node cluster with
 * one sharded type, the live coordinator reached through its cell.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { MemberRemoved } from '../../../../src/cluster/ClusterEvents.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { SHARD_MAP_PUBLISH_DELAY_MS } from '../../../../src/cluster/Constants.js';
import { Member } from '../../../../src/cluster/Member.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import {
  AuthenticatedShardingMessage,
  type GetClusterShardingStats,
  type HandOffComplete,
  type RegionHeartbeat,
  type ShardingMessage,
  type ShardRegionStats,
} from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { SystemGroups, shardRegionName, systemActorPath } from '../../../../src/internal/SystemPaths.js';
import { NoopLogger } from '../../../../src/Logger.js';
import { CapturingScheduler } from '../../../util/CapturingScheduler.js';
import { coordinatorSegments } from '../../../util/SystemPaths.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type WorkCommand = { readonly id: string; readonly kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';
const NUM_SHARDS = 4;
const ENTITY_ID = 'user-1';
const SHARD = hashShardId(ENTITY_ID, NUM_SHARDS);

/** Delays nothing else in the system uses, so only the coordinator's own timers are captured. */
const REBALANCE_INTERVAL_MS = 6_661;
const HAND_OFF_TIMEOUT_MS = 6_662;
const STATS_TIMEOUT_MS = 6_663;

let delivered = 0;

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { delivered++; }
}

type CoordinatorInternals = {
  readonly regions: Map<string, {
    readonly node: NodeAddress;
    readonly path: string;
    readonly proxy: boolean;
    readonly shards: Set<number>;
    lastSeenAtMs: number;
    lastHeartbeatAtMs: number | null;
    readonly seededFromSnapshot: boolean;
  }>;
  readonly rebalanceInProgress: Map<number, unknown>;
  readonly statsQueries: Map<number, { readonly awaiting: Set<string> }>;
  readonly shardMapPublishTimer: unknown;
  readonly registrationBarrier: unknown;
  beginHandOff(shardId: number): void;
  scheduleShardMapPublish(): void;
};

type Harness = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly scheduler: CapturingScheduler;
  readonly regionPath: string;
  readonly coordinator: CoordinatorInternals;
  /** Tell the coordinator `message`, attributed to `peer` (this node by default). */
  readonly tell: (message: ShardingMessage, peer?: NodeAddress) => void;
};

let running: Harness | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* best-effort */ });
    await running.system.terminate().catch(() => { /* best-effort */ });
    running = null;
  }
  delivered = 0;
});

async function startCoordinator(systemName: string, port: number): Promise<Harness> {
  const scheduler = new CapturingScheduler();
  scheduler.capture(REBALANCE_INTERVAL_MS);
  scheduler.capture(HAND_OFF_TIMEOUT_MS);
  scheduler.capture(STATS_TIMEOUT_MS);
  const system = ActorSystem.create(
    systemName,
    ActorSystemOptions.create().withLogger(new NoopLogger()).withScheduler(scheduler),
  );
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
    .withRebalanceIntervalMs(REBALANCE_INTERVAL_MS)
    .withHandOffTimeoutMs(HAND_OFF_TIMEOUT_MS)
    .withPassivationIdleMs(0);
  const region = cluster.sharding.start<Command>(shardingOptions);
  region.tell({ id: ENTITY_ID, kind: 'work' });
  await awaitCondition(() => delivered === 1, { timeoutMs: 4_000, label: 'the entity came up' });

  const resolved = system._resolvePath(coordinatorSegments(systemName, TYPE_NAME));
  if (resolved.isNone()) throw new Error('coordinator actor not found');
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  const coordinator = cell?.actor as CoordinatorInternals;
  await awaitCondition(() => coordinator.registrationBarrier === null, {
    timeoutMs: 4_000,
    label: 'the coordinator lifted its registration barrier',
  });

  const harness: Harness = {
    system,
    cluster,
    scheduler,
    regionPath: systemActorPath(systemName, SystemGroups.clusterSharding, shardRegionName(TYPE_NAME)),
    coordinator,
    tell: (message, peer = cluster.selfAddress) => {
      resolved.value.tell(new AuthenticatedShardingMessage(peer, message) as never);
    },
  };
  running = harness;
  return harness;
}

/** Record, in order, every call to the named coordinator methods, still running each one. */
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

function heartbeatOf(harness: Harness): RegionHeartbeat {
  return { kind: 'sharding.RegionHeartbeat', region: harness.regionPath, node: harness.cluster.selfAddress.toJSON() };
}

describe('the coordinator acts on its turn (#1750)', () => {
  test('the rebalance tick runs behind a heartbeat already queued', async () => {
    const harness = await startCoordinator('1750-rebalance', 44_620);
    const calls = recordCalls(harness.coordinator, ['onRegionHeartbeat', 'rebalanceTick']);

    harness.tell(heartbeatOf(harness));
    harness.scheduler.fire(REBALANCE_INTERVAL_MS);
    await awaitCondition(() => calls.length >= 2, { timeoutMs: 4_000, label: 'both handlers ran' });

    expect(calls).toEqual(['onRegionHeartbeat', 'rebalanceTick']);
  }, 20_000);

  test('the hand-off timeout runs behind a HandOffComplete already queued, and then does nothing', async () => {
    const harness = await startCoordinator('1750-hand-off', 44_622);
    harness.coordinator.beginHandOff(SHARD);
    expect(harness.coordinator.rebalanceInProgress.has(SHARD)).toBe(true);
    const calls = recordCalls(harness.coordinator, ['onHandOffComplete', 'onHandOffTimeout']);

    const complete: HandOffComplete = {
      kind: 'sharding.HandOffComplete',
      shardId: SHARD,
      region: harness.regionPath,
      node: harness.cluster.selfAddress.toJSON(),
    };
    harness.tell(complete);
    harness.scheduler.fire(HAND_OFF_TIMEOUT_MS);
    await awaitCondition(() => calls.includes('onHandOffComplete'), {
      timeoutMs: 4_000,
      label: 'the queued HandOffComplete was handled',
    });
    // One more turn for a timeout queued behind it to have run, if it would.
    harness.tell(heartbeatOf(harness));
    await awaitCondition(() => harness.coordinator.rebalanceInProgress.size === 0, {
      timeoutMs: 4_000,
      label: 'the hand-off ended',
    });

    // The hand-off ended the honest way, so its timeout found nothing to force.
    // (The local region's own `HandOffComplete` may land as a second call.)
    expect(calls[0]).toBe('onHandOffComplete');
    expect(calls).not.toContain('onHandOffTimeout');
  }, 20_000);

  test('the statistics deadline runs behind a region\'s answer already queued', async () => {
    const harness = await startCoordinator('1750-stats', 44_624);
    // A second region that never answers, so the query is still open when the
    // local region's real answer has come back.
    const silent = new NodeAddress('1750-stats-silent', 'h', 44_625);
    const silentPath = '/system/cluster-sharding/region-entity';
    harness.coordinator.regions.set(`${silent}|${silentPath}`, {
      node: silent,
      path: silentPath,
      proxy: false,
      shards: new Set(),
      lastSeenAtMs: Date.now(),
      lastHeartbeatAtMs: null,
      seededFromSnapshot: false,
    });
    const query: GetClusterShardingStats = {
      kind: 'sharding.GetClusterShardingStats',
      correlationId: 1,
      requester: '/user/nobody',
      requesterNode: harness.cluster.selfAddress.toJSON(),
      timeoutMs: STATS_TIMEOUT_MS,
    };
    harness.tell(query);
    await awaitCondition(
      () => Array.from(harness.coordinator.statsQueries.values()).some((q) => q.awaiting.size === 1),
      { timeoutMs: 4_000, label: 'the local region answered and the silent one is still awaited' },
    );
    const [queryId] = Array.from(harness.coordinator.statsQueries.keys());
    const calls = recordCalls(harness.coordinator, ['onShardRegionStats', 'answerStatsQuery']);

    const answer: ShardRegionStats = {
      kind: 'sharding.ShardRegionStats',
      queryId: queryId!,
      region: silentPath,
      node: silent.toJSON(),
      shards: [],
    };
    harness.tell(answer, silent);
    harness.scheduler.fire(STATS_TIMEOUT_MS);
    await awaitCondition(() => calls.length >= 2, { timeoutMs: 4_000, label: 'the query was answered' });

    // The last answer completed the query; the deadline found nothing to cut short.
    expect(calls).toEqual(['onShardRegionStats', 'answerStatsQuery']);
  }, 20_000);

  test('the shard-map publish runs behind a frame already queued', async () => {
    const harness = await startCoordinator('1750-publish', 44_626);
    await awaitCondition(() => harness.coordinator.shardMapPublishTimer === null, {
      timeoutMs: 4_000,
      label: 'the start-up publish went out',
    });
    harness.scheduler.capture(SHARD_MAP_PUBLISH_DELAY_MS);
    harness.coordinator.scheduleShardMapPublish();
    const calls = recordCalls(harness.coordinator, ['onRegionHeartbeat', 'publishShardMap']);

    harness.tell(heartbeatOf(harness));
    harness.scheduler.fire(SHARD_MAP_PUBLISH_DELAY_MS);
    await awaitCondition(() => calls.length >= 2, { timeoutMs: 4_000, label: 'both handlers ran' });

    expect(calls).toEqual(['onRegionHeartbeat', 'publishShardMap']);
  }, 20_000);

  test('a MemberRemoved is applied behind a frame already queued', async () => {
    const harness = await startCoordinator('1750-member-removed', 44_628);
    const calls = recordCalls(harness.coordinator, ['onRegionHeartbeat', 'onMemberRemoved']);
    const gone = new NodeAddress('1750-gone', 'h', 44_629);

    harness.tell(heartbeatOf(harness));
    harness.cluster._publishClusterEvent(new MemberRemoved(new Member(gone, 'removed', 1)));
    await awaitCondition(() => calls.length >= 2, { timeoutMs: 4_000, label: 'both handlers ran' });

    expect(calls).toEqual(['onRegionHeartbeat', 'onMemberRemoved']);
  }, 20_000);
});
