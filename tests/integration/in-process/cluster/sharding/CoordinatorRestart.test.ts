/**
 * A shard coordinator that restarts without a leader change (#853, #849).
 *
 * The coordinator is a child of the `cluster/sharding` group, whose supervisor
 * restarts it when one of its handlers throws.  A user `AllocationStrategy`
 * throwing out of `allocate` is enough, and that is the public route every
 * case here takes.  A restart is not a leader change: the leader stays where
 * it was, and so does every region's idea of where its coordinator lives, so
 * nothing on the region side re-enters the register loop.  The replacement
 * instance starts with an empty registry — or, with a coordinator-state store,
 * with one re-seeded from the last snapshot — and before the coordinator asked
 * its regions to register again it stayed that way:
 *
 * - **with a store**, every region came back *seeded* and never registered
 *   again, so a live region on a node that does not beat was evicted one
 *   `stale-after` later, its shards released and its entities stopped;
 * - **without one**, the type was headless: no region known, so no shard could
 *   be placed, and nothing that needed the coordinator was ever delivered.
 *
 * Every case therefore asks the question twice: whether the regions are
 * *registered* again (the coordinator's own registry, read off the actor), and
 * whether that buys what registration is for (an entity that stays up, a
 * message that arrives).
 */
import { match } from 'ts-pattern';
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { HashAllocationStrategy, type AllocationStrategy } from '../../../../../src/cluster/sharding/AllocationStrategy.js';
import type { CoordinatorStateData, CoordinatorStateStore } from '../../../../../src/cluster/sharding/CoordinatorState.js';
import { entityName } from '../../../../../src/cluster/sharding/Shard.js';
import { hashShardId } from '../../../../../src/cluster/sharding/ShardAllocator.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { coordinatorSegments, regionSegments } from '../../../../util/SystemPaths.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

type WorkCommand = { readonly id: string; readonly kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';
const NUM_SHARDS = 16;
const HEARTBEAT_INTERVAL_MS = 100;
const STALE_AFTER_MS = 500;
const REBALANCE_INTERVAL_MS = 100;

/**
 * The bound this suite holds a restarted coordinator to: every live region is
 * registered with it again, and a message that needs it is delivered, within
 * this long of the restart.  In practice it is one round trip — the
 * replacement asks each region its predecessor knew as soon as it runs — and
 * the rest is headroom for a loaded runner.
 */
const AFTER_RESTART_WITHIN_MS = 2_000;

/** How long a case watches for an eviction that must not come: four `STALE_AFTER_MS` windows. */
const EVICTION_WATCH_MS = 2_000;

/** Entity ids that received a `work` message, in arrival order, on any node. */
const delivered: string[] = [];

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, (m) => this.onWork(m))
      .exhaustive();
  }

  private onWork(message: WorkCommand): void { delivered.push(message.id); }
}

/** Records every eviction notice a coordinator sends, so a case can say none went out. */
class RecordingTransport extends InMemoryTransport {
  readonly evictionNoticesTo: string[] = [];

  override send(to: NodeAddress, message: WireMessage): void {
    if (RecordingTransport.shardingKind(message) === 'sharding.RegionEvicted') {
      this.evictionNoticesTo.push(to.toString());
    }
    super.send(to, message);
  }

  private static shardingKind(message: WireMessage): unknown {
    if (message.kind !== 'envelope') return undefined;
    const body = message.body as { kind?: unknown } | null;
    return typeof body === 'object' && body !== null ? body.kind : undefined;
  }
}

/**
 * Hash placement that throws exactly once when armed — the public way to make
 * the coordinator's own turn fail, and so to have its supervisor restart it.
 */
class ThrowsOnceWhenArmed implements AllocationStrategy {
  armed = false;
  throws = 0;
  private readonly inner = new HashAllocationStrategy();

  allocate(
    shardId: number,
    candidates: ReadonlyArray<NodeAddress>,
    current: ReadonlyMap<string, ReadonlySet<number>>,
  ): NodeAddress {
    if (this.armed) {
      this.armed = false;
      this.throws++;
      throw new Error('allocation strategy failed once, on purpose');
    }
    return this.inner.allocate(shardId, candidates, current);
  }

