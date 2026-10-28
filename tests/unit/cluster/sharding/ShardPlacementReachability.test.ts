/**
 * Shard placement against the membership view (#1467).
 *
 * A node that stops answering is marked `unreachable` and stays a member until
 * something decides about it — a split-brain strategy, the failure detector's
 * opt-in auto-down, or an operator.  The coordinator's candidate set used to be
 * the region registry and nothing else, so for that whole stretch the parked
 * node kept being handed newly allocated shards, whose first messages then
 * waited on a home that could not answer: 8 of 24 under the default strategy
 * with one of three nodes parked.
 *
 * Filtering placement alone is not the fix, and the obvious shapes of it loop.
 * Allocate over the filtered set while rebalancing over the full registry, and
 * `HashAllocationStrategy` proposes the same shards every tick and the
 * re-allocation puts them straight back.  Allocate over the full set first and
 * rebalance over the filtered one, and the same thing happens the other way
 * round.  So the coordinator tracks the *eligible* set — registered regions
 * whose node is `up` — and when it last changed.  While it is settling, a
 * shard's full-set pick stands when its node is up (a blip moves nothing that
 * did not have to move) and falls back to the eligible pick when it is not, and
 * the strategy is not asked to rebalance at all.  Once the set has held still
 * for the window — derived from the downing timings, read from the cluster —
 * allocation and rebalancing both run over the eligible set, so they agree.
 *
 * The harness is `RebalanceCeiling.test.ts`'s: the live coordinator of a real
 * single-node cluster, reached through its cell, with its registry written
 * directly and its production `tryAllocate` / `rebalanceTick` called by the
 * test.  The periodic tick and the hand-off timeout are pushed far out, so every
 * tick is one a case asked for and an in-flight hand-off stays in flight until
 * the case completes it.  The window is let run out by back-dating the
 * coordinator's own record of when the set last changed, never by waiting.
 *
 * Members are staged in the cluster's own map, at addresses that sort *after*
 * the local node: the leader is the lowest-addressed `up` member, and a staged
 * one that sorted first would make this node a follower.  Nothing reverts
 * them — the failure detector answers `healthy` for an address it has never
 * sampled, and only a heartbeat moves a member out of `unreachable`.  The
 * fabricated regions name addresses no transport serves; `InMemoryTransport`
 * drops what is sent there, and the state under test is written before any send.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions, type ClusterOptionsBuilder } from '../../../../src/cluster/ClusterOptions.js';
import { KeepMajority } from '../../../../src/cluster/downing/KeepMajority.js';
import type { FailureDetectorOptionsType } from '../../../../src/cluster/FailureDetectorOptions.js';
import { Member } from '../../../../src/cluster/Member.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import type { MemberStatus } from '../../../../src/cluster/Protocol.js';
import {
  type AllocationStrategy,
  HashAllocationStrategy,
} from '../../../../src/cluster/sharding/AllocationStrategy.js';
import type {
  GetShardHome,
  HandOffComplete,
} from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { Config } from '../../../../src/config/Config.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { Cancellable } from '../../../../src/Scheduler.js';
import { coordinatorSegments } from '../../../util/SystemPaths.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';

type WorkCommand = { id: string; kind: 'work' };

const TYPE_NAME = 'entity';
const NUM_SHARDS = 24;
const ROLE = 'hosting';
/** Every shard id of the type, in order. */
const ALL_SHARDS = Array.from({ length: NUM_SHARDS }, (_, shardId) => shardId);

/**
 * All three thresholds, always: the join layers an explicit failure-detector
 * block over the file's per field, so naming only `downAfterMs` would leave
 * `unreachableAfterMs` at the file's 2 s and above the down-after under test.
 * Short, so the coordinator's window is small; no case waits it out.
 */
const SHORT_FAILURE_DETECTOR: FailureDetectorOptionsType = {
  heartbeatIntervalMs: 100,
  unreachableAfterMs: 300,
  downAfterMs: 700,
};

class Entity extends Actor<WorkCommand> {
  override onReceive(): void {}
}

/**
 * Allocates like the default strategy and proposes *every* shard id of the
 * type on every tick, whatever it is shown — a custom strategy that does not
 * read its arguments.  Keeping a hand-off off an owner that is not up is the
 * coordinator's job, not something it may assume of a strategy.
 */
class ProposesEveryShardStrategy implements AllocationStrategy {
  private readonly hash = new HashAllocationStrategy();

  allocate(
    shardId: number,
    candidates: ReadonlyArray<NodeAddress>,
    currentShards: ReadonlyMap<string, ReadonlySet<number>>,
  ): NodeAddress {
    return this.hash.allocate(shardId, candidates, currentShards);
  }

  rebalance(
    _currentShards: ReadonlyMap<string, ReadonlySet<number>>,
    _candidates: ReadonlyArray<NodeAddress>,
    rebalanceInProgress: ReadonlySet<number>,
  ): Set<number> {
    return new Set(ALL_SHARDS.filter((shardId) => !rebalanceInProgress.has(shardId)));
  }
}

/** One call a strategy received, as it saw it: the hosts it was handed, and the shard map by host. */
type StrategyCall = {
  readonly method: 'allocate' | 'rebalance';
  /** The shard asked about; `null` for a `rebalance`. */
  readonly shardId: number | null;
  readonly candidates: readonly string[];
  readonly shards: Readonly<Record<string, readonly number[]>>;
};

