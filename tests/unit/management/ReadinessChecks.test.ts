/**
 * `shardRegionRegistered` — one readiness check per sharded type, passing
 * once this node's region for the type is registered with the coordinator
 * (#1465, #1541).
 *
 * Each case drives a real region into one of the states the check has to
 * report and reads the check at that moment.  Reading `isRegistered` alone
 * would prove the status and nothing else, and the status is the smaller half:
 * the detail is the only thing on `/ready` that says *why* a node is out of
 * rotation, and the three ways of not being registered want three different
 * things done about them — start the region, make the shard counts agree, or
 * wait for an answer that is on its way.
 *
 * The check is never taken out to say "not ready".  An empty readiness set
 * reads as healthy, so every case that turns it red also asserts that it is
 * still in the registry, failing under its own name.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { ClusterSharding } from '../../../src/cluster/sharding/ClusterSharding.js';
import {
  AuthenticatedShardingMessage,
  type ShardingMessage,
} from '../../../src/cluster/sharding/ShardingProtocol.js';
import { StartShardingOptions } from '../../../src/cluster/sharding/StartShardingOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  healthChecksOf,
  shardRegionCheckName,
  shardRegionRegistered,
} from '../../../src/management/index.js';
import type { HealthCheckResult } from '../../../src/management/index.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { coordinatorSegments, regionSegments } from '../../util/SystemPaths.js';

type WorkCommand = { readonly id: string; readonly kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'orders';
const NUM_SHARDS = 8;

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { /* the entity's existence is all a case needs */ }
}

/**
 * A transport that can stop sending this node's region registrations and
 * liveness beats while everything else keeps flowing — the shape that lets a
 * coordinator evict a region whose node is plainly alive, and then holds the
 * region unregistered for as long as a case needs to read it.
 *
 * Dropped on the sending side, so the receiving side is in exactly the state a
 * lost frame leaves it in, with no test-only branch anywhere in `src/`.
 */
class FaultInjectingTransport extends InMemoryTransport {
  dropRegisters = false;
  dropBeats = false;

  override send(to: NodeAddress, message: WireMessage): void {
    const kind = FaultInjectingTransport.shardingKind(message);
    if (kind === 'sharding.Register' && this.dropRegisters) return;
    if (kind === 'sharding.RegionHeartbeat' && this.dropBeats) return;
    super.send(to, message);
  }

  /** The `kind` of the sharding frame an envelope carries, or `undefined`. */
  private static shardingKind(message: WireMessage): unknown {
    if (message.kind !== 'envelope') return undefined;
    const body = message.body as { kind?: unknown } | null;
    return typeof body === 'object' && body !== null ? body.kind : undefined;
  }
}

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly transport: FaultInjectingTransport;
};

/** What a case may change about a node; unset means a lone, self-electing node. */
type NodeFixture = {
  readonly seeds?: readonly string[];
  readonly selfElection?: 'never';
};

const running: Node[] = [];

afterEach(async () => {
  for (const node of running.splice(0)) {
    await node.cluster.leave().catch(() => { /* best-effort */ });
    await node.system.terminate().catch(() => { /* best-effort */ });
  }
});

async function joinNode(systemName: string, port: number, fixture: NodeFixture = {}): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const transport = new FaultInjectingTransport(new NodeAddress(systemName, 'h', port));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([...(fixture.seeds ?? [])])
    .withTransport(transport)
    .withGossipIntervalMs(30);
  if (fixture.selfElection) clusterOptions.withSelfElection(fixture.selfElection);
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster, transport };
  running.push(node);
  return node;
}

/** The region-side settings every case shares; the eviction case adds detection. */
function shardingOptionsFor(staleRegionDetection: boolean): StartShardingOptions<Command> {
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    // A passivation sweep firing mid-case would move state for its own reasons.
    .withPassivationIdleMs(0);
  if (!staleRegionDetection) return shardingOptions;
  return shardingOptions
    // Compressed hard: the case watches a threshold expire.  The ordering is
    // the shipped one — the beat well inside the window, the window several
    // beats wide — not the magnitudes.
    .withStaleRegionDetection(true)
    .withRegionHeartbeatIntervalMs(100)
    .withRegionStaleAfterMs(500)
    .withRebalanceIntervalMs(100)
    // So the region re-registers promptly once its frames flow again.
    .withRegisterRetryIntervalMs(50);
}

/** The check under test, read synchronously — it is a set read, not a query. */
function readCheck(check: () => HealthCheckResult): HealthCheckResult {
  return check();
}

