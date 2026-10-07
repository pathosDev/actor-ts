/**
 * A hand-off that times out has to end the way a completed one does (#1429).
 *
 * `beginHandOff` arms a timer for the region it asked to give a shard up, and
 * when that region never answers the timer forces the shard onto a new home.
 * The timer used to clear `shardHome` and reallocate without taking the id out
 * of the silent region's `RegionInfo.shards` — the step `onHandOffComplete`
 * has always taken — so the shard was afterwards listed under two regions.
 * Everything that reads that set took the phantom for ownership:
 *
 * - `currentShardCounts()` counted the shard under both nodes;
 * - the default `HashAllocationStrategy` proposes any id listed under a node it
 *   does not hash to, so every rebalance tick handed the shard off from its
 *   *true* owner and gave it straight back — a stop and restart of the shard,
 *   journal replay included, once per `rebalance-interval`;
 * - `onRegionTerminated` re-homes every id the departing region lists, so
 *   losing the timed-out region moved the shard off the region that really had
 *   it, and on a live cluster left it with two homes, because the true owner is
 *   never told.
 *
 * The harness is `RebalanceCeiling.test.ts`'s: the live coordinator of a real
 * single-node cluster, reached through its cell, with `regions` / `shardHome`
 * fabricated so every assertion is about the production `rebalanceTick`,
 * `beginHandOff` and `onRegionTerminated`.  The fabricated regions name
 * addresses no transport serves, so the `HandOff` sent to `a` is dropped and
 * never completes — which is how the timeout is forced, rather than by a fake
 * clock: nothing else in this harness can remove the in-flight entry.
 *
 * Shard 7 of 8 is chosen for the default strategy's arithmetic.  It sorts the
 * candidates by address, so with `a`, `b` and `c` registered `7 % 3` places the
 * shard on `b`, and once `a` is gone `7 % 2` would place it on `c` — which
 * makes "the shard stayed on `b`" and "the shard was re-homed" different
 * answers rather than the same one.
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
const NUM_SHARDS = 8;
const SHARD = 7;

/**
 * Short enough that a test waits a tenth of a second for the forced timeout,
 * long enough that the tick which starts the hand-off is long finished first.
 */
const HAND_OFF_TIMEOUT_MS = 100;

class Entity extends Actor<WorkCommand> {
  override onReceive(): void {}
}

type RegionInfo = {
  readonly node: NodeAddress;
  readonly path: string;
  readonly proxy: boolean;
  readonly shards: Set<number>;
  lastSeenAtMs: number;
  lastHeartbeatAtMs: number | null;
};

type InFlightHandOff = { readonly from: string; readonly timer: { cancel(): void } };

/** The coordinator's own state, reached through its cell — no public surface exposes it. */
type CoordinatorInternals = {
  readonly options: { readonly allocationStrategy: AllocationStrategy };
  readonly regions: Map<string, RegionInfo>;
  readonly shardHome: Map<number, string>;
  readonly rebalanceInProgress: Map<number, InFlightHandOff>;
  rebalanceTick(): void;
  candidates(): NodeAddress[];
  currentShardCounts(): Map<string, Set<number>>;
  onRegionTerminated(message: { kind: string; region: string; node: unknown }): void;
};

type FabricatedRegion = {
  readonly name: string;
  readonly node: NodeAddress;
  readonly path: string;
  readonly key: string;
};

type Harness = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly coordinator: CoordinatorInternals;
};

let running: Harness | null = null;
let nextPort = 47_660;

afterEach(async () => {
  if (running) {
    for (const handOff of running.coordinator.rebalanceInProgress.values()) handOff.timer.cancel();
    await running.cluster.leave().catch(() => { /* best-effort */ });
    await running.system.terminate().catch(() => { /* best-effort */ });
    running = null;
  }
});

/**
 * A single-node cluster with one sharded type on the **default** allocation
 * strategy — the one every user-started type gets, and the one that turns the
 * phantom listing into churn — and the live coordinator behind it.
 *
 * `rebalanceIntervalMs` is pushed far out so every tick in this file is one a
 * test asked for.  The rebalance ceiling is left at its defaults on purpose: it
 * never floors below one shard, and one is all any tick here could propose, so
 * it cannot be the reason a tick moves nothing.
 */
