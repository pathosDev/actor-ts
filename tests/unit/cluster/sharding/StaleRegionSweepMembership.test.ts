/**
 * The stale-region sweep against the membership view (#853, #1467).
 *
 * A node that stops answering is not removed by the failure detector on its
 * own word: it is marked `unreachable` and stays a member until somebody
 * decides — a split-brain strategy, `failure-detector.auto-down = on`, or an
 * operator.  A region on such a node is silent for exactly the reason the
 * sweep looks for, and evicting it re-homes its shards onto the other side of
 * what may be a partition while the cut-off node keeps running them: one
 * shard, two live homes, two writers on one `persistenceId`.  So the sweep
 * leaves those regions to the membership decision, and re-arms their silence
 * clock while it does, so a node that comes back is judged afresh rather than
 * on the silence it accumulated while it was cut off.
 *
 * Driven at the unit level because the interesting states are membership
 * states, and producing each of them with real nodes takes a partition, a
 * failure detector and the timing between the two.  The harness is
 * `RebalanceCeiling.test.ts`'s: a live coordinator from a real single-node
 * cluster, its registry written directly, and its production `sweepStaleRegions`
 * called by the test — the periodic tick is pushed far out so no sweep runs
 * that the test did not ask for.
 *
 * The member records are injected into the cluster's own map, at addresses that
 * sort *after* the local node's: the leader is the lowest-addressed `up`
 * member, and an injected `up` peer that sorted first would make this node a
 * follower.  Nothing reverts them — the failure detector answers `healthy` for
 * an address it has never sampled, and only a heartbeat moves a member out of
 * `unreachable`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { Member } from '../../../../src/cluster/Member.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import type { MemberStatus } from '../../../../src/cluster/Protocol.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { coordinatorSegments } from '../../../util/SystemPaths.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type WorkCommand = { id: string; kind: 'work' };

const TYPE_NAME = 'entity';
const NUM_SHARDS = 8;
const HEARTBEAT_INTERVAL_MS = 100;
/**
 * Short, because one case waits a full window out in real time.  Long enough
 * that the local region — which beats every {@link HEARTBEAT_INTERVAL_MS} — is
 * never a candidate itself, so a sweep the test drives judges only the entries
 * it fabricated.
 */
const STALE_AFTER_MS = 400;

class Entity extends Actor<WorkCommand> {
  override onReceive(): void {}
}

/** The registry entry as the sweep reads it — the #853 stamps included. */
type RegionInfo = {
  readonly node: NodeAddress;
  readonly path: string;
  readonly proxy: boolean;
  readonly shards: Set<number>;
  lastSeenAtMs: number;
  lastHeartbeatAtMs: number | null;
};

/** The coordinator's own state, reached through its cell — no public surface exposes it. */
type CoordinatorInternals = {
  readonly regions: Map<string, RegionInfo>;
  readonly shardHome: Map<number, string>;
  sweepStaleRegions(): void;
};

/** The cluster's membership map, written directly to stage a member in any status. */
type ClusterInternals = { readonly members: Map<string, Member> };

type Harness = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly coordinator: CoordinatorInternals;
  readonly systemName: string;
};

let running: Harness | null = null;
let nextPort = 47_850;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* best-effort */ });
    await running.system.terminate().catch(() => { /* best-effort */ });
    running = null;
  }
});

/**
 * A single-node cluster with stale-region detection on and the live coordinator
 * behind it.  `rebalanceIntervalMs` is pushed far out so the sweep only ever
 * runs when a test calls it.
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
    .withPassivationIdleMs(0)
    .withRebalanceIntervalMs(600_000)
    .withStaleRegionDetection(true)
    .withRegionHeartbeatIntervalMs(HEARTBEAT_INTERVAL_MS)
    .withRegionStaleAfterMs(STALE_AFTER_MS);
  const region = cluster.sharding.start<WorkCommand>(shardingOptions);

  const reachCoordinator = (): CoordinatorInternals | null => {
    const resolved = system._resolvePath(coordinatorSegments(systemName, TYPE_NAME));
    if (resolved.isNone()) return null;
    const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
    return (cell?.actor as CoordinatorInternals | undefined) ?? null;
  };

  // The coordinator instantiates on its first message and the local region
  // registers asynchronously; both have to have happened before entries are
  // fabricated beside the local one.
  region.tell({ id: 'warm-up', kind: 'work' });
  await awaitCondition(() => (reachCoordinator()?.regions.size ?? 0) > 0, {
    timeoutMs: 4_000,
    label: 'the coordinator is live and the local region has registered',
  });

  const harness: Harness = { system, cluster, coordinator: reachCoordinator()!, systemName };
  running = harness;
  return harness;
}

/**
 * An address on `host` for this harness's system.  Every host used here sorts
 * after the local node's `h`, so no injected `up` member takes the leadership.
 */
function peerAddress(harness: Harness, host: string): NodeAddress {
  const address = new NodeAddress(harness.systemName, host, 2_551);
  expect(address.compareTo(harness.cluster.selfAddress)).toBeGreaterThan(0);
  return address;
}

/** Put a member record for `address` in `status` into this node's view. */
function stageMember(harness: Harness, address: NodeAddress, status: MemberStatus): void {
  const members = (harness.cluster as unknown as ClusterInternals).members;
  const existing = members.get(address.toString());
  members.set(
    address.toString(),
    existing === undefined ? new Member(address, status, 1) : existing.withStatus(status),
  );
}

