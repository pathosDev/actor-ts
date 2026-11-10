/**
 * #1272 — a coordinator that has just become leader places no shard before the
 * regions that may already run it have said so.
 *
 * A coordinator runs on every node and takes authority from `isLeader()`, so a
 * leader change hands it over with no protocol between the two instances. The
 * incoming one starts from an empty map, and the other members' regions learn
 * of the change through gossip, each at its own moment. A shard placed in that
 * window was placed on a map that did not yet hold the region running it: a
 * node restarted at the lowest address, or one that joins with it, becomes
 * leader at once and the first `GetShardHome` it answered put the shard on
 * itself while a survivor still hosted it.
 *
 * The cases drive the live coordinator of a one-node cluster through its own
 * handlers, with peers staged as `up` members of its view — the seam
 * `ShardPlacementReachability` uses — so the order of events is the test's and
 * not the scheduler's.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { Member } from '../../../../src/cluster/Member.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import type { GetShardHome, RegisterRegion } from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { coordinatorSegments } from '../../../util/SystemPaths.js';

type WorkCommand = { id: string; kind: 'work' };

const TYPE_NAME = 'entity';
const NUM_SHARDS = 12;
/** The shard the cases ask about — any id the warm-up did not already place. */
const SHARD = 7;
const GOSSIP_INTERVAL_MS = 30;

class Entity extends Actor<WorkCommand> {
  override onReceive(): void {}
}

type RegionEntry = {
  node: NodeAddress;
  path: string;
  proxy: boolean;
  shards: Set<number>;
  lastSeenAtMs: number;
  lastHeartbeatAtMs: number | null;
  seededFromSnapshot: boolean;
};

/** The private surface these cases drive — the coordinator's own handlers, by design. */
interface CoordinatorInternals {
  readonly regions: Map<string, RegionEntry>;
  readonly shardHome: Map<number, string>;
  readonly pending: Map<number, unknown[]>;
  readonly registrationBarrier: { readonly awaiting: Set<string> } | null;
  onLeaderChanged(): void;
  onRegister(message: RegisterRegion): void;
  onGetShardHome(message: GetShardHome): void;
}

type ClusterInternals = { readonly members: Map<string, Member> };

type Harness = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly systemName: string;
  readonly coordinator: CoordinatorInternals;
};

const started: Harness[] = [];
let nextPort = 48_900;

afterEach(async () => {
  for (const harness of started.splice(0)) {
    await harness.cluster.leave().catch(() => { /* best-effort */ });
    await harness.system.terminate().catch(() => { /* best-effort */ });
  }
});

async function startHarness(systemName: string): Promise<Harness> {
  const port = nextPort++;
  const system = ActorSystem.create(
    systemName,
    ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
  );
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(GOSSIP_INTERVAL_MS)
    .withFailureDetectorAutoDown(false);
  const cluster = await Cluster.join(system, clusterOptions);
  const shardingOptions = StartShardingOptions.create<WorkCommand>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    .withRebalanceIntervalMs(600_000)
    .withHandOffTimeoutMs(600_000)
    .withPassivationIdleMs(0);
  const region = cluster.sharding.start<WorkCommand>(shardingOptions);
  const reach = (): CoordinatorInternals | null => {
    const resolved = system._resolvePath(coordinatorSegments(systemName, TYPE_NAME));
    if (resolved.isNone()) return null;
    const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
    return (cell?.actor as CoordinatorInternals | undefined) ?? null;
  };
  region.tell({ id: 'warm-up', kind: 'work' });
  await awaitCondition(() => {
    const coordinator = reach();
    return coordinator !== null && coordinator.regions.size > 0 && coordinator.shardHome.size > 0;
  }, { timeoutMs: 4_000, label: 'the coordinator is live and the local region registered' });
  const harness = { system, cluster, systemName, coordinator: reach()! };
  started.push(harness);
  // The warm-up placed one shard; the cases ask about another.
  expect(harness.coordinator.shardHome.has(SHARD)).toBe(false);
  return harness;
}

