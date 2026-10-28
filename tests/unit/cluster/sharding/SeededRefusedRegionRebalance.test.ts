/**
 * The shards a coordinator-state snapshot seeded a region with leave it once
 * the region's own registration is refused over its shard count (#1467, #633).
 *
 * Refusing a registration only keeps a region *out*: an entry the snapshot load
 * restored before the region's `Register` arrived stays in the registry, with
 * the shards the snapshot homed on it.  The refusal takes it out of the
 * placement candidates, so it is never handed another shard — but for the
 * shards it already has, only rebalancing can move them, and while they stay,
 * every region asking for one is told the refused region has it.  That region
 * hashes entity ids under another count, so that answer is the split routing
 * the refusal exists to prevent.
 *
 * Rebalancing showed the strategy only the candidates' shards for a while, and
 * a refused region is no candidate, so nothing ever proposed moving them.  This
 * file drives the corner end to end — the snapshot load, the refused
 * `Register` as a frame authenticated as the peer, and the hand-off timer —
 * where `ShardPlacementReachability.test.ts` writes the same state directly.
 *
 * Single node on purpose, the shape `ShardCountRefusal.test.ts` uses: this node
 * is its own leader, and the peer is a member staged `up` in its view whose
 * address no transport serves.  The `HandOff` sent there is dropped, which is
 * also what a refused region does with one: it gave its shards up when it was
 * refused, so it owns nothing to hand off.  Either way the hand-off ends at
 * `handOffTimeoutMs`, on the coordinator's own timer.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import type { FailureDetectorOptionsType } from '../../../../src/cluster/FailureDetectorOptions.js';
import { Member } from '../../../../src/cluster/Member.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import type {
  CoordinatorStateData,
  CoordinatorStateStore,
} from '../../../../src/cluster/sharding/CoordinatorState.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import {
  AuthenticatedShardingMessage,
  type ShardingMessage,
} from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { Cancellable } from '../../../../src/Scheduler.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { coordinatorSegments } from '../../../util/SystemPaths.js';

type WorkCommand = { id: string; kind: 'work' };

const TYPE_NAME = 'entity';
const NUM_SHARDS = 8;
const WARM_UP_ID = 'warm-up';
const PEER_REGION_PATH = '/system/cluster-sharding/region-peer';
/** Short, so the forced end of a hand-off is something a case can wait for. */
const HAND_OFF_TIMEOUT_MS = 300;

/** All three thresholds, so the settle window is this down-after and not a mix with the file's. */
const SHORT_FAILURE_DETECTOR: FailureDetectorOptionsType = {
  heartbeatIntervalMs: 100,
  unreachableAfterMs: 300,
  downAfterMs: 700,
};

class Entity extends Actor<WorkCommand> {
  override onReceive(): void {}
}

/**
 * A `CoordinatorStateStore` whose `load` is held until {@link open} — so the
 * local region's registration and warm-up allocation land first, and the
 * snapshot is adopted into a registry that already has them.
 */
class GatedStateStore implements CoordinatorStateStore {
  loadCalls = 0;
  private openGate: (() => void) | null = null;
  private readonly gate = new Promise<void>((resolve) => { this.openGate = resolve; });

  constructor(private readonly snapshot: CoordinatorStateData) {}

  async load(): Promise<CoordinatorStateData | null> {
    this.loadCalls++;
    await this.gate;
    return this.snapshot;
  }

  async save(): Promise<void> { /* nothing to keep */ }

  open(): void { this.openGate?.(); }
}

type InFlightHandOff = { readonly from: string; readonly timer: Cancellable };

/** The coordinator's own state, reached through its cell — no public surface exposes it. */
interface CoordinatorInternals {
  readonly regions: Map<string, { readonly shards: Set<number> }>;
  readonly shardHome: Map<number, string>;
  readonly refusedRegions: Set<string>;
  readonly rebalanceInProgress: Map<number, InFlightHandOff>;
  readonly membershipSettleWindowMs: number;
  eligibleSetRecord: { readonly keys: string; readonly changedAtMs: number } | null;
  observeEligibleSet(): unknown;
  rebalanceTick(): void;
}

/** The cluster's membership map, written directly to stage a member no event announces. */
type ClusterInternals = { readonly members: Map<string, Member> };

let running: { readonly system: ActorSystem; readonly cluster: Cluster } | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* best-effort */ });
    await running.system.terminate().catch(() => { /* best-effort */ });
    running = null;
  }
});

function coordinatorRef(system: ActorSystem): ActorRef<ShardingMessage | AuthenticatedShardingMessage> {
  const resolved = system._resolvePath(coordinatorSegments(system.name, TYPE_NAME));
  if (resolved.isNone()) throw new Error('no coordinator');
  return resolved.value as ActorRef<ShardingMessage | AuthenticatedShardingMessage>;
}

function reachCoordinator(system: ActorSystem): CoordinatorInternals | null {
  const resolved = system._resolvePath(coordinatorSegments(system.name, TYPE_NAME));
  if (resolved.isNone()) return null;
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  return (cell?.actor as CoordinatorInternals | undefined) ?? null;
}