function recordCall(
  method: StrategyCall['method'],
  shardId: number | null,
  candidates: ReadonlyArray<NodeAddress>,
  currentShards: ReadonlyMap<string, ReadonlySet<number>>,
): StrategyCall {
  // Copied at call time: the sets are the coordinator's, and they move on.
  const shards: Record<string, number[]> = {};
  for (const [address, shardIds] of currentShards) {
    shards[hostOfAddress(address)] = [...shardIds].sort((left, right) => left - right);
  }
  return { method, shardId, candidates: candidates.map((candidate) => candidate.host), shards };
}

/**
 * The default strategy's answers, with every call written down as the strategy
 * saw it.  What the coordinator hands a strategy is the contract a custom one is
 * written against, so it is asserted as such rather than inferred from where
 * the default strategy's answers happen to land.
 */
class RecordsWhatItIsShown extends HashAllocationStrategy {
  readonly calls: StrategyCall[] = [];

  override allocate(
    shardId: number,
    candidates: ReadonlyArray<NodeAddress>,
    currentShards: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
  ): NodeAddress {
    this.calls.push(recordCall('allocate', shardId, candidates, currentShards));
    return super.allocate(shardId, candidates, currentShards);
  }

  override rebalance(
    currentShards: ReadonlyMap<string, ReadonlySet<number>>,
    candidates: ReadonlyArray<NodeAddress>,
    rebalanceInProgress: ReadonlySet<number>,
  ): Set<number> {
    this.calls.push(recordCall('rebalance', null, candidates, currentShards));
    return super.rebalance(currentShards, candidates, rebalanceInProgress);
  }
}

/** A registry entry as the coordinator keeps it — every field, so a fabricated one is indistinguishable. */
type RegionInfo = {
  readonly node: NodeAddress;
  readonly path: string;
  readonly proxy: boolean;
  readonly shards: Set<number>;
  lastSeenAtMs: number;
  lastHeartbeatAtMs: number | null;
  readonly seededFromSnapshot: boolean;
};

/** The coordinator's record of the eligible set: which regions were in it, and since when. */
type EligibleSetRecord = { readonly keys: string; readonly changedAtMs: number };

type InFlightHandOff = { readonly from: string; readonly timer: Cancellable };

/** The coordinator's own state, reached through its cell — no public surface exposes it. */
interface CoordinatorInternals {
  readonly regions: Map<string, RegionInfo>;
  readonly shardHome: Map<number, string>;
  readonly pending: Map<number, unknown[]>;
  readonly rebalanceInProgress: Map<number, InFlightHandOff>;
  /** Region keys refused over their shard count (#633) — still in `regions` when a snapshot seeded them first. */
  readonly refusedRegions: Set<string>;
  readonly membershipSettleWindowMs: number;
  eligibleSetRecord: EligibleSetRecord | null;
  candidates(): NodeAddress[];
  observeEligibleSet(): unknown;
  tryAllocate(shardId: number): void;
  rebalanceTick(): void;
  onGetShardHome(message: GetShardHome): void;
  onHandOffComplete(message: HandOffComplete): void;
  onHandOffTimeout(shardId: number): void;
  onLeaderChanged(): void;
}

/** The cluster's membership map, written directly to stage a member in any status. */
type ClusterInternals = { readonly members: Map<string, Member> };

type Joined = { readonly system: ActorSystem; readonly cluster: Cluster };

type Placement = Joined & {
  readonly systemName: string;
  readonly coordinator: CoordinatorInternals;
};

const joined: Joined[] = [];
let running: Placement | null = null;
let nextPort = 48_700;

afterEach(async () => {
  if (running) {
    for (const handOff of running.coordinator.rebalanceInProgress.values()) handOff.timer.cancel();
    running = null;
  }
  for (const node of joined.splice(0)) {
    await node.cluster.leave().catch(() => { /* best-effort */ });
    await node.system.terminate().catch(() => { /* best-effort */ });
  }
});

/** What a case may set about the joining node; unset means the shipped configuration. */
type JoinFixture = {
  readonly hocon?: string;
  readonly logger?: RecordingLogger;
  readonly configure?: (options: ClusterOptionsBuilder) => void;
};

/** A single-node cluster, configured the way the case says and joined the way an application joins. */
async function joinCluster(systemName: string, fixture: JoinFixture = {}): Promise<Joined & { readonly port: number }> {
  const port = nextPort++;
  const systemOptions = ActorSystemOptions.create()
    .withLogger(fixture.logger ?? new NoopLogger())
    .withLogLevel(fixture.logger ? LogLevel.Debug : LogLevel.Off);
  // `Config.parseString`, not `Config.fromObject` with dotted keys: the latter
  // keeps the dotted string as one literal key and the case would read the
  // shipped value instead of the one it set.
  if (fixture.hocon !== undefined) systemOptions.withConfig(Config.parseString(fixture.hocon));
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  fixture.configure?.(clusterOptions);
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster };
  joined.push(node);
  return { ...node, port };
}

/** What a placement case may set; unset means the default strategy and no role. */
type PlacementFixture = {
  /** A role the type is placed by — and which this node carries, so its own warm-up allocation succeeds. */
  readonly role?: string;
  readonly logger?: RecordingLogger;
  readonly strategy?: AllocationStrategy;
};

