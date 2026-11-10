/**
 * #952 and #1188 — a new leader's coordinator-state load is applied in the
 * coordinator's own turn, only in the term it was started for, and placement
 * waits for it.
 *
 * The load used to seed `regions` and `shardHome` from inside its promise,
 * outside the mailbox: a demotion that cleared both while the read was in
 * flight was undone when the read landed, and a coordinator that no longer led
 * held a stale map.  And placement did not wait for it, so the first shard a
 * new leader was asked about was allocated afresh while the snapshot that
 * homed it was still on its way.
 *
 * Driven through the coordinator's own handlers on a one-node cluster, with a
 * store whose load the test releases by hand.
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
import type { CoordinatorStateData, CoordinatorStateStore } from '../../../../src/cluster/sharding/CoordinatorState.js';
import type { GetShardHome } from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { coordinatorSegments } from '../../../util/SystemPaths.js';

type WorkCommand = { id: string; kind: 'work' };

const TYPE_NAME = 'entity';
const NUM_SHARDS = 12;
const SHARD = 7;

class Entity extends Actor<WorkCommand> {
  override onReceive(): void {}
}

/** A store whose load waits until the test releases it. */
class HeldStore implements CoordinatorStateStore {
  loads = 0;
  private release: ((data: CoordinatorStateData | null) => void) | null = null;

  load(): Promise<CoordinatorStateData | null> {
    this.loads += 1;
    return new Promise((resolve) => { this.release = resolve; });
  }

  async save(): Promise<void> { /* nothing to keep */ }

  answer(data: CoordinatorStateData | null): void { this.release?.(data); }
}

interface CoordinatorInternals {
  readonly regions: Map<string, { readonly node: NodeAddress; readonly path: string }>;
  readonly shardHome: Map<number, string>;
  readonly pending: Map<number, unknown[]>;
  readonly registrationBarrier: { readonly loading: boolean } | null;
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
let nextPort = 48_950;

afterEach(async () => {
  for (const harness of started.splice(0)) {
    await harness.cluster.leave().catch(() => { /* best-effort */ });
    await harness.system.terminate().catch(() => { /* best-effort */ });
  }
});

async function startHarness(systemName: string, store: CoordinatorStateStore, loadTimeoutMs = 600_000): Promise<Harness> {
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
    .withGossipIntervalMs(30)
    .withFailureDetectorAutoDown(false);
  const cluster = await Cluster.join(system, clusterOptions);
  const shardingOptions = StartShardingOptions.create<WorkCommand>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    .withCoordinatorStateStore(store)
    .withCoordinatorStateLoadTimeoutMs(loadTimeoutMs)
    .withRebalanceIntervalMs(600_000)
    .withPassivationIdleMs(0);
  cluster.sharding.start<WorkCommand>(shardingOptions);
  const reach = (): CoordinatorInternals | null => {
    const resolved = system._resolvePath(coordinatorSegments(systemName, TYPE_NAME));
    if (resolved.isNone()) return null;
    const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
    return (cell?.actor as CoordinatorInternals | undefined) ?? null;
  };
  await awaitCondition(() => {
    const coordinator = reach();
    return coordinator !== null && coordinator.regions.size > 0;
  }, { timeoutMs: 4_000, label: 'the coordinator is live and the local region registered' });
  const harness = { system, cluster, systemName, coordinator: reach()! };
  started.push(harness);
  return harness;
}

function askLocally(harness: Harness): void {
  const local = [...harness.coordinator.regions.values()].find((info) => info.node.equals(harness.cluster.selfAddress))!;
  harness.coordinator.onGetShardHome({
    kind: 'sharding.GetShardHome',
    shardId: SHARD,
    requester: local.path,
    requesterNode: harness.cluster.selfAddress.toJSON(),
  });
}

/** A snapshot that homes {@link SHARD} on a region of `peer`. */
function snapshotHoming(peer: NodeAddress): { readonly data: CoordinatorStateData; readonly key: string } {
  const path = '/system/cluster-sharding/region-peer';
  const key = `${peer}|${path}`;
  return {
    key,
    data: {
      leader: peer.toString(),
      takenAt: Date.now(),
      numShards: NUM_SHARDS,
      regions: [{ key, node: peer.toJSON(), path, proxy: false, shards: [SHARD] }],
      shardHome: [[SHARD, key]],
    },
  };
}

describe('placement waits for the coordinator-state load (#1188)', () => {
  test('a shard the snapshot homes is answered with that home, not allocated afresh while the load runs', async () => {
    const store = new HeldStore();
    const harness = await startHarness('state-load-waits', store);
    await awaitCondition(() => store.loads > 0, { label: 'the load started' });
    expect(harness.coordinator.registrationBarrier?.loading).toBe(true);

    askLocally(harness);
    expect(harness.coordinator.shardHome.has(SHARD)).toBe(false);

    // The snapshot names a region on a member that is up.
    const peer = new NodeAddress(harness.systemName, 'peer', 2_551);
    (harness.cluster as unknown as ClusterInternals).members.set(peer.toString(), new Member(peer, 'up', 1));
    const { data, key } = snapshotHoming(peer);
    store.answer(data);

    await awaitCondition(() => harness.coordinator.registrationBarrier === null, { label: 'the barrier lifted' });
    expect(harness.coordinator.shardHome.get(SHARD)).toBe(key);
    expect(harness.coordinator.pending.has(SHARD)).toBe(false);
  });

  test('a load that does not come back in time stops holding placement', async () => {
    const store = new HeldStore();
    const harness = await startHarness('state-load-timeout', store, 150);
    await awaitCondition(() => store.loads > 0, { label: 'the load started' });
    askLocally(harness);

    await awaitCondition(() => harness.coordinator.shardHome.has(SHARD), {
      timeoutMs: 2_000, label: 'the shard was placed once the load timed out',
    });
  });
});

describe('a load is applied only in the leader term it was started for (#952)', () => {
  test('a demotion while the load is in flight is not undone when it lands', async () => {
    const store = new HeldStore();
    const harness = await startHarness('state-load-demoted', store);
    await awaitCondition(() => store.loads > 0, { label: 'the load started' });

    // A member with a lower address comes up: this node stops leading, and
    // its coordinator drops its view.
    const usurper = new NodeAddress(harness.systemName, 'a', 2_551);
    expect(usurper.compareTo(harness.cluster.selfAddress)).toBeLessThan(0);
    const members = (harness.cluster as unknown as ClusterInternals).members;
    members.set(usurper.toString(), new Member(usurper, 'up', 1));
    expect(harness.cluster.isLeader()).toBe(false);
    (harness.coordinator as unknown as { onLeaderChanged(): void }).onLeaderChanged();
    expect(harness.coordinator.regions.size).toBe(0);

    // The load of the term that just ended lands now.
    const peer = new NodeAddress(harness.systemName, 'peer', 2_551);
    members.set(peer.toString(), new Member(peer, 'up', 1));
    store.answer(snapshotHoming(peer).data);
    await new Promise((resolve) => setTimeout(resolve, 50)); // An absence: the late result must change nothing.

    expect(harness.coordinator.regions.size).toBe(0);
    expect(harness.coordinator.shardHome.size).toBe(0);
  });
});
