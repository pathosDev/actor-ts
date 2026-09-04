/**
 * The coordinator's rebalance ceiling (#850).
 *
 * The defect it bounds is in the DEFAULT strategy, not in the one the issue
 * blamed.  `LeastShardAllocationStrategy` caps itself at `maxSimultaneousRebalance`
 * and is reached from exactly one place in `src/`; every user-started sharded
 * type gets `HashAllocationStrategy`, which returns *every* shard whose
 * `shardId % candidates.length` no longer matches its owner — 42 of the shipped
 * 64 when a third node joins.  So the ceiling sits at
 * `ShardCoordinator.rebalanceTick`, where it bounds that strategy, the other
 * one, and anything a user hands in.
 *
 * Nothing under `tests/unit/` drove `rebalanceTick` before this file, which is
 * why the tests here fabricate the shard map instead of producing it: a real
 * multi-node join is a slow and noisy way to arrange "these shards are on the
 * wrong node".  The coordinator is a live one from a real single-node cluster —
 * the same reach-in `ShardCoordinatorAuthority.test.ts` uses — and its `regions`
 * / `shardHome` maps are then written directly, so every assertion is about the
 * production `rebalanceTick`, `beginHandOff` and `onRegionTerminated`.
 *
 * The fabricated regions name addresses no transport serves.  That is
 * deliberate and harmless: `InMemoryTransport.send` drops a frame for an
 * unregistered peer, and `beginHandOff` records `rebalanceInProgress` *before*
 * it sends, so the state under test is written either way.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import type { AllocationStrategy } from '../../../../src/cluster/sharding/AllocationStrategy.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { coordinatorSegments } from '../../../util/SystemPaths.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type WorkCommand = { id: string; kind: 'work' };

const TYPE_NAME = 'entity';
const NUM_SHARDS = 24;

class Entity extends Actor<WorkCommand> {
  override onReceive(): void {}
}

/**
 * Proposes every shard that is not already moving — the shape
 * `HashAllocationStrategy` produces right after a node joins, without needing a
 * second node to produce it.  The ceiling is what is under test, not which
 * shards a strategy picks.
 */
class MovesEverythingStrategy implements AllocationStrategy {
  allocate(_shardId: number, candidates: ReadonlyArray<NodeAddress>): NodeAddress {
    if (candidates.length === 0) throw new Error('MovesEverythingStrategy: no candidates');
    return [...candidates].sort((left, right) => left.compareTo(right))[0]!;
  }

  rebalance(
    currentShards: ReadonlyMap<string, ReadonlySet<number>>,
    _candidates: ReadonlyArray<NodeAddress>,
    rebalanceInProgress: ReadonlySet<number>,
  ): Set<number> {
    const out = new Set<number>();
    for (const shards of currentShards.values()) {
      for (const shardId of shards) if (!rebalanceInProgress.has(shardId)) out.add(shardId);
    }
    return out;
  }
}

type RegionInfo = {
  readonly node: NodeAddress;
  readonly path: string;
  readonly proxy: boolean;
  readonly shards: Set<number>;
};

/** The coordinator's own state, reached through its cell — no public surface exposes it. */
type CoordinatorInternals = {
  readonly regions: Map<string, RegionInfo>;
  readonly shardHome: Map<number, string>;
  readonly rebalanceInProgress: Map<number, { from: string; timer: { cancel(): void } }>;
  rebalanceTick(): void;
  onRegionTerminated(message: { kind: string; region: string; node: unknown }): void;
};

type Harness = {
  system: ActorSystem;
  cluster: Cluster;
  coordinator: CoordinatorInternals;
};

let running: Harness | null = null;
let nextPort = 47_500;

afterEach(async () => {
  if (running) {
    for (const rebalance of running.coordinator.rebalanceInProgress.values()) rebalance.timer.cancel();
    await running.cluster.leave().catch(() => { /* best-effort */ });
    await running.system.terminate().catch(() => { /* best-effort */ });
    running = null;
  }
});

/** Both limits, always given explicitly — `reference.conf` ships a non-zero one. */
type Limits = { readonly absolute: number; readonly relative: number };

/**
 * A single-node cluster with one sharded type, and the live coordinator behind
 * it.  `rebalanceIntervalMs` is pushed far out so the periodic tick never fires
 * on its own — every tick in this file is one the test asked for — and
 * `handOffTimeoutMs` likewise, so an in-flight hand-off stays in flight for the
 * duration of a test rather than timing out into a reallocation.
 *
 * Both limits are set on every call rather than defaulted: `reference.conf`
 * ships `rebalance-relative-limit = 0.1`, so a test that named only the
 * absolute one would silently be measuring `min(absolute, 2)`.
 */