  rebalance(
    current: ReadonlyMap<string, ReadonlySet<number>>,
    candidates: ReadonlyArray<NodeAddress>,
    inProgress: ReadonlySet<number>,
  ): Set<number> {
    return this.inner.rebalance(current, candidates, inProgress);
  }
}

/** Keeps the latest snapshot, as a durable store would. */
class LatestSnapshotStore implements CoordinatorStateStore {
  latest: CoordinatorStateData | null = null;

  async load(): Promise<CoordinatorStateData | null> { return this.latest; }

  async save(_typeName: string, state: CoordinatorStateData): Promise<void> { this.latest = state; }
}

type JoinedNode = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly transport: RecordingTransport;
};

type Node = JoinedNode & { readonly region: ActorRef<Command> };

type RegionFixture = {
  readonly detect: boolean;
  readonly store: CoordinatorStateStore | null;
  readonly strategy: AllocationStrategy;
};

/** One registry entry, as far as these cases read it. */
type RegionInfoView = {
  readonly node: NodeAddress;
  readonly seededFromSnapshot: boolean;
};

/** The coordinator state these cases read straight off the actor instance. */
type CoordinatorView = {
  readonly regions: Map<string, RegionInfoView>;
  readonly shardHome: Map<number, string>;
};

const running: JoinedNode[] = [];

afterEach(async () => {
  for (const node of running.splice(0)) {
    await node.cluster.leave().catch(() => { /* best-effort */ });
    await node.system.terminate().catch(() => { /* best-effort */ });
  }
  delivered.length = 0;
});

async function joinNode(systemName: string, port: number, seeds: string[]): Promise<JoinedNode> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const transport = new RecordingTransport(new NodeAddress(systemName, 'h', port));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(transport)
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster, transport };
  running.push(node);
  return node;
}

function startRegion(node: JoinedNode, fixture: RegionFixture): Node {
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    .withPassivationIdleMs(0)
    .withRebalanceIntervalMs(REBALANCE_INTERVAL_MS)
    .withStaleRegionDetection(fixture.detect)
    .withRegionHeartbeatIntervalMs(HEARTBEAT_INTERVAL_MS)
    .withRegionStaleAfterMs(STALE_AFTER_MS)
    .withAllocationStrategy(fixture.strategy);
  if (fixture.store) shardingOptions.withCoordinatorStateStore(fixture.store);
  const region = node.cluster.sharding.start<Command>(shardingOptions);
  return { ...node, region };
}

/** The live coordinator instance on `node`, or `undefined` while there is none. */
function coordinatorOn(node: JoinedNode): CoordinatorView | undefined {
  const resolved = node.system._resolvePath(coordinatorSegments(node.system.name, TYPE_NAME));
  if (resolved.isNone()) return undefined;
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  return cell?.actor as CoordinatorView | undefined;
}

function entryFor(coordinator: CoordinatorView | undefined, address: NodeAddress): RegionInfoView | undefined {
  if (!coordinator) return undefined;
  return Array.from(coordinator.regions.values()).find((info) => info.node.equals(address));
}

/** Whether `coordinator` holds a registration — not a seeded entry — for each address. */
function registersEvery(coordinator: CoordinatorView | undefined, addresses: ReadonlyArray<NodeAddress>): boolean {
  return addresses.every((address) => {
    const entry = entryFor(coordinator, address);
    return entry !== undefined && !entry.seededFromSnapshot;
  });
}

function hostsEntity(node: JoinedNode, shardId: number, entityId: string): boolean {
  return node.system._resolvePath([
    ...regionSegments(node.system.name, TYPE_NAME), `shard-${shardId}`, entityName(entityId),
  ]).isSome();
}

/** An id whose shard satisfies `wanted`, drawn from a fixed, deterministic list. */
function entityIdWhere(prefix: string, wanted: (shardId: number) => boolean): string {
  const id = Array.from({ length: 256 }, (_, i) => `${prefix}-${i}`)
    .find((candidate) => wanted(hashShardId(candidate, NUM_SHARDS)));
  if (id === undefined) throw new Error(`no '${prefix}' id hashes to a wanted shard`);
  return id;
}