/** A peer at `host`, sorting after the local node so the leader never moves. */
function peer(harness: Harness, host: string, incarnation?: string): NodeAddress {
  return new NodeAddress(harness.systemName, host, 2_551, incarnation);
}

function stageUp(harness: Harness, address: NodeAddress): void {
  const members = (harness.cluster as unknown as ClusterInternals).members;
  members.set(address.toString(), new Member(address, 'up', 1, []));
}

const regionPathOn = (host: string): string => `/system/cluster-sharding/region-${host}`;
const keyOf = (address: NodeAddress, host: string): string => `${address}|${regionPathOn(host)}`;

function register(harness: Harness, address: NodeAddress, host: string, hostedShards: number[], numShards = NUM_SHARDS): void {
  harness.coordinator.onRegister({
    kind: 'sharding.Register',
    region: regionPathOn(host),
    node: address.toJSON(),
    proxy: false,
    hostedShards,
    numShards,
  });
}

/** The local region asks where `SHARD` lives — the first request a new leader answers. */
function askLocally(harness: Harness): void {
  const local = Array.from(harness.coordinator.regions.values())
    .find((info) => info.node.equals(harness.cluster.selfAddress))!;
  harness.coordinator.onGetShardHome({
    kind: 'sharding.GetShardHome',
    shardId: SHARD,
    requester: local.path,
    requesterNode: harness.cluster.selfAddress.toJSON(),
  });
}

