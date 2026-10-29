/**
 * A region refused over its shard count answers a hand-off of a shard it no
 * longer holds (#1467, #633).
 *
 * A coordinator-state snapshot can seed a region with shards before that
 * region's own `Register` arrives — and is refused, because the region hashes
 * with a different `numShards`.  The refused region gives up everything it
 * holds the moment the refusal reaches it, while the coordinator's registry
 * still lists the seeded shards under it, so rebalancing moves them off it with
 * a `HandOff` each.  The region used to drop those: it owns nothing, so the
 * ownership check had nothing to hand off, and every one of those moves ran
 * into `handOffTimeoutMs` — ten seconds at the default — before the
 * coordinator forced it.  The region's own answer is the one signal that the
 * refusal reached it and that nothing is left to stop, so it now gives it.
 *
 * Two real nodes rather than a staged peer, because the answer is the region's
 * to give: the seed is the leader and governs the type with 16 shards; the
 * other node's region is configured with 8.  The snapshot names that region
 * with two shards — one inside its own range and one outside it, since a
 * refused region's seeded ids came from the coordinator's count and need not
 * mean anything under its own.  `handOffTimeoutMs` stays at its default, so a
 * hand-off that completes inside a second completed because it was answered.
 *
 * The time is read off the wire — when the coordinator's `HandOff` left the
 * seed and when the region's `HandOffComplete` left the other node — because
 * the whole exchange is one in-memory round trip, faster than any poll of the
 * coordinator's state could see it in flight.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import type { FailureDetectorOptionsType } from '../../../../src/cluster/FailureDetectorOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import type { CoordinatorStateData, CoordinatorStateStore } from '../../../../src/cluster/sharding/CoordinatorState.js';
import { DEFAULT_HAND_OFF_TIMEOUT_MS } from '../../../../src/cluster/sharding/ShardCoordinatorOptions.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { SystemGroups, shardRegionName, systemActorPath } from '../../../../src/internal/SystemPaths.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { coordinatorSegments } from '../../../util/SystemPaths.js';

type WorkCommand = { readonly id: string; readonly kind: 'work' };

const TYPE_NAME = 'entity';
const COORDINATOR_NUM_SHARDS = 16;
const REFUSED_NUM_SHARDS = 8;
/** Seeded on the refused region: one id inside its own range, one outside it. */
const SEEDED_SHARDS = [3, 11] as const;

/**
 * A hand-off has to finish this much faster than `handOffTimeoutMs` to count
 * as answered rather than forced.  The answer is one round trip; the rest is
 * headroom for a loaded runner.
 */
const ANSWERED_WITHIN_MS = 1_000;

/** Short downing timings, so the eligible set settles — and rebalancing starts — within a second. */
const SHORT_FAILURE_DETECTOR: Partial<FailureDetectorOptionsType> = {
  heartbeatIntervalMs: 100,
  unreachableAfterMs: 300,
  downAfterMs: 700,
};

class Entity extends Actor<WorkCommand> {
  override onReceive(): void {}
}

/** When this node first sent a hand-off frame of each kind, per shard id. */
class HandOffRecordingTransport extends InMemoryTransport {
  readonly handOffSentAt = new Map<number, number>();
  readonly handOffCompleteSentAt = new Map<number, number>();

  override send(to: NodeAddress, message: WireMessage): void {
    if (message.kind === 'envelope') {
      const body = message.body as { kind?: unknown; shardId?: unknown } | null;
      if (typeof body === 'object' && body !== null && typeof body.shardId === 'number') {
        const sentAt = body.kind === 'sharding.HandOff' ? this.handOffSentAt
          : body.kind === 'sharding.HandOffComplete' ? this.handOffCompleteSentAt
            : null;
        if (sentAt !== null && !sentAt.has(body.shardId)) sentAt.set(body.shardId, Date.now());
      }
    }
    super.send(to, message);
  }
}

/** A snapshot store whose `load` waits until the test opens it. */
class GatedSnapshotStore implements CoordinatorStateStore {
  private openGate: (() => void) | null = null;
  private readonly gate = new Promise<void>((resolve) => { this.openGate = resolve; });

  constructor(private readonly snapshot: CoordinatorStateData) {}

  async load(): Promise<CoordinatorStateData | null> {
    await this.gate;
    return this.snapshot;
  }

  async save(): Promise<void> { /* the case is about the seeding, not the persistence */ }

  open(): void { this.openGate?.(); }
}

/** The coordinator state this file reads straight off the actor instance. */
type CoordinatorInternals = {
  readonly regions: Map<string, unknown>;
  readonly shardHome: Map<number, string>;
  readonly refusedRegions: Set<string>;
  readonly rebalanceInProgress: Map<number, unknown>;
};

type Joined = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly transport: HandOffRecordingTransport;
};

const running: Joined[] = [];