/**
 * A single-node cluster with one sharded type on the default strategy, and the
 * live coordinator behind it.  Both rebalance limits are off, so one tick hands
 * off everything the strategy proposes and a count read after it is the
 * strategy's whole answer rather than a ceiling's slice of it.
 */
async function startPlacement(systemName: string, fixture: PlacementFixture = {}): Promise<Placement> {
  const { system, cluster } = await joinCluster(systemName, {
    logger: fixture.logger,
    configure: (options) => {
      options.withFailureDetector(SHORT_FAILURE_DETECTOR);
      // The cases park members at `unreachable`, which is what the detector
      // does with auto-down off; with it on it removes a silent peer at
      // down-after instead.  Set rather than inherited, so no case rests on
      // which of the two the shipped configuration happens to choose.
      options.withFailureDetectorAutoDown(false);
      if (fixture.role !== undefined) options.withRoles([fixture.role]);
    },
  });

  const shardingOptions = StartShardingOptions.create<WorkCommand>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    .withAllocationStrategy(fixture.strategy ?? new HashAllocationStrategy())
    .withRebalanceIntervalMs(600_000)
    .withHandOffTimeoutMs(600_000)
    .withPassivationIdleMs(0)
    .withRebalanceAbsoluteLimit(0)
    .withRebalanceRelativeLimit(0);
  if (fixture.role !== undefined) shardingOptions.withRole(fixture.role);
  const region = cluster.sharding.start<WorkCommand>(shardingOptions);

  const reachCoordinator = (): CoordinatorInternals | null => {
    const resolved = system._resolvePath(coordinatorSegments(systemName, TYPE_NAME));
    if (resolved.isNone()) return null;
    const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
    return (cell?.actor as CoordinatorInternals | undefined) ?? null;
  };

  // The local region registers asynchronously and its warm-up message asks for
  // a home after that, so both have to have landed before the registry is
  // replaced — a `GetShardHome` arriving afterwards would allocate into the
  // fabricated map.
  region.tell({ id: 'warm-up', kind: 'work' });
  await awaitCondition(() => {
    const coordinator = reachCoordinator();
    return coordinator !== null && coordinator.regions.size > 0 && coordinator.shardHome.size > 0;
  }, {
    timeoutMs: 4_000,
    label: 'the coordinator is live, the local region registered and its warm-up shard has a home',
  });

  const coordinator = reachCoordinator()!;
  // The precondition every back-dating below rests on.
  expect(coordinator.membershipSettleWindowMs).toBe(SHORT_FAILURE_DETECTOR.downAfterMs);
  const placement: Placement = { system, cluster, systemName, coordinator };
  running = placement;
  return placement;
}

/** An address on `host` for this harness's system, sorting after the local node's `h`. */
function peerAddress(placement: Placement, host: string): NodeAddress {
  const address = new NodeAddress(placement.systemName, host, 2_551);
  expect(address.compareTo(placement.cluster.selfAddress)).toBeGreaterThan(0);
  return address;
}

/** Put a member record for `host` in `status` into this node's view. */
function stageMember(placement: Placement, host: string, status: MemberStatus, roles: string[] = []): void {
  const address = peerAddress(placement, host);
  const members = (placement.cluster as unknown as ClusterInternals).members;
  const existing = members.get(address.toString());
  members.set(
    address.toString(),
    existing === undefined ? new Member(address, status, 1, roles) : existing.withStatus(status),
  );
}

function regionPath(host: string): string {
  return `/system/cluster-sharding/region-${host}`;
}

/** The registry key the coordinator uses for the fabricated region on `host`. */
function keyOf(placement: Placement, host: string): string {
  return `${peerAddress(placement, host)}|${regionPath(host)}`;
}

/** The host of a `system@host:port` address string — how a strategy's map is keyed. */
function hostOfAddress(address: string): string {
  const match = /@([^:]+):/.exec(address);
  return match ? match[1]! : address;
}

/** Which fabricated host a registry key belongs to, so a failure prints `x` rather than a key. */
function hostOf(key: string | undefined): string {
  if (key === undefined) return '(none)';
  const match = /region-([\w-]+)$/.exec(key);
  return match ? match[1]! : key;
}

/**
 * Replace the registry with one region per host, owning the shard ids given,
 * and nothing else — the local region included, so every candidate is one the
 * case put there.
 */
function fabricate(placement: Placement, owners: ReadonlyArray<readonly [string, ReadonlyArray<number>]>): void {
  const { coordinator } = placement;
  coordinator.regions.clear();
  coordinator.shardHome.clear();
  for (const [host, shardIds] of owners) {
    const key = keyOf(placement, host);
    coordinator.regions.set(key, {
      node: peerAddress(placement, host),
      path: regionPath(host),
      proxy: false,
      shards: new Set(shardIds),
      lastSeenAtMs: 0,
      lastHeartbeatAtMs: null,
      seededFromSnapshot: false,
    });
    for (const shardId of shardIds) coordinator.shardHome.set(shardId, key);
  }
}

/** What `HashAllocationStrategy` makes of `hosts`: shard n on the (n mod size)-th in address order. */
function byHash(placement: Placement, hosts: ReadonlyArray<string>): Array<readonly [string, number[]]> {
  const sorted = [...hosts].sort((left, right) =>
    peerAddress(placement, left).compareTo(peerAddress(placement, right)));
  return sorted.map((host, index) =>
    [host, ALL_SHARDS.filter((shardId) => shardId % sorted.length === index)] as const);
}