/** The named entry in the registry's readiness aggregate, if it is still there. */
async function registeredResult(node: Node, name: string): Promise<HealthCheckResult | undefined> {
  const results = await healthChecksOf(node.system).checkReadiness();
  return results.find((result) => result.name === name);
}

/** Hand the region a directive the way its own coordinator's local leg would. */
function tellAsCoordinator(node: Node, message: ShardingMessage): void {
  const resolved = node.system._resolvePath(regionSegments(node.system.name, TYPE_NAME));
  if (resolved.isNone()) throw new Error('region actor not found');
  (resolved.value as unknown as { tell(message: unknown): void })
    .tell(new AuthenticatedShardingMessage(node.cluster.selfAddress, message));
}

/** What the coordinator records about one region — only the fields read here. */
type RegionInfoView = {
  readonly node: NodeAddress;
  readonly lastHeartbeatAtMs: number | null;
};

/** The coordinator's entry for the region on `address`, read off the actor instance. */
function coordinatorEntryFor(leader: Node, address: NodeAddress): RegionInfoView | undefined {
  const resolved = leader.system._resolvePath(coordinatorSegments(leader.system.name, TYPE_NAME));
  if (resolved.isNone()) return undefined;
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  const state = cell?.actor as { regions?: Map<string, RegionInfoView> } | undefined;
  if (state?.regions === undefined) return undefined;
  return Array.from(state.regions.values()).find((info) => info.node.equals(address));
}

describe('shardRegionRegistered — what it is called', () => {
  test('one check per type, named after the type', () => {
    expect(shardRegionCheckName('orders')).toBe('shard-region:orders');
    expect(shardRegionCheckName('billing')).not.toBe(shardRegionCheckName('orders'));
  });

  test('the sharding facade is resolved when the check is built, not on a probe', async () => {
    // The first `cluster.sharding` builds the facade, which subscribes to the
    // cluster's events: work for the moment a check is registered, never for a
    // load balancer's poll.  Read through the memo `ClusterSharding.get` keeps,
    // since asking `cluster.sharding` would build the facade itself.
    const node = await joinNode('readiness-check-facade', 47_908);
    const facades = (ClusterSharding as unknown as { instances: WeakMap<ActorSystem, unknown> }).instances;
    expect(facades.has(node.system)).toBe(false);

    shardRegionRegistered(node.cluster, TYPE_NAME);

    expect(facades.has(node.system)).toBe(true);
  }, 20_000);

  test('a type name nothing could ever start is refused when the check is built', async () => {
    // `ClusterSharding.start` refuses an empty type name, so a check for one
    // could never pass: refused here, where the mistake is, rather than as a
    // node that stays out of rotation for good.
    const node = await joinNode('readiness-check-empty-type', 47_900);
    expect(() => shardRegionRegistered(node.cluster, '')).toThrow(/typeName/);
  }, 20_000);
});

describe('shardRegionRegistered — the three ways of not being registered', () => {
  test('a type this node never started fails, saying no region is running', async () => {
    const node = await joinNode('readiness-check-never-started', 47_901);
    const check = shardRegionRegistered(node.cluster, TYPE_NAME);
    healthChecksOf(node.system).addReadiness(check);

    const result = readCheck(check);
    expect(result.name).toBe(shardRegionCheckName(TYPE_NAME));
    expect(result.status).toBe(false);
    expect(result.detail).toContain(`no shard region for '${TYPE_NAME}' is running on this node`);
    expect(node.cluster.sharding.isRegistered(TYPE_NAME)).toBe(false);
    expect((await registeredResult(node, shardRegionCheckName(TYPE_NAME)))?.status).toBe(false);
  }, 20_000);

  test('a region that has started and not been acknowledged yet says so', async () => {
    // A node that never becomes `up` has no leader and so no coordinator to
    // register with: the region runs and stays unacknowledged for as long as
    // the case reads it.  `selfElection: never` plus a seed that never answers
    // is what keeps it there.
    const node = await joinNode('readiness-check-pending', 47_902, {
      seeds: ['readiness-check-pending@h:48902'],
      selfElection: 'never',
    });
    const shardingOptions = shardingOptionsFor(false);
    node.cluster.sharding.start<Command>(shardingOptions);
    const check = shardRegionRegistered(node.cluster, TYPE_NAME);

    const result = readCheck(check);
    expect(result.status).toBe(false);
    expect(result.detail).toContain(`the shard region for '${TYPE_NAME}' is running`);
    expect(result.detail).toContain('not registered with the coordinator yet');
    expect(result.detail).not.toContain('is running on this node: it was never started');
  }, 20_000);
});