afterEach(async () => {
  for (const node of running.splice(0)) {
    await node.cluster.leave().catch(() => { /* best-effort */ });
    await node.system.terminate().catch(() => { /* best-effort */ });
  }
});

async function joinNode(systemName: string, port: number, seeds: string[]): Promise<Joined> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const transport = new HandOffRecordingTransport(new NodeAddress(systemName, 'h', port));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(transport)
    .withGossipIntervalMs(30)
    .withFailureDetector(SHORT_FAILURE_DETECTOR);
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster, transport };
  running.push(node);
  return node;
}

function startRegion(node: Joined, numShards: number, store: CoordinatorStateStore | null): void {
  // Both rebalance limits off, so a tick hands off everything it proposes.
  const shardingOptions = StartShardingOptions.create<WorkCommand>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(numShards)
    .withPassivationIdleMs(0)
    .withRebalanceIntervalMs(100)
    .withRebalanceAbsoluteLimit(0)
    .withRebalanceRelativeLimit(0);
  if (store) shardingOptions.withCoordinatorStateStore(store);
  node.cluster.sharding.start<WorkCommand>(shardingOptions);
}

function coordinatorOn(node: Joined): CoordinatorInternals | undefined {
  const resolved = node.system._resolvePath(coordinatorSegments(node.system.name, TYPE_NAME));
  if (resolved.isNone()) return undefined;
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  return cell?.actor as CoordinatorInternals | undefined;
}

describe('a refused region and the shards a snapshot seeded it with (#1467)', () => {
  test('answers their hand-offs, so they move without waiting out handOffTimeoutMs', async () => {
    const systemName = 'refused-region-hand-off';
    const seedPort = 62_200;
    const otherAddress = new NodeAddress(systemName, 'h', seedPort + 1);
    const otherPath = systemActorPath(systemName, SystemGroups.clusterSharding, shardRegionName(TYPE_NAME));
    const otherKey = `${otherAddress}|${otherPath}`;
    const store = new GatedSnapshotStore({
      leader: `${systemName}@h:${seedPort}`,
      takenAt: 0,
      numShards: COORDINATOR_NUM_SHARDS,
      regions: [{ key: otherKey, node: otherAddress.toJSON(), path: otherPath, proxy: false, shards: [...SEEDED_SHARDS] }],
      shardHome: SEEDED_SHARDS.map((shardId) => [shardId, otherKey] as const),
    });

    const seed = await joinNode(systemName, seedPort, []);
    startRegion(seed, COORDINATOR_NUM_SHARDS, store);
    const other = await joinNode(systemName, seedPort + 1, [`${systemName}@h:${seedPort}`]);
    await awaitCondition(
      () => seed.cluster.upMembers().length === 2 && other.cluster.upMembers().length === 2,
      { timeoutMs: 4_000, label: 'the two-node cluster converged' },
    );

    // The load keeps only the regions of members that are up, so it runs now —
    // and the other node's region starts only once its entry is seeded, or its
    // refusal would keep the snapshot's entry out altogether.
    store.open();
    await awaitCondition(() => coordinatorOn(seed)?.regions.has(otherKey) === true, {
      timeoutMs: 4_000,
      label: 'the snapshot seeded the other node\'s region with its shards',
    });
    startRegion(other, REFUSED_NUM_SHARDS, null);
    await awaitCondition(
      () => other.cluster.sharding.registrationRefusal(TYPE_NAME) !== null
        && coordinatorOn(seed)?.refusedRegions.has(otherKey) === true,
      { timeoutMs: 4_000, label: 'the coordinator refused the other node\'s region, and the region knows' },
    );

    const seedKey = Array.from(coordinatorOn(seed)!.regions.keys()).find((key) => key !== otherKey)!;
    await awaitCondition(
      () => SEEDED_SHARDS.every((shardId) => coordinatorOn(seed)!.shardHome.get(shardId) === seedKey),
      { timeoutMs: 4_000, label: 'every seeded shard was handed off the refused region and homed on the seed' },
    );

    // Each was handed off — not re-homed some other way — and answered: the
    // time between the coordinator's `HandOff` and the region's
    // `HandOffComplete`, against a forced end at the default timeout, ten
    // times the bound.
    expect(DEFAULT_HAND_OFF_TIMEOUT_MS).toBeGreaterThanOrEqual(ANSWERED_WITHIN_MS * 10);
    for (const shardId of SEEDED_SHARDS) {
      const askedAt = seed.transport.handOffSentAt.get(shardId);
      const answeredAt = other.transport.handOffCompleteSentAt.get(shardId);
      expect({ shardId, asked: askedAt !== undefined, answered: answeredAt !== undefined })
        .toEqual({ shardId, asked: true, answered: true });
      expect(answeredAt! - askedAt!).toBeLessThan(ANSWERED_WITHIN_MS);
    }
    expect(coordinatorOn(seed)!.rebalanceInProgress.size).toBe(0);
  }, 15_000);
});