/**
 * Record the eligible set as it stands and let the window run out on it — the
 * state of a set that has held still.  Back-dated through the coordinator's own
 * record rather than waited for.
 */
function letTheSetSettle(coordinator: CoordinatorInternals): void {
  coordinator.observeEligibleSet();
  const record = coordinator.eligibleSetRecord;
  expect(record).not.toBeNull();
  coordinator.eligibleSetRecord = {
    keys: record!.keys,
    changedAtMs: record!.changedAtMs - coordinator.membershipSettleWindowMs,
  };
}

/** Owner host of every homed shard, by shard id. */
function ownersByShard(coordinator: CoordinatorInternals): Map<number, string> {
  return new Map(Array.from(coordinator.shardHome.entries(), ([shardId, key]) => [shardId, hostOf(key)]));
}

/** Shards in flight as `[shardId, host it is being handed off from]`, by shard id. */
function inFlight(coordinator: CoordinatorInternals): Array<[number, string]> {
  return Array.from(coordinator.rebalanceInProgress.entries())
    .map(([shardId, handOff]): [number, string] => [shardId, hostOf(handOff.from)])
    .sort(([left], [right]) => left - right);
}

/** Finish every hand-off in flight the way the region's `HandOffComplete` does, through the coordinator's handler. */
function completeEveryHandOff(placement: Placement): void {
  const { coordinator } = placement;
  for (const [shardId, handOff] of Array.from(coordinator.rebalanceInProgress.entries())) {
    const owner = coordinator.regions.get(handOff.from)!;
    coordinator.onHandOffComplete({
      kind: 'sharding.HandOffComplete',
      shardId,
      region: owner.path,
      node: owner.node.toJSON(),
    });
  }
}

describe('placement leaves out a member that is not up (#1467)', () => {
  test('an unreachable member is handed no newly allocated shard', async () => {
    const placement = await startPlacement('placement-unreachable');
    stageMember(placement, 'peer-a', 'up');
    stageMember(placement, 'peer-b', 'up');
    stageMember(placement, 'peer-x', 'unreachable');
    fabricate(placement, [['peer-a', []], ['peer-b', []], ['peer-x', []]]);
    const { coordinator } = placement;

    // Half while the set is settling — the first observation of a changed set —
    // and half once it has held still, so both ways of asking are covered.
    for (const shardId of ALL_SHARDS.slice(0, NUM_SHARDS / 2)) coordinator.tryAllocate(shardId);
    letTheSetSettle(coordinator);
    for (const shardId of ALL_SHARDS.slice(NUM_SHARDS / 2)) coordinator.tryAllocate(shardId);

    const owners = ownersByShard(coordinator);
    expect(ALL_SHARDS.filter((shardId) => owners.get(shardId) === 'peer-x')).toEqual([]);
    // Placed, not merely kept off the parked member.
    expect(ALL_SHARDS.filter((shardId) => !owners.has(shardId))).toEqual([]);
  });

  test('under a role, an unreachable member that carries it is handed none either', async () => {
    // The role branch used to be the candidate set's only membership read, and
    // it asked whether the member carried the role, not whether it was up.
    const placement = await startPlacement('placement-unreachable-role', { role: ROLE });
    stageMember(placement, 'peer-a', 'up', [ROLE]);
    stageMember(placement, 'peer-b', 'up', [ROLE]);
    stageMember(placement, 'peer-x', 'unreachable', [ROLE]);
    fabricate(placement, [['peer-a', []], ['peer-b', []], ['peer-x', []]]);
    const { coordinator } = placement;

    // Shard 2 is the third member's under the default strategy over all three.
    coordinator.tryAllocate(2);
    expect(hostOf(coordinator.shardHome.get(2))).not.toBe('peer-x');
    expect(coordinator.shardHome.has(2)).toBe(true);

    letTheSetSettle(coordinator);
    for (const shardId of ALL_SHARDS) if (!coordinator.shardHome.has(shardId)) coordinator.tryAllocate(shardId);
    const owners = ownersByShard(coordinator);
    expect(ALL_SHARDS.filter((shardId) => owners.get(shardId) === 'peer-x')).toEqual([]);
  });

  test('a region on an address with no member record is never allocated a shard', async () => {
    // Nothing will ever decide about a node that is not a member at all, so it
    // fails the predicate for good — the no-role branch never read membership.
    const placement = await startPlacement('placement-absent');
    stageMember(placement, 'peer-a', 'up');
    fabricate(placement, [['peer-a', []], ['peer-z', []]]);
    const { coordinator } = placement;

    for (const shardId of ALL_SHARDS.slice(0, NUM_SHARDS / 2)) coordinator.tryAllocate(shardId);
    letTheSetSettle(coordinator);
    for (const shardId of ALL_SHARDS.slice(NUM_SHARDS / 2)) coordinator.tryAllocate(shardId);

    const owners = ownersByShard(coordinator);
    expect(ALL_SHARDS.filter((shardId) => owners.get(shardId) === 'peer-z')).toEqual([]);
    expect(ALL_SHARDS.filter((shardId) => owners.get(shardId) !== 'peer-a')).toEqual([]);
  });

  test('while the set settles, a full-set pick on an up member stands and one on the parked member falls back', async () => {
    // Over all three in address order shard n goes to the (n mod 3)-th member,
    // over the two that are up to the (n mod 2)-th.  Shards 3 and 4 are where
    // the two answers disagree although both name an up member: keeping the
    // full-set pick is what keeps a blip from moving shards that did not have
    // to move.  Shards 2 and 5 hash onto the parked member and take the
    // eligible pick instead.
    const placement = await startPlacement('placement-settling');
    stageMember(placement, 'peer-a', 'up');
    stageMember(placement, 'peer-b', 'up');
    stageMember(placement, 'peer-x', 'unreachable');
    fabricate(placement, [['peer-a', []], ['peer-b', []], ['peer-x', []]]);
    const { coordinator } = placement;

    for (const shardId of [2, 3, 4, 5]) coordinator.tryAllocate(shardId);

    const owners = ownersByShard(coordinator);
    expect([3, 4].map((shardId) => owners.get(shardId))).toEqual(['peer-a', 'peer-b']);
    expect([2, 5].map((shardId) => owners.get(shardId))).toEqual(['peer-a', 'peer-b']);
  });
});