/**
 * Register a region on `address` that has beaten — so it is a sweep candidate —
 * and has been silent for twice the window, so a sweep that judged it on
 * silence alone would evict it at once.  Returns its registry key.
 */
function staleArmedRegion(harness: Harness, address: NodeAddress, shardIds: number[]): string {
  const path = `/system/cluster-sharding/region-${TYPE_NAME}`;
  const key = `${address}|${path}`;
  const silentSince = Date.now() - STALE_AFTER_MS * 2;
  harness.coordinator.regions.set(key, {
    node: address,
    path,
    proxy: false,
    shards: new Set(shardIds),
    lastSeenAtMs: silentSince,
    lastHeartbeatAtMs: silentSince,
  });
  for (const shardId of shardIds) harness.coordinator.shardHome.set(shardId, key);
  return key;
}

describe('the stale-region sweep leaves a node that is not up to the membership decision', () => {
  test('an armed, silent region on an unreachable member is not evicted', async () => {
    const harness = await startCoordinator('sweep-unreachable');
    const address = peerAddress(harness, 'peer-unreachable');
    stageMember(harness, address, 'unreachable');
    const key = staleArmedRegion(harness, address, [1, 3]);

    harness.coordinator.sweepStaleRegions();

    // Still registered and still the home of its shards: until the membership
    // decides about the node, the coordinator does not re-home them away from
    // a node that may still be running them.
    expect(harness.coordinator.regions.has(key)).toBe(true);
    expect(harness.coordinator.shardHome.get(1)).toBe(key);
    expect(harness.coordinator.shardHome.get(3)).toBe(key);
  }, 10_000);

  test('every not-yet-decided status parks the region, not only unreachable', async () => {
    // The sweep's question is "has the cluster decided about this node", and a
    // member in any status but `up` is one it has not — `joining` and
    // `weakly-up` have not been admitted, `leaving` and `down` are on their way
    // out and will end in `MemberRemoved`, which evicts through its own path.
    const harness = await startCoordinator('sweep-undecided');
    const statuses: MemberStatus[] = ['joining', 'weakly-up', 'unreachable', 'leaving', 'down'];
    const keys = statuses.map((status) => {
      const address = peerAddress(harness, `peer-${status}`);
      stageMember(harness, address, status);
      return [status, staleArmedRegion(harness, address, [])] as const;
    });

    harness.coordinator.sweepStaleRegions();

    const evicted = keys
      .filter(([, key]) => !harness.coordinator.regions.has(key))
      .map(([status]) => status);
    expect(evicted).toEqual([]);
  }, 10_000);

  test('a member back at up is judged afresh: not on the next sweep, but one window later', async () => {
    const harness = await startCoordinator('sweep-recovered');
    const address = peerAddress(harness, 'peer-recovered');
    stageMember(harness, address, 'unreachable');
    const key = staleArmedRegion(harness, address, [5]);

    // While the node is parked the sweep restarts the region's silence clock —
    // the coordinator's own stamp, read back rather than assumed.
    harness.coordinator.sweepStaleRegions();
    const rearmedAt = harness.coordinator.regions.get(key)?.lastSeenAtMs ?? 0;
    expect(rearmedAt).toBeGreaterThan(Date.now() - STALE_AFTER_MS);

    stageMember(harness, address, 'up');

    // The node is up again and its region has sent nothing since.  Judged on
    // the silence it piled up while cut off it would go now; judged from the
    // re-arm it has a full window to be heard from.
    harness.coordinator.sweepStaleRegions();
    expect(harness.coordinator.regions.has(key)).toBe(true);

    // And the grace ends: with no frame from the region, the first sweep a
    // full window after the re-arm evicts it.
    await awaitCondition(() => {
      harness.coordinator.sweepStaleRegions();
      return !harness.coordinator.regions.has(key);
    }, {
      timeoutMs: 3_000,
      intervalMs: 20,
      label: 'the recovered member\'s silent region was evicted once a full window had passed',
    });
    expect(Date.now() - rearmedAt).toBeGreaterThanOrEqual(STALE_AFTER_MS);
    expect(harness.coordinator.shardHome.get(5)).not.toBe(key);
  }, 10_000);

  test('a region on an address with no member record is evicted', async () => {
    // Nothing is going to decide about a node that is not a member at all, so
    // parking its region would park it for good.  `MemberRemoved` already
    // evicts on the way out; an entry that outlived it is the sweep's to clear.
    const harness = await startCoordinator('sweep-absent');
    const address = peerAddress(harness, 'peer-absent');
    const key = staleArmedRegion(harness, address, [7]);

    harness.coordinator.sweepStaleRegions();

    expect(harness.coordinator.regions.has(key)).toBe(false);
    expect(harness.coordinator.shardHome.get(7)).not.toBe(key);
  }, 10_000);

  test('a region on an up member is evicted, so the cases above are about membership', async () => {
    // The control.  The fixture is the unreachable case's to the letter but for
    // the status, so a sweep that stopped evicting altogether — or stopped
    // evicting regions on other nodes — fails here rather than passing above.
    const harness = await startCoordinator('sweep-up');
    const address = peerAddress(harness, 'peer-up');
    stageMember(harness, address, 'up');
    const key = staleArmedRegion(harness, address, [1, 3]);

    harness.coordinator.sweepStaleRegions();

    expect(harness.coordinator.regions.has(key)).toBe(false);
    expect(harness.coordinator.shardHome.get(1)).not.toBe(key);
    expect(harness.coordinator.shardHome.get(3)).not.toBe(key);
  }, 10_000);
});