async function startCoordinator(systemName: string): Promise<Harness> {
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
    .withRebalanceIntervalMs(600_000)
    .withHandOffTimeoutMs(HAND_OFF_TIMEOUT_MS)
    .withPassivationIdleMs(0);
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

function fabricatedRegion(name: string): FabricatedRegion {
  const node = new NodeAddress('peers', name, 2_551);
  const path = `/system/cluster-sharding/${name}-region`;
  return { name, node, path, key: `${node}|${path}` };
}

const regionA = fabricatedRegion('a');
const regionB = fabricatedRegion('b');
const regionC = fabricatedRegion('c');

/**
 * Replace whatever the local region registered with `a`, `b` and `c`, and home
 * {@link SHARD} on `a` — where the default strategy, hashing over all three,
 * does not want it.  `lastHeartbeatAtMs: null` keeps every fabricated region
 * out of the stale-region sweep whatever that switch says.
 */
function fabricateShardOnA(coordinator: CoordinatorInternals): void {
  coordinator.regions.clear();
  coordinator.shardHome.clear();
  for (const fabricated of [regionA, regionB, regionC]) {
    coordinator.regions.set(fabricated.key, {
      node: fabricated.node,
      path: fabricated.path,
      proxy: false,
      shards: new Set<number>(),
      lastSeenAtMs: 0,
      lastHeartbeatAtMs: null,
    });
  }
  coordinator.regions.get(regionA.key)!.shards.add(SHARD);
  coordinator.shardHome.set(SHARD, regionA.key);
}

/** Region name a key belongs to, so a failure prints `b` rather than a region key. */
function nameOf(key: string | undefined): string {
  for (const fabricated of [regionA, regionB, regionC]) {
    if (fabricated.key === key) return fabricated.name;
  }
  return String(key);
}

/** Which shard ids each region lists, by region name — the derived index under test. */
function listing(coordinator: CoordinatorInternals): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [key, info] of coordinator.regions) {
    out[nameOf(key)] = Array.from(info.shards).sort((left, right) => left - right);
  }
  return out;
}

/** Shards in flight as `[shardId, region it is being handed off from]`. */
function inFlight(coordinator: CoordinatorInternals): Array<[number, string]> {
  return Array.from(coordinator.rebalanceInProgress.entries())
    .map(([shardId, handOff]): [number, string] => [shardId, nameOf(handOff.from)]);
}

/**
 * Drive {@link SHARD} through a hand-off that is never answered: the default
 * strategy proposes moving it off `a`, `rebalanceTick` sends `a` its `HandOff`,
 * the frame goes nowhere, and the timer is what ends it.
 */
async function timeOutHandOffFromA(coordinator: CoordinatorInternals): Promise<void> {
  fabricateShardOnA(coordinator);

  coordinator.rebalanceTick();

  // The precondition, and the half a fix that released ownership too early
  // would break: while the hand-off is in flight the shard is still `a`'s.
  expect(inFlight(coordinator)).toEqual([[SHARD, 'a']]);
  expect(coordinator.regions.get(regionA.key)!.shards.has(SHARD)).toBe(true);
  expect(nameOf(coordinator.shardHome.get(SHARD))).toBe('a');

  await awaitCondition(() => !coordinator.rebalanceInProgress.has(SHARD), {
    timeoutMs: 4_000,
    label: `the hand-off of shard ${SHARD} from a timed out`,
  });
  // The timeout reallocates in the same turn it clears the entry, so by now the
  // shard has its new home.
  expect(nameOf(coordinator.shardHome.get(SHARD))).toBe('b');
}

describe('a hand-off that times out releases the shard from the region it timed out on (#1429)', () => {
  test('only the new owner lists the shard, and the load reading counts it once', async () => {
    const { coordinator } = await startCoordinator('hand-off-timeout-listing');

    await timeOutHandOffFromA(coordinator);

    expect(listing(coordinator)).toEqual({ a: [], b: [SHARD], c: [] });
    const counted = Array.from(coordinator.currentShardCounts().entries())
      .filter(([, shards]) => shards.has(SHARD))
      .map(([address]) => address);
    expect(counted).toEqual([regionB.node.toString()]);
  });

  test('the default strategy neither proposes the shard again nor hands it off from its new owner', async () => {
    const { coordinator } = await startCoordinator('hand-off-timeout-rebalance');

    await timeOutHandOffFromA(coordinator);

    // The strategy's own reading first: a phantom listing under `a` is what it
    // would propose, since `a` is not where 7 hashes to.
    const proposal = coordinator.options.allocationStrategy.rebalance(
      coordinator.currentShardCounts(),
      coordinator.candidates(),
      new Set(coordinator.rebalanceInProgress.keys()),
    );
    expect(Array.from(proposal)).toEqual([]);

    // And the tick the coordinator would run on its own every two seconds: it
    // must not stop the shard on `b`, where it now correctly lives, only to
    // allocate it straight back there.
    for (let tick = 1; tick <= 3; tick++) {
      coordinator.rebalanceTick();
      expect(inFlight(coordinator), `tick ${tick} put a hand-off in flight`).toEqual([]);
    }
    expect(nameOf(coordinator.shardHome.get(SHARD))).toBe('b');
  });

  test('terminating the region the hand-off timed out on leaves the shard with its new owner', async () => {
    const { coordinator } = await startCoordinator('hand-off-timeout-termination');

    await timeOutHandOffFromA(coordinator);

    coordinator.onRegionTerminated({
      kind: 'sharding.RegionTerminated',
      region: regionA.path,
      node: regionA.node.toJSON(),
    });

    // With `a` gone the default strategy would place 7 on `c`, so a shard that
    // `a` still listed would be re-homed there — away from `b`, which on a live
    // cluster is never told and keeps hosting it.
    expect(nameOf(coordinator.shardHome.get(SHARD))).toBe('b');
    expect(listing(coordinator)).toEqual({ b: [SHARD], c: [] });
  });
});