describe('rebalancing waits for the set of up members to hold still (#1467)', () => {
  test('a member that goes unreachable and returns inside the window starts no hand-off', async () => {
    const placement = await startPlacement('rebalance-blip');
    for (const host of ['peer-a', 'peer-b', 'peer-x']) stageMember(placement, host, 'up');
    fabricate(placement, byHash(placement, ['peer-a', 'peer-b', 'peer-x']));
    const { coordinator } = placement;
    letTheSetSettle(coordinator);

    // The baseline: placed where the strategy wants every shard, so a tick that
    // starts anything below does it because of the blip.
    coordinator.rebalanceTick();
    expect(inFlight(coordinator)).toEqual([]);

    stageMember(placement, 'peer-x', 'unreachable');
    coordinator.rebalanceTick();
    expect(inFlight(coordinator), 'a hand-off started while the member was unreachable').toEqual([]);

    stageMember(placement, 'peer-x', 'up');
    coordinator.rebalanceTick();
    expect(inFlight(coordinator), 'a hand-off started as the member came back').toEqual([]);

    // And once the window has run out on the restored set: still balanced, so
    // nothing placed before the blip moves at all.
    letTheSetSettle(coordinator);
    coordinator.rebalanceTick();
    expect(inFlight(coordinator), 'a hand-off started once the set had settled again').toEqual([]);
    expect(ownersByShard(coordinator)).toEqual(new Map(
      byHash(placement, ['peer-a', 'peer-b', 'peer-x'])
        .flatMap(([host, shardIds]) => shardIds.map((shardId) => [shardId, host] as const)),
    ));
  });

  test('a member swapped for another restarts the window, though the set keeps its size', async () => {
    // The set is compared by which regions are in it, not by how many: one
    // member dropping out while another comes back is a change, and nothing is
    // rebalanced onto the newcomer until the swapped set has held still.  A
    // count would call the two sets equal and rebalance at once.  The newcomer
    // sorts first, so every up member's shards hash one place along and the
    // swap has hand-offs to start; one that took the parked member's place in
    // address order would inherit only shards a parked owner keeps.
    const placement = await startPlacement('rebalance-swap');
    for (const host of ['peer-b', 'peer-c', 'peer-x']) stageMember(placement, host, 'up');
    stageMember(placement, 'peer-a', 'unreachable');
    fabricate(placement, [...byHash(placement, ['peer-b', 'peer-c', 'peer-x']), ['peer-a', []]]);
    const { coordinator } = placement;
    letTheSetSettle(coordinator);
    coordinator.rebalanceTick();
    expect(inFlight(coordinator)).toEqual([]);

    // Three eligible regions before the swap and three after it.
    stageMember(placement, 'peer-x', 'unreachable');
    stageMember(placement, 'peer-a', 'up');
    coordinator.rebalanceTick();
    expect(inFlight(coordinator), 'a hand-off started before the swapped set had held still').toEqual([]);

    // The window delays rebalancing onto the newcomer; it does not forbid it.
    letTheSetSettle(coordinator);
    coordinator.rebalanceTick();
    expect(inFlight(coordinator).length, 'the newcomer drew nothing once the swapped set had settled')
      .toBeGreaterThan(0);
    expect(inFlight(coordinator).map(([, from]) => from)).not.toContain('peer-x');
  });

  test('a member parked past the window costs one round of moves, and the next tick starts nothing', async () => {
    // Placed over all three, then the third is parked for good.  Over the two
    // that are up, 8 of the 24 shards hash elsewhere than where they are: the
    // ones on the first member with an odd id and the ones on the second with an
    // even id.  Each moves once, to the other up member, and stays there — where
    // a full-set-first allocation after settling would put every one of them
    // straight back and the next tick would hand off the same eight again.
    const placement = await startPlacement('rebalance-parked');
    for (const host of ['peer-a', 'peer-b', 'peer-x']) stageMember(placement, host, 'up');
    fabricate(placement, byHash(placement, ['peer-a', 'peer-b', 'peer-x']));
    const { coordinator } = placement;
    stageMember(placement, 'peer-x', 'unreachable');
    letTheSetSettle(coordinator);
    const before = ownersByShard(coordinator);

    coordinator.rebalanceTick();
    const moved = inFlight(coordinator);
    expect(moved).toEqual([
      [3, 'peer-a'], [4, 'peer-b'], [9, 'peer-a'], [10, 'peer-b'],
      [15, 'peer-a'], [16, 'peer-b'], [21, 'peer-a'], [22, 'peer-b'],
    ]);

    completeEveryHandOff(placement);
    const after = ownersByShard(coordinator);
    for (const [shardId, from] of moved) {
      expect(after.get(shardId), `shard ${shardId} went back to the owner it was handed off from`).not.toBe(from);
      expect(after.get(shardId)).not.toBe('peer-x');
    }
    // Nothing else moved: the parked member's shards stay where the downing
    // decision will find them.
    for (const shardId of ALL_SHARDS.filter((id) => !moved.some(([movedId]) => movedId === id))) {
      expect(after.get(shardId)).toBe(before.get(shardId));
    }

    coordinator.rebalanceTick();
    expect(inFlight(coordinator), 'the tick after the round started more hand-offs').toEqual([]);
  });

  test('with a member parked, a fresh region still draws shards and none leaves the parked member', async () => {
    // The fresh member sorts between the first two, so over the three that are
    // up every shard of the second member hashes onto it — rebalancing has to
    // keep working while a member is parked, or a node that joins during an
    // outage would get nothing until somebody downed the parked one.  Over all
    // four registered regions, six of the parked member's own shards would hash
    // elsewhere, and a hand-off from a parked owner can only time out into a
    // force-reallocation: a second live home for each.
    const placement = await startPlacement('rebalance-parked-join');
    for (const host of ['peer-a', 'peer-b', 'peer-x']) stageMember(placement, host, 'up');
    fabricate(placement, byHash(placement, ['peer-a', 'peer-b', 'peer-x']));
    const { coordinator } = placement;
    stageMember(placement, 'peer-x', 'unreachable');
    stageMember(placement, 'peer-ab', 'up');
    coordinator.regions.set(keyOf(placement, 'peer-ab'), {
      node: peerAddress(placement, 'peer-ab'),
      path: regionPath('peer-ab'),
      proxy: false,
      shards: new Set<number>(),
      lastSeenAtMs: 0,
      lastHeartbeatAtMs: null,
      seededFromSnapshot: false,
    });
    letTheSetSettle(coordinator);

    coordinator.rebalanceTick();

    const moving = inFlight(coordinator);
    expect(moving.filter(([, from]) => from === 'peer-x'), 'a hand-off started from the parked member').toEqual([]);
    expect(moving.map(([shardId]) => shardId)).toEqual([1, 4, 7, 10, 13, 16, 19, 22]);
    expect(new Set(moving.map(([, from]) => from))).toEqual(new Set(['peer-b']));

    completeEveryHandOff(placement);
    const owners = ownersByShard(coordinator);
    expect(moving.map(([shardId]) => owners.get(shardId))).toEqual(Array(moving.length).fill('peer-ab'));
  });

  test('a proposal for a shard whose owner is not up is dropped, whatever strategy made it', async () => {
    // The default strategy never proposes the parked member's shards — it is
    // shown only the eligible regions and what they hold — so a strategy that
    // proposes every id is what reaches the coordinator's own filter.
    const placement = await startPlacement('rebalance-parked-owner', { strategy: new ProposesEveryShardStrategy() });
    for (const host of ['peer-a', 'peer-b', 'peer-x']) stageMember(placement, host, 'up');
    fabricate(placement, byHash(placement, ['peer-a', 'peer-b', 'peer-x']));
    const { coordinator } = placement;
    stageMember(placement, 'peer-x', 'unreachable');
    letTheSetSettle(coordinator);

    coordinator.rebalanceTick();

    const moving = inFlight(coordinator);
    expect(moving.filter(([, from]) => from === 'peer-x'), 'a hand-off started from the parked member').toEqual([]);
    // Everything else it proposed was taken: the filter is on the owner, not a
    // refusal of the whole proposal.
    expect(moving.map(([shardId]) => shardId)).toEqual(ALL_SHARDS.filter((shardId) => shardId % 3 !== 2));
  });
});