async function startCoordinator(systemName: string, limits: Limits): Promise<Harness> {
  const port = nextPort++;
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

  const shardingOptions = StartShardingOptions.create<WorkCommand>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    .withAllocationStrategy(new MovesEverythingStrategy())
    .withRebalanceIntervalMs(600_000)
    .withHandOffTimeoutMs(600_000)
    .withPassivationIdleMs(0)
    .withRebalanceAbsoluteLimit(limits.absolute)
    .withRebalanceRelativeLimit(limits.relative);
  const region = cluster.sharding.start<WorkCommand>(shardingOptions);

  const reachCoordinator = (): CoordinatorInternals | null => {
    const resolved = system._resolvePath(coordinatorSegments(systemName, TYPE_NAME));
    if (resolved.isNone()) return null;
    const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
    return (cell?.actor as CoordinatorInternals | undefined) ?? null;
  };

  // The coordinator instantiates on its first message and the local region
  // registers asynchronously, so both have to have happened before the map is
  // fabricated — a `Register` landing afterwards would put the local region
  // back into a map the test had just replaced.
  region.tell({ id: 'warm-up', kind: 'work' });
  await awaitCondition(() => (reachCoordinator()?.regions.size ?? 0) > 0, {
    timeoutMs: 4_000,
    label: 'the coordinator is live and the local region has registered',
  });

  const harness: Harness = { system, cluster, coordinator: reachCoordinator()! };
  running = harness;
  return harness;
}

/**
 * Replace whatever the local region registered with a hand-built map: `owners`
 * node names, each owning the shard ids given, all of them "wrong" as far as
 * {@link MovesEverythingStrategy} is concerned.
 */
function fabricateShardMap(
  coordinator: CoordinatorInternals,
  owners: ReadonlyArray<readonly [string, ReadonlyArray<number>]>,
): void {
  coordinator.regions.clear();
  coordinator.shardHome.clear();
  for (const [name, shardIds] of owners) {
    const node = new NodeAddress('peers', name, 2_551);
    const path = `/system/cluster-sharding/${name}-region`;
    const key = `${node}|${path}`;
    coordinator.regions.set(key, { node, path, proxy: false, shards: new Set(shardIds) });
    for (const shardId of shardIds) coordinator.shardHome.set(shardId, key);
  }
}

/** Region key currently owning `shardId`, or `''` — the assertion target for placement. */
function ownerOf(coordinator: CoordinatorInternals, shardId: number): string {
  return coordinator.shardHome.get(shardId) ?? '';
}

/** How many of the shards in flight came from each owner — the fairness reading. */
function inFlightByOwner(coordinator: CoordinatorInternals): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { from } of coordinator.rebalanceInProgress.values()) {
    counts.set(from, (counts.get(from) ?? 0) + 1);
  }
  return counts;
}

/** Finish a hand-off the way `HandOffComplete` does, minus the wire round trip. */
function completeHandOff(coordinator: CoordinatorInternals, shardId: number): void {
  const inProgress = coordinator.rebalanceInProgress.get(shardId);
  if (!inProgress) return;
  inProgress.timer.cancel();
  coordinator.rebalanceInProgress.delete(shardId);
  coordinator.regions.get(inProgress.from)?.shards.delete(shardId);
  coordinator.shardHome.delete(shardId);
}