/**
 * Make the coordinator on `seed` restart: arm the strategy, then send a
 * message for a shard nobody owns yet, so the coordinator has to call
 * `allocate`.  Resolves once a *different* instance is running.
 */
async function restartCoordinator(seed: Node, strategy: ThrowsOnceWhenArmed): Promise<string> {
  const before = coordinatorOn(seed);
  expect(before).toBeDefined();
  const homed = new Set(before!.shardHome.keys());
  const freshId = entityIdWhere('fresh', (shardId) => !homed.has(shardId));
  strategy.armed = true;
  seed.region.tell({ id: freshId, kind: 'work' });
  await awaitCondition(() => {
    const now = coordinatorOn(seed);
    return now !== undefined && now !== before;
  }, { timeoutMs: 4_000, label: 'the coordinator was restarted (a fresh instance runs)' });
  expect(strategy.throws).toBe(1);
  return freshId;
}

/**
 * Two nodes: the seed is the leader (lowest address), so it runs the active
 * coordinator, and it sweeps.  `otherDetects` decides whether the second node's
 * region beats.  One entity lives on the second node, in an odd shard —
 * `HashAllocationStrategy` places shard n on `sorted[n % 2]` — and its first
 * message is sent from the node that owns it, so the seed's region has never
 * cached that shard's home and has to ask the coordinator for it.
 */
async function twoNodes(
  systemName: string, base: number, otherDetects: boolean, store: CoordinatorStateStore | null,
): Promise<{ seed: Node; other: Node; strategy: ThrowsOnceWhenArmed; entityId: string; shardId: number }> {
  const strategy = new ThrowsOnceWhenArmed();
  const seedJoined = await joinNode(systemName, base, []);
  const otherJoined = await joinNode(systemName, base + 1, [`${systemName}@h:${base}`]);
  await awaitCondition(
    () => seedJoined.cluster.upMembers().length === 2 && otherJoined.cluster.upMembers().length === 2,
    { timeoutMs: 4_000, label: 'the two-node cluster converged' },
  );
  const seed = startRegion(seedJoined, { detect: true, store, strategy });
  const other = startRegion(otherJoined, { detect: otherDetects, store, strategy });
  await awaitCondition(
    () => seed.cluster.sharding.isRegistered(TYPE_NAME) && other.cluster.sharding.isRegistered(TYPE_NAME),
    { timeoutMs: 4_000, label: 'both regions registered' },
  );
  const entityId = entityIdWhere('resident', (shardId) => shardId % 2 === 1);
  const shardId = hashShardId(entityId, NUM_SHARDS);
  other.region.tell({ id: entityId, kind: 'work' });
  await awaitCondition(() => hostsEntity(other, shardId, entityId), {
    timeoutMs: 4_000,
    label: 'the entity came up on the node that owns its shard',
  });
  return { seed, other, strategy, entityId, shardId };
}