describe('rebalancing moves a shard off a registered region that is no candidate (#1467)', () => {
  // A region can be registered, on a member that is up, and still be no
  // candidate — refused over its shard count, or on a member without the
  // type's role — and hold shards all the same: a coordinator-state snapshot
  // seeds them before the refusal, a registration claims them, a role is taken
  // off a node.  Rebalancing moves them onto the candidates.  Handing the
  // strategy only the candidates' shards left them where they were for good.

  test('a region on an up member without the role gives its shards up to the candidates that are up', async () => {
    const placement = await startPlacement('rebalance-off-role-less', { role: ROLE });
    stageMember(placement, 'peer-a', 'up', [ROLE]);
    stageMember(placement, 'peer-b', 'up', [ROLE]);
    stageMember(placement, 'peer-x', 'unreachable', [ROLE]);
    stageMember(placement, 'peer-y', 'up');
    const held = ALL_SHARDS.slice(0, NUM_SHARDS / 2);
    fabricate(placement, [['peer-a', []], ['peer-b', []], ['peer-x', []], ['peer-y', held]]);
    const { coordinator } = placement;

    // Not while the set settles: the window holds for these shards as for any.
    coordinator.rebalanceTick();
    expect(inFlight(coordinator), 'a hand-off started before the set had settled').toEqual([]);

    letTheSetSettle(coordinator);
    coordinator.rebalanceTick();
    expect(inFlight(coordinator)).toEqual(held.map((shardId): [number, string] => [shardId, 'peer-y']));

    completeEveryHandOff(placement);
    // Over the two candidates that are up, in address order — none onto the
    // parked one, which is a candidate too.
    const owners = ownersByShard(coordinator);
    expect(held.map((shardId) => owners.get(shardId)))
      .toEqual(held.map((shardId) => (shardId % 2 === 0 ? 'peer-a' : 'peer-b')));
  });

  test('a region refused over its shard count gives up the shards a snapshot seeded it with', async () => {
    // The state a seeding snapshot followed by the region's own refused
    // `Register` leaves behind: the entry stays, with its shards, and its key is
    // refused.  For as long as the shards are homed there, every region asking
    // for one is told the refused region has it — a region that hashes entity
    // ids under another count, which is the split the refusal exists to
    // prevent.
    const placement = await startPlacement('rebalance-off-refused');
    for (const host of ['peer-a', 'peer-b', 'peer-r']) stageMember(placement, host, 'up');
    fabricate(placement, [['peer-a', []], ['peer-b', []], ['peer-r', [3, 5]]]);
    const { coordinator } = placement;
    coordinator.refusedRegions.add(keyOf(placement, 'peer-r'));

    letTheSetSettle(coordinator);
    coordinator.rebalanceTick();
    expect(inFlight(coordinator)).toEqual([[3, 'peer-r'], [5, 'peer-r']]);

    // A refused region gave its shards up when it was refused, so it does not
    // answer the hand-off: each one ends at its timeout, forced the way the
    // coordinator's own timer forces it.
    for (const shardId of [3, 5]) {
      coordinator.rebalanceInProgress.get(shardId)!.timer.cancel();
      coordinator.onHandOffTimeout(shardId);
    }
    expect([3, 5].map((shardId) => hostOf(coordinator.shardHome.get(shardId)))).toEqual(['peer-b', 'peer-b']);
    expect(coordinator.regions.get(keyOf(placement, 'peer-r'))!.shards.size).toBe(0);
  });

  test('rebalance is shown the shards of every region on an up member, and nothing of a member that is not up', async () => {
    const strategy = new RecordsWhatItIsShown();
    const placement = await startPlacement('rebalance-map', { role: ROLE, strategy });
    stageMember(placement, 'peer-a', 'up', [ROLE]);
    stageMember(placement, 'peer-r', 'up', [ROLE]);
    stageMember(placement, 'peer-x', 'unreachable', [ROLE]);
    stageMember(placement, 'peer-y', 'up');
    fabricate(placement, [['peer-a', [0, 1]], ['peer-r', [2, 3]], ['peer-x', [4, 5]], ['peer-y', [6, 7]]]);
    const { coordinator } = placement;
    coordinator.refusedRegions.add(keyOf(placement, 'peer-r'));
    letTheSetSettle(coordinator);
    strategy.calls.length = 0;

    coordinator.rebalanceTick();

    expect(strategy.calls).toEqual([{
      method: 'rebalance',
      shardId: null,
      // The candidates are the eligible regions: up, not refused, with the role.
      candidates: ['peer-a'],
      // The map is every region on an up member, candidate or not, and nothing
      // of the parked one: its shards wait for the decision about its member.
      shards: { 'peer-a': [0, 1], 'peer-r': [2, 3], 'peer-y': [6, 7] },
    }]);
  });
});