describe('ShardCoordinator rebalance ceiling (#850)', () => {
  test('one tick hands off at most the ceiling', async () => {
    // 24 shards, all misplaced; 0.25 of 24 is 6.
    const { coordinator } = await startCoordinator('ceiling-one-tick', { absolute: 0, relative: 0.25 });
    fabricateShardMap(coordinator, [['a', [0, 1, 2, 3, 4, 5, 6, 7]], ['b', [8, 9, 10, 11, 12, 13, 14, 15]], ['c', [16, 17, 18, 19, 20, 21, 22, 23]]]);

    coordinator.rebalanceTick();

    expect(coordinator.rebalanceInProgress.size).toBe(6);
  });

  test('the lower of the two limits wins, and neither ever floors below one shard', async () => {
    // 0.25 × 24 = 6, absolute 2 — so 2.  Without the `min` the absolute limit
    // would be decoration whenever a relative one was also set.
    const { coordinator } = await startCoordinator('ceiling-lower-wins', { absolute: 2, relative: 0.25 });
    fabricateShardMap(coordinator, [['a', [0, 1, 2, 3]], ['b', [4, 5, 6, 7]]]);

    coordinator.rebalanceTick();

    expect(coordinator.rebalanceInProgress.size).toBe(2);
  });

  test('a fraction that truncates to zero still moves one shard', async () => {
    // `Math.floor(0.01 × 24)` is 0.  A cluster that can never move a shard does
    // not rebalance slowly, it does not rebalance at all — which is the one
    // outcome a ceiling must not produce.
    const { coordinator } = await startCoordinator('ceiling-floor-of-one', { absolute: 0, relative: 0.01 });
    fabricateShardMap(coordinator, [['a', [0, 1, 2, 3]], ['b', [4, 5, 6, 7]]]);

    coordinator.rebalanceTick();

    expect(coordinator.rebalanceInProgress.size).toBe(1);
  });

  test('the bound is on shards in flight, so repeated ticks do not stack', async () => {
    // The property a per-tick-only cap fails.  Both shipped strategies skip
    // shards already in `rebalanceInProgress`, so each tick proposes a *fresh*
    // set; with the tick at 2 s and the hand-off timeout at 10 s, a per-tick
    // six would admit roughly thirty at once.
    const { coordinator } = await startCoordinator('ceiling-in-flight', { absolute: 4, relative: 0 });
    fabricateShardMap(coordinator, [['a', [0, 1, 2, 3, 4, 5, 6, 7]], ['b', [8, 9, 10, 11, 12, 13, 14, 15]]]);

    for (let tick = 0; tick < 5; tick++) {
      coordinator.rebalanceTick();
      expect(coordinator.rebalanceInProgress.size).toBe(4);
    }
  });

  test('the cluster still converges — the remainder rides the following ticks', async () => {
    const { coordinator } = await startCoordinator('ceiling-converges', { absolute: 3, relative: 0 });
    fabricateShardMap(coordinator, [['a', [0, 1, 2, 3, 4, 5]], ['b', [6, 7, 8, 9, 10, 11]]]);

    const moved = new Set<number>();
    // Twelve shards, three at a time, each round completing what it started.
    for (let round = 0; round < 4; round++) {
      coordinator.rebalanceTick();
      expect(coordinator.rebalanceInProgress.size).toBeLessThanOrEqual(3);
      for (const shardId of Array.from(coordinator.rebalanceInProgress.keys())) {
        moved.add(shardId);
        completeHandOff(coordinator, shardId);
      }
    }

    expect(Array.from(moved).sort((left, right) => left - right))
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // Nothing left to propose, so a further tick is a no-op rather than a
    // budget spent on shards that already moved.
    coordinator.rebalanceTick();
    expect(coordinator.rebalanceInProgress.size).toBe(0);
  });

  test('the budget is spread round-robin across owners, not drained from the first', async () => {
    // The failure mode a naive `slice(0, budget)` produces: the strategy's Set
    // is built by iterating a map keyed by node address, so the first-registered
    // owner would surrender its shards first and the others would wait however
    // many ticks that takes.  A ceiling that empties one node is worse than no
    // ceiling.
    const { coordinator } = await startCoordinator('ceiling-round-robin', { absolute: 3, relative: 0 });
    fabricateShardMap(coordinator, [['a', [0, 1, 2, 3, 4, 5]], ['b', [6, 7, 8]], ['c', [9, 10, 11]]]);

    coordinator.rebalanceTick();

    expect(coordinator.rebalanceInProgress.size).toBe(3);
    expect([...inFlightByOwner(coordinator).values()]).toEqual([1, 1, 1]);
    // And deterministically the lowest id of each owner, in owner-address
    // order — so the same map always yields the same hand-offs.
    expect(Array.from(coordinator.rebalanceInProgress.keys())).toEqual([0, 6, 9]);
  });

  test('both limits at zero reproduces the unbounded behaviour', async () => {
    const { coordinator } = await startCoordinator('ceiling-uncapped', { absolute: 0, relative: 0 });
    fabricateShardMap(coordinator, [['a', [0, 1, 2, 3, 4, 5]], ['b', [6, 7, 8, 9, 10, 11]]]);

    coordinator.rebalanceTick();

    expect(Array.from(coordinator.rebalanceInProgress.keys()).sort((left, right) => left - right))
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test('a dead region\'s shards are re-homed in one pass, ceiling or not', async () => {
    // The involuntary path must NOT be throttled: those shards have no owner at
    // all, so a budget would leave them unreachable rather than merely slow to
    // settle.  The ceiling here is one shard — a throttled reallocation would
    // leave five of the six homeless.
    const { coordinator } = await startCoordinator('ceiling-region-death', { absolute: 1, relative: 0 });
    fabricateShardMap(coordinator, [['a', [0, 1, 2, 3, 4, 5]], ['b', [6, 7, 8, 9, 10, 11]]]);
    const dead = coordinator.regions.get(Array.from(coordinator.regions.keys())[0]!)!;

    coordinator.onRegionTerminated({
      kind: 'sharding.RegionTerminated',
      region: dead.path,
      node: dead.node.toJSON(),
    });

    for (const shardId of [0, 1, 2, 3, 4, 5]) {
      expect(ownerOf(coordinator, shardId), `shard ${shardId} was left homeless`).not.toBe('');
      expect(ownerOf(coordinator, shardId)).not.toBe(dead.node.toString() + '|' + dead.path);
    }
  });
});