describe('shardRegionRegistered — following the registration', () => {
  test('flips to passing once the coordinator acknowledges the region, not before', async () => {
    const node = await joinNode('readiness-check-flips', 47_903);
    const check = shardRegionRegistered(node.cluster, TYPE_NAME);
    healthChecksOf(node.system).addReadiness(check);
    const shardingOptions = shardingOptionsFor(false);
    node.cluster.sharding.start<Command>(shardingOptions);

    // The statement right after `start()` returns, before any round trip to
    // the coordinator could have happened: a check that reported ready here
    // would be reporting something other than the acknowledgment.
    const before = readCheck(check);
    expect(before.status).toBe(false);
    expect(before.detail).toContain('not registered with the coordinator yet');

    await awaitCondition(() => readCheck(check).status, {
      timeoutMs: 4_000,
      label: 'the check passed once the coordinator acknowledged the region',
    });
    expect(node.cluster.sharding.isRegistered(TYPE_NAME)).toBe(true);
    expect(readCheck(check)).toEqual({ name: shardRegionCheckName(TYPE_NAME), status: true });
    expect(await registeredResult(node, shardRegionCheckName(TYPE_NAME)))
      .toEqual({ name: shardRegionCheckName(TYPE_NAME), status: true });
  }, 20_000);

  test('a refusal turns it red with both shard counts, and it stays registered', async () => {
    const node = await joinNode('readiness-check-refused', 47_904);
    const check = shardRegionRegistered(node.cluster, TYPE_NAME);
    healthChecksOf(node.system).addReadiness(check);
    const shardingOptions = shardingOptionsFor(false);
    node.cluster.sharding.start<Command>(shardingOptions);
    // Registered first, so the refusal below takes a registration away rather
    // than meeting a region that never had one — and so the coordinator's node,
    // the one origin the region accepts a directive from, is known to it.
    await awaitCondition(() => readCheck(check).status, {
      timeoutMs: 4_000,
      label: 'the region registered before the refusal',
    });

    // The frame a coordinator on a differently-configured node sends the
    // moment leadership reaches it.
    tellAsCoordinator(node, {
      kind: 'sharding.RegisterRefused',
      coordinator: `/system/cluster/sharding/coordinator-${TYPE_NAME}`,
      numShards: NUM_SHARDS + 8,
      regionNumShards: NUM_SHARDS,
    });

    await awaitCondition(() => !readCheck(check).status, {
      timeoutMs: 4_000,
      label: 'the check went red on the refusal',
    });
    const result = readCheck(check);
    expect(result.detail).toContain(`refused this node's region for '${TYPE_NAME}'`);
    // Both counts, because "refused" on its own sends an operator to the log.
    expect(result.detail).toContain(`configured with ${NUM_SHARDS} shards`);
    expect(result.detail).toContain(`governs the type with ${NUM_SHARDS + 8}`);
    expect(result.detail).toContain('actor-ts.sharding.number-of-shards');
    expect(node.cluster.sharding.isRegistered(TYPE_NAME)).toBe(false);
    // Still in the aggregate, failing under its own name: taking it out would
    // make "refused" and "nothing gates readiness" the same answer.
    expect(await registeredResult(node, shardRegionCheckName(TYPE_NAME))).toEqual(result);
  }, 20_000);

  test('an eviction turns it red until the region is registered again', async () => {
    // Two nodes, so the region under test registers over the wire and its
    // frames can be dropped: the seed sorts first, so it leads and runs the
    // active coordinator; the other node's region is the one evicted.
    const seed = await joinNode('readiness-check-evicted', 47_905);
    const other = await joinNode('readiness-check-evicted', 47_906, {
      seeds: ['readiness-check-evicted@h:47905'],
    });
    await awaitCondition(() => [seed, other].every((node) => node.cluster.upMembers().length === 2), {
      timeoutMs: 4_000,
      label: 'the two-node cluster converged',
    });
    const seedShardingOptions = shardingOptionsFor(true);
    seed.cluster.sharding.start<Command>(seedShardingOptions);
    const otherShardingOptions = shardingOptionsFor(true);
    other.cluster.sharding.start<Command>(otherShardingOptions);
    const check = shardRegionRegistered(other.cluster, TYPE_NAME);
    healthChecksOf(other.system).addReadiness(check);

    await awaitCondition(() => readCheck(check).status, {
      timeoutMs: 4_000,
      label: 'the region on the non-leader registered',
    });
    // With no beat recorded the region is not a sweep candidate at all, so
    // muting it before one lands would prove nothing about the eviction.
    await awaitCondition(
      () => coordinatorEntryFor(seed, other.cluster.selfAddress)?.lastHeartbeatAtMs != null,
      { timeoutMs: 4_000, label: "the region's beat reached the coordinator" },
    );

    other.transport.dropBeats = true;
    other.transport.dropRegisters = true;
    await awaitCondition(() => coordinatorEntryFor(seed, other.cluster.selfAddress) === undefined, {
      timeoutMs: 4_000,
      label: 'the coordinator evicted the mute region',
    });
    await awaitCondition(() => !readCheck(check).status, {
      timeoutMs: 4_000,
      label: 'the check went red on the evicted node',
    });
    const evicted = readCheck(check);
    // The region is still running and trying to register again, which is the
    // case that resolves on its own — not "never started" and not "refused".
    expect(evicted.detail).toContain(`the shard region for '${TYPE_NAME}' is running`);
    expect(evicted.detail).toContain('not registered with the coordinator yet');
    expect(evicted.detail).not.toContain('refused');
    expect(other.cluster.sharding.isRegistered(TYPE_NAME)).toBe(false);
    expect(await registeredResult(other, shardRegionCheckName(TYPE_NAME))).toEqual(evicted);

    other.transport.dropRegisters = false;
    await awaitCondition(() => readCheck(check).status, {
      timeoutMs: 4_000,
      label: 'the check passed again once the new registration was acknowledged',
    });
    expect(coordinatorEntryFor(seed, other.cluster.selfAddress)).toBeDefined();
  }, 30_000);

  test('a region that stops fails the check again, saying no region is running', async () => {
    const node = await joinNode('readiness-check-stopped', 47_907);
    const check = shardRegionRegistered(node.cluster, TYPE_NAME);
    healthChecksOf(node.system).addReadiness(check);
    const shardingOptions = shardingOptionsFor(false);
    const region = node.cluster.sharding.start<Command>(shardingOptions);
    await awaitCondition(() => readCheck(check).status, {
      timeoutMs: 4_000,
      label: 'the region registered before it was stopped',
    });

    node.system.stop(region);
    await awaitCondition(
      () => node.system._resolvePath(regionSegments(node.system.name, TYPE_NAME)).isNone(),
      { timeoutMs: 4_000, label: 'the region actor is gone' },
    );
    const result = readCheck(check);
    expect(result.status).toBe(false);
    expect(result.detail).toContain(`no shard region for '${TYPE_NAME}' is running on this node`);
    expect(await registeredResult(node, shardRegionCheckName(TYPE_NAME))).toEqual(result);
  }, 20_000);

  test('a refused region that then stops says no region is running, not that it was refused', async () => {
    // The refusal stays on record after the region is gone — it is cleared only
    // by an accepted registration — but it is not what an operator has to act
    // on any more: nothing is running to be refused.
    const node = await joinNode('readiness-check-refused-then-stopped', 47_909);
    const check = shardRegionRegistered(node.cluster, TYPE_NAME);
    const shardingOptions = shardingOptionsFor(false);
    const region = node.cluster.sharding.start<Command>(shardingOptions);
    await awaitCondition(() => readCheck(check).status, {
      timeoutMs: 4_000,
      label: 'the region registered before the refusal',
    });
    tellAsCoordinator(node, {
      kind: 'sharding.RegisterRefused',
      coordinator: `/system/cluster/sharding/coordinator-${TYPE_NAME}`,
      numShards: NUM_SHARDS + 8,
      regionNumShards: NUM_SHARDS,
    });
    await awaitCondition(() => readCheck(check).detail?.includes('refused') === true, {
      timeoutMs: 4_000,
      label: 'the check reported the refusal',
    });

    node.system.stop(region);
    await awaitCondition(
      () => node.system._resolvePath(regionSegments(node.system.name, TYPE_NAME)).isNone(),
      { timeoutMs: 4_000, label: 'the region actor is gone' },
    );
    expect(node.cluster.sharding.registrationRefusal(TYPE_NAME)).not.toBeNull();
    const result = readCheck(check);
    expect(result.status).toBe(false);
    expect(result.detail).toContain(`no shard region for '${TYPE_NAME}' is running on this node`);
    expect(result.detail).not.toContain('refused');
  }, 20_000);
});