describe('a shard nobody can take waits for a member to come back (#1467)', () => {
  test('the request stays pending, is warned about once and not as a role mismatch, and is answered once the member is up', async () => {
    const logger = new RecordingLogger();
    const placement = await startPlacement('placement-no-eligible', { role: ROLE, logger });
    stageMember(placement, 'peer-x', 'unreachable', [ROLE]);
    // A member that is up but carries no role: registered, so the type is not
    // cold-starting, and filtered out by the role rather than by reachability.
    stageMember(placement, 'peer-y', 'up');
    fabricate(placement, [['peer-x', []], ['peer-y', []]]);
    const { coordinator } = placement;
    const requester = placement.cluster.selfAddress.toJSON();
    const ask = (shardId: number): void => coordinator.onGetShardHome({
      kind: 'sharding.GetShardHome',
      shardId,
      requester: '/system/cluster-sharding/region-entity',
      requesterNode: requester,
    });
    const warnings = (needle: string): string[] => logger.records
      .filter((record) => record.level === 'warn' && record.message.includes(needle))
      .map((record) => record.message);
    const before = warnings('carries role').length;

    ask(5);
    ask(6);

    expect(coordinator.shardHome.has(5)).toBe(false);
    expect(coordinator.shardHome.has(6)).toBe(false);
    expect(coordinator.pending.get(5)).toHaveLength(1);
    expect(warnings('carries role')).toHaveLength(before);
    const noEligible = warnings('is on a member that is up');
    expect(noEligible).toHaveLength(1);
    expect(noEligible[0]).toContain(`"${TYPE_NAME}"`);

    // The member is back: in production it re-emits `MemberUp`, on which every
    // region re-registers and re-asks its buffered shards, so the renewed ask
    // is all the coordinator needs.
    stageMember(placement, 'peer-x', 'up');
    ask(5);

    expect(hostOf(coordinator.shardHome.get(5))).toBe('peer-x');
    expect(coordinator.pending.has(5)).toBe(false);
    expect(warnings('is on a member that is up')).toHaveLength(1);

    // That allocation ended the episode, so the member dropping out again is
    // a new one and is reported again — a latch that never cleared would
    // leave the second outage silent.
    stageMember(placement, 'peer-x', 'unreachable');
    ask(7);
    expect(coordinator.shardHome.has(7)).toBe(false);
    expect(warnings('is on a member that is up')).toHaveLength(2);
  });
});