describe('a coordinator restarted from a coordinator-state snapshot (#853)', () => {
  for (const otherDetects of [false, true]) {
    const label = otherDetects ? 'on' : 'off';
    test(`evicts no live region, with stale-region detection ${label} on the region's node`, async () => {
      const store = new LatestSnapshotStore();
      const base = otherDetects ? 62_110 : 62_100;
      const { seed, other, strategy, entityId, shardId } = await twoNodes(
        `coordinator-restart-seeded-${label}`, base, otherDetects, store,
      );
      const otherAddress = other.cluster.selfAddress;
      await awaitCondition(
        () => (store.latest?.regions ?? []).some((region) => region.node.port === otherAddress.port)
          && (store.latest?.shardHome ?? []).some(([homed]) => homed === shardId),
        { timeoutMs: 4_000, label: 'a snapshot naming the second region and its shard was saved' },
      );

      await restartCoordinator(seed, strategy);
      const restartedAt = Date.now();

      // Four windows: the eviction this case exists for came one window after
      // the restart, and nothing should come at all.  The same poll notes when
      // both regions are *registered* again — not merely re-seeded: a seeded
      // entry is a sweep candidate whatever its beat record, a registration is
      // not.
      const registration: { againAt: number | null } = { againAt: null };
      await awaitCondition(() => {
        if (registration.againAt === null
          && registersEvery(coordinatorOn(seed), [seed.cluster.selfAddress, otherAddress])) {
          registration.againAt = Date.now();
        }
        return seed.transport.evictionNoticesTo.length > 0 || !hostsEntity(other, shardId, entityId);
      }, { timeoutMs: EVICTION_WATCH_MS, intervalMs: 20, label: 'an eviction after the restart (not expected)' }).then(
        () => { throw new Error(`a live region was evicted: notices to ${seed.transport.evictionNoticesTo.join(', ')}`); },
        () => { /* the window ran out with nobody evicted */ },
      );
      expect(seed.transport.evictionNoticesTo).toEqual([]);
      expect(hostsEntity(other, shardId, entityId)).toBe(true);
      expect(registration.againAt).not.toBeNull();
      expect((registration.againAt ?? Number.POSITIVE_INFINITY) - restartedAt).toBeLessThan(AFTER_RESTART_WITHIN_MS);
    }, 15_000);
  }
});

describe('a coordinator restarted with no coordinator-state store (#849)', () => {
  test('knows every live region again, and routes a message for an existing entity', async () => {
    const { seed, other, strategy, entityId, shardId } = await twoNodes(
      'coordinator-restart-headless', 62_120, false, null,
    );

    await restartCoordinator(seed, strategy);
    const restartedAt = Date.now();

    await awaitCondition(
      () => registersEvery(coordinatorOn(seed), [seed.cluster.selfAddress, other.cluster.selfAddress]),
      { timeoutMs: AFTER_RESTART_WITHIN_MS, label: 'every live region registered with the restarted coordinator' },
    );

    // The seed's region has never routed to this shard, so it has to ask the
    // coordinator — which knows the answer only from the owner's registration.
    delivered.length = 0;
    seed.region.tell({ id: entityId, kind: 'work' });
    await awaitCondition(() => delivered.includes(entityId), {
      timeoutMs: AFTER_RESTART_WITHIN_MS,
      label: 'a message for the existing entity was delivered after the restart',
    });
    expect(Date.now() - restartedAt).toBeLessThan(AFTER_RESTART_WITHIN_MS * 2);
    // Delivered to the entity where it lived, not to a second copy.
    expect(hostsEntity(other, shardId, entityId)).toBe(true);
    expect(hostsEntity(seed, shardId, entityId)).toBe(false);
  }, 15_000);

  test('delivers on a single node: the message that failed, and every one sent after it', async () => {
    const strategy = new ThrowsOnceWhenArmed();
    const node = startRegion(await joinNode('coordinator-restart-single', 62_130, []), {
      detect: false, store: null, strategy,
    });
    await awaitCondition(() => node.cluster.sharding.isRegistered(TYPE_NAME), {
      timeoutMs: 4_000,
      label: 'the region registered',
    });

    // The very first allocation throws: the shard asked for is the one whose
    // message rides through the restart in the region's buffer.
    strategy.armed = true;
    node.region.tell({ id: 'user-1', kind: 'work' });
    await awaitCondition(() => strategy.throws === 1, { timeoutMs: 4_000, label: 'the strategy threw' });
    const restartedAt = Date.now();
    for (const id of ['user-2', 'user-3', 'user-4', 'user-5']) node.region.tell({ id, kind: 'work' });

    await awaitCondition(
      () => ['user-1', 'user-2', 'user-3', 'user-4', 'user-5'].every((id) => delivered.includes(id)),
      {
        timeoutMs: AFTER_RESTART_WITHIN_MS,
        label: 'every message was delivered after the coordinator restart',
      },
    );
    expect(Date.now() - restartedAt).toBeLessThan(AFTER_RESTART_WITHIN_MS * 2);
    expect(registersEvery(coordinatorOn(node), [node.cluster.selfAddress])).toBe(true);
  }, 15_000);
});