describe('a new leader places no shard before the other regions have claimed theirs (#1272)', () => {
  test('a shard a survivor still runs is not placed on the new leader; the survivor\'s claim homes it', async () => {
    const harness = await startHarness('barrier-claim');
    const survivor = peer(harness, 'survivor');
    stageUp(harness, survivor);

    // The term starts: a node at the lowest address has just become leader.
    harness.coordinator.onLeaderChanged();
    expect(harness.coordinator.registrationBarrier?.awaiting).toEqual(new Set([survivor.toString()]));

    // Its own region asks first — the survivor has not seen the change yet.
    askLocally(harness);
    expect(harness.coordinator.shardHome.has(SHARD)).toBe(false);
    expect(harness.coordinator.pending.has(SHARD)).toBe(true);

    // The survivor's region re-registers on the LeaderChanged it observes.
    register(harness, survivor, 'survivor', [SHARD]);

    expect(harness.coordinator.registrationBarrier).toBeNull();
    expect(harness.coordinator.shardHome.get(SHARD)).toBe(keyOf(survivor, 'survivor'));
    // The held request was answered with the survivor's home, not placed anew.
    expect(harness.coordinator.pending.has(SHARD)).toBe(false);
  });

  test('a shard nobody claims is placed once every member has registered', async () => {
    const harness = await startHarness('barrier-unclaimed');
    const other = peer(harness, 'other');
    stageUp(harness, other);
    harness.coordinator.onLeaderChanged();
    askLocally(harness);
    expect(harness.coordinator.shardHome.has(SHARD)).toBe(false);

    register(harness, other, 'other', []);

    expect(harness.coordinator.shardHome.has(SHARD)).toBe(true);
    expect(harness.coordinator.pending.has(SHARD)).toBe(false);
  });

  test('a held request whose shard gained a home meanwhile is answered with that home, not placed again', async () => {
    // The coordinator-state load is asynchronous and can land inside the
    // window: the shard then has a home, from the snapshot, while the request
    // that asked for it is still held.
    const harness = await startHarness('barrier-snapshot-home');
    const other = peer(harness, 'other');
    stageUp(harness, other);
    harness.coordinator.onLeaderChanged();
    askLocally(harness);

    const snapshotted = peer(harness, 'snapshotted');
    const snapshottedKey = keyOf(snapshotted, 'snapshotted');
    harness.coordinator.regions.set(snapshottedKey, {
      node: snapshotted,
      path: regionPathOn('snapshotted'),
      proxy: false,
      shards: new Set([SHARD]),
      lastSeenAtMs: Date.now(),
      lastHeartbeatAtMs: null,
      seededFromSnapshot: true,
    });
    harness.coordinator.shardHome.set(SHARD, snapshottedKey);

    register(harness, other, 'other', []);

    expect(harness.coordinator.shardHome.get(SHARD)).toBe(snapshottedKey);
    expect(harness.coordinator.pending.has(SHARD)).toBe(false);
  });

  test('a member that never registers holds placement only for the registration window', async () => {
    const harness = await startHarness('barrier-window');
    stageUp(harness, peer(harness, 'silent'));
    harness.coordinator.onLeaderChanged();
    askLocally(harness);
    expect(harness.coordinator.shardHome.has(SHARD)).toBe(false);

    // Three gossip rounds plus one register retry: 590 ms with this harness.
    await awaitCondition(() => harness.coordinator.shardHome.has(SHARD), {
      timeoutMs: 3_000, label: 'the shard was placed once the window ran out',
    });
    expect(harness.coordinator.registrationBarrier).toBeNull();
  });

  test('a registration refused over its shard count is an answer too', async () => {
    const harness = await startHarness('barrier-refused');
    const misconfigured = peer(harness, 'misconfigured');
    stageUp(harness, misconfigured);
    harness.coordinator.onLeaderChanged();

    register(harness, misconfigured, 'misconfigured', [], NUM_SHARDS * 2);

    expect(harness.coordinator.registrationBarrier).toBeNull();
  });

  test('a member that leaves the cluster is not waited for', async () => {
    const harness = await startHarness('barrier-left');
    const leaving = peer(harness, 'leaving');
    stageUp(harness, leaving);
    harness.coordinator.onLeaderChanged();
    expect(harness.coordinator.registrationBarrier).not.toBeNull();

    (harness.coordinator as unknown as { onMemberRemoved(address: NodeAddress): void }).onMemberRemoved(leaving);

    expect(harness.coordinator.registrationBarrier).toBeNull();
  });

  test('with no other member up there is nothing to wait for', async () => {
    const harness = await startHarness('barrier-alone');
    harness.coordinator.onLeaderChanged();

    expect(harness.coordinator.registrationBarrier).toBeNull();
  });
});

describe('a snapshot\'s homes for a previous run of a node are released when the new run registers (#1272)', () => {
  function seed(harness: Harness, address: NodeAddress, host: string, shards: number[]): void {
    const key = keyOf(address, host);
    harness.coordinator.regions.set(key, {
      node: address,
      path: regionPathOn(host),
      proxy: false,
      shards: new Set(shards),
      lastSeenAtMs: Date.now(),
      lastHeartbeatAtMs: null,
      seededFromSnapshot: true,
    });
    for (const shardId of shards) harness.coordinator.shardHome.set(shardId, key);
  }

  test('a restarted node keeps only what it claims', async () => {
    const harness = await startHarness('seeded-restart');
    seed(harness, peer(harness, 'restarted', 'run-1'), 'restarted', [SHARD]);

    register(harness, peer(harness, 'restarted', 'run-2'), 'restarted', []);

    expect(harness.coordinator.shardHome.has(SHARD)).toBe(false);
  });

  test('the same run re-registering keeps the snapshot\'s homes', async () => {
    // It may hold a home its claim does not show yet: a ShardHome the previous
    // leader sent and the region had not acted on.
    const harness = await startHarness('seeded-same-run');
    seed(harness, peer(harness, 'steady', 'run-1'), 'steady', [SHARD]);

    register(harness, peer(harness, 'steady', 'run-1'), 'steady', []);

    expect(harness.coordinator.shardHome.get(SHARD)).toBe(keyOf(peer(harness, 'steady'), 'steady'));
  });
});