describe('the settle record belongs to one leader term (#1467)', () => {
  test('losing the leadership drops it, so the next term settles before it rebalances', async () => {
    const placement = await startPlacement('settle-record-term');
    for (const host of ['peer-a', 'peer-b']) stageMember(placement, host, 'up');
    // Every shard on the first member: over two members the default strategy
    // wants half of them on the second, so a tick that consults it hands off
    // twelve.
    fabricate(placement, [['peer-a', ALL_SHARDS], ['peer-b', []]]);
    const { coordinator } = placement;
    letTheSetSettle(coordinator);

    // A member sorting before this node takes the leadership and the
    // coordinator steps down, as its `LeaderChanged` handler does.  The steps
    // below are synchronous, so no tick of the cluster's runs in between.
    const members = (placement.cluster as unknown as ClusterInternals).members;
    const usurper = new NodeAddress(placement.systemName, 'a', 2_551);
    expect(usurper.compareTo(placement.cluster.selfAddress)).toBeLessThan(0);
    members.set(usurper.toString(), new Member(usurper, 'up', 1));
    coordinator.onLeaderChanged();
    expect(coordinator.eligibleSetRecord).toBeNull();

    // This node leads again; the step-down cleared the registry, so the same
    // regions come back.  Their set is the one that had settled before — and
    // the new term still counts its first look at it as a change.
    members.set(usurper.toString(), members.get(usurper.toString())!.withStatus('removed'));
    coordinator.onLeaderChanged();
    fabricate(placement, [['peer-a', ALL_SHARDS], ['peer-b', []]]);
    coordinator.rebalanceTick();
    expect(inFlight(coordinator), 'the first tick of a new term consulted the strategy').toEqual([]);

    letTheSetSettle(coordinator);
    coordinator.rebalanceTick();
    expect(inFlight(coordinator)).toHaveLength(NUM_SHARDS / 2);
  });
});

describe('the membership settle window is derived from the downing timings (#1467)', () => {
  test('with no downing provider it is the failure detector\'s down-after', async () => {
    // Without a provider `down-after` is the detector's own verdict: auto-down
    // removes the member then, and with auto-down off it stays parked.  The
    // resolver's `stable-after` is still configured — 20 s from the shipped
    // file — and must not be what the answer follows, since nothing reads it.
    const { cluster } = await joinCluster('settle-window-no-provider', {
      configure: (options) => { options.withFailureDetector(SHORT_FAILURE_DETECTOR); },
    });

    expect(cluster._membershipSettleWindowMs).toBe(SHORT_FAILURE_DETECTOR.downAfterMs);
  });

  test('the shipped configuration answers the shipped down-after', async () => {
    const { cluster } = await joinCluster('settle-window-shipped');

    expect(cluster._membershipSettleWindowMs).toBe(5_000);
  });

  test('with a provider it is stable-after when that is the longer of the two', async () => {
    // The resolver is consulted only once the view has held still for
    // `stable-after`, so no member is decided about any sooner.
    const { cluster } = await joinCluster('settle-window-provider-stable', {
      configure: (options) => {
        options.withFailureDetector(SHORT_FAILURE_DETECTOR);
        options.withDowning(new KeepMajority());
        options.withSplitBrainResolver({ stableAfterMs: 2_000 });
      },
    });

    expect(cluster._membershipSettleWindowMs).toBe(2_000);
  });

  test('with a provider it is down-after when that is the longer of the two', async () => {
    // A detector slower than the resolver's window: the member is not even
    // handed to the resolver before `down-after`, so the larger value wins.
    const { cluster } = await joinCluster('settle-window-provider-down', {
      configure: (options) => {
        options.withFailureDetector(SHORT_FAILURE_DETECTOR);
        options.withDowning(new KeepMajority());
        options.withSplitBrainResolver({ stableAfterMs: 300 });
      },
    });

    expect(cluster._membershipSettleWindowMs).toBe(SHORT_FAILURE_DETECTOR.downAfterMs);
  });

  test('a strategy selected through HOCON alone counts as a provider', async () => {
    // No `withDowning` anywhere: the strategy exists only in the config file,
    // which is how most deployments select one.  The answer has to move with it.
    const { cluster } = await joinCluster('settle-window-hocon-strategy', {
      hocon: [
        'actor-ts.cluster.split-brain-resolver.active-strategy = keep-majority',
        'actor-ts.cluster.split-brain-resolver.stable-after = 9s',
      ].join('\n'),
    });

    expect(cluster._membershipSettleWindowMs).toBe(9_000);
  });
});