describe('a region refused over its shard count gives up the shards a snapshot seeded it with (#1467)', () => {
  test('rebalancing hands them off, and once the hand-offs time out they are homed on a candidate', async () => {
    const systemName = 'seeded-refused-rebalance';
    const port = 47_811;
    const self = new NodeAddress(systemName, 'h', port);
    // On a host that sorts after this node's `h`, so staging it never takes the
    // leadership away from the coordinator under test.
    const peer = new NodeAddress(systemName, 'peer', 2_551);
    const peerKey = `${peer}|${PEER_REGION_PATH}`;
    // Two shards the warm-up does not land on, so the snapshot's homes for them
    // are the only ones there are.
    const warmUpShard = hashShardId(WARM_UP_ID, NUM_SHARDS);
    const seeded = Array.from({ length: NUM_SHARDS }, (_, shardId) => shardId)
      .filter((shardId) => shardId !== warmUpShard)
      .slice(0, 2);
    const store = new GatedStateStore({
      leader: self.toString(),
      takenAt: 0,
      numShards: NUM_SHARDS,
      regions: [{ key: peerKey, node: peer.toJSON(), path: PEER_REGION_PATH, proxy: false, shards: seeded }],
      shardHome: seeded.map((shardId) => [shardId, peerKey] as const),
    });

    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create(systemName, systemOptions);
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(port)
      .withSeeds([])
      .withTransport(new InMemoryTransport(self))
      .withGossipIntervalMs(30)
      .withFailureDetector(SHORT_FAILURE_DETECTOR);
    const cluster = await Cluster.join(system, clusterOptions);
    running = { system, cluster };

    // The periodic tick pushed out of reach, so the one tick below is the only
    // one; both rebalance limits off, so it hands off whatever is proposed.
    const shardingOptions = StartShardingOptions.create<WorkCommand>()
      .withTypeName(TYPE_NAME)
      .withEntityActor(Entity)
      .withExtractEntityId((message) => message.id)
      .withNumShards(NUM_SHARDS)
      .withCoordinatorStateStore(store)
      .withRebalanceIntervalMs(600_000)
      .withHandOffTimeoutMs(HAND_OFF_TIMEOUT_MS)
      .withPassivationIdleMs(0)
      .withRebalanceAbsoluteLimit(0)
      .withRebalanceRelativeLimit(0);
    const region = cluster.sharding.start<WorkCommand>(shardingOptions);

    region.tell({ id: WARM_UP_ID, kind: 'work' });
    await awaitCondition(() => {
      const coordinator = reachCoordinator(system);
      return coordinator !== null && store.loadCalls > 0 && coordinator.shardHome.has(warmUpShard);
    }, {
      timeoutMs: 4_000,
      label: 'the local region registered and its warm-up shard has a home, with the snapshot load held',
    });
    const coordinator = reachCoordinator(system)!;
    const localKey = coordinator.shardHome.get(warmUpShard)!;

    // The load keeps only regions of `up` members, so the peer is one first.
    (cluster as unknown as ClusterInternals).members.set(peer.toString(), new Member(peer, 'up', 1));
    store.open();
    await awaitCondition(() => coordinator.regions.has(peerKey), {
      timeoutMs: 4_000,
      label: 'the snapshot seeded the peer region',
    });

    // The peer's own registration, refused over its count — wrapped as a frame
    // authenticated as the peer, which is what the envelope route stamps on one
    // that arrived over the peer's connection.
    coordinatorRef(system).tell(new AuthenticatedShardingMessage(peer, {
      kind: 'sharding.Register',
      region: PEER_REGION_PATH,
      node: peer.toJSON(),
      proxy: false,
      hostedShards: [],
      numShards: NUM_SHARDS + 1,
    }));
    await awaitCondition(() => coordinator.refusedRegions.has(peerKey), {
      timeoutMs: 4_000,
      label: 'the peer registration was refused',
    });

    // The precondition: refusing kept the seeded entry, so the seeded shards are
    // still homed on it — which is what a `GetShardHome` for one is answered with.
    expect(seeded.map((shardId) => coordinator.shardHome.get(shardId))).toEqual([peerKey, peerKey]);

    // Let the settle window run out on the set as it stands — back-dated
    // through the coordinator's own record rather than waited for.
    coordinator.observeEligibleSet();
    const record = coordinator.eligibleSetRecord!;
    coordinator.eligibleSetRecord = {
      keys: record.keys,
      changedAtMs: record.changedAtMs - coordinator.membershipSettleWindowMs,
    };
    coordinator.rebalanceTick();
    const inFlight = Array.from(coordinator.rebalanceInProgress.entries(), ([shardId, handOff]) => [shardId, handOff.from])
      .sort(([left], [right]) => Number(left) - Number(right));
    expect(inFlight).toEqual(seeded.map((shardId) => [shardId, peerKey]));

    await awaitCondition(() => seeded.every((shardId) => coordinator.shardHome.get(shardId) === localKey), {
      timeoutMs: 4_000,
      label: 'every seeded shard is homed on the one candidate once its hand-off timed out',
    });
    expect(coordinator.regions.get(peerKey)!.shards.size).toBe(0);
    expect(coordinator.rebalanceInProgress.size).toBe(0);
  });
});
