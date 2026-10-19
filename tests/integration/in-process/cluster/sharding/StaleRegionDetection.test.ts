/**
 * A region that goes silent without its node dying (#853).
 *
 * #648 gave a region a way to say goodbye, and its own docs concede the
 * notification is best-effort: single-shot, unacknowledged, and a transport
 * failure on the way down is logged and swallowed.  Lose it and the cluster is
 * back in the orphaned state #648 fixed — the coordinator keeps naming a dead
 * region as the home of its shards, senders cache that home, and nothing
 * self-heals, because the coordinator's candidates are derived from the
 * registry and checked only for whether their *node* is `up`, never for whether
 * the region itself is alive.  The node is still up, so no `MemberRemoved` will
 * ever fire either: the failure detector answers "is the node alive", never "is
 * that region still there".
 *
 * **The fixture has to produce a *silent* region, not a stopped one.**  Stopping
 * it sends `RegionTerminated`, which is the #648 path — `ShardRegionStop.test.ts`
 * already covers that and would pass here whether or not this mechanism exists.
 * So the beat is dropped at the transport, on the sending side, after the
 * coordinator has already recorded one: the region actor stays up and its node
 * keeps gossiping and heartbeating, which is exactly the shape the coordinator
 * cannot otherwise see.
 *
 * The sweep cases differ in **one** setting — whether the *coordinator's* node
 * has `staleRegionDetection` on.  The silent region has it on in both, so it
 * beats in both and the coordinator records that beat in both; only the sweep
 * changes.  Without that symmetry the `off` case would pass for the wrong reason
 * (a region that never beat is never swept regardless) and would say nothing
 * about the switch.
 *
 * **What that fixture proves and what it does not.**  As shipped it asked only
 * whether the shard arrived at a *new* home, never whether it left the old one —
 * and because the fixture's region is by construction alive and serving, the
 * answer was that it did not: the eviction rewrote the coordinator's map and
 * reached nobody else, so `localShards`, the shard actor and its live entities
 * all stayed put and the shard had two homes indefinitely.  The stands-down and
 * registers-again cases below are that missing half; both fail against the
 * eviction-without-a-notice the mechanism shipped with.
 *
 * The last two cases bind the other published claim — that the switch off
 * "costs nothing at all".  Nothing did: the region's own
 * `if (staleRegionDetection)` could be replaced by `if (true)` and the whole
 * suite stayed green, because every other case reads the coordinator's records,
 * and the one assertion on those fired before the first beat could land.  They
 * count frames at the sending transport instead, over twenty intervals rather
 * than at an instant, and the second is the control that keeps the counter from
 * passing by never being able to see anything.
 *
 * **A silent region on a node that is cut off is a different case**, and the
 * partition case below is its own fixture.  A node that stops answering is
 * marked `unreachable` and stays a member until a split-brain strategy, the
 * failure detector's opt-in auto-down or an operator removes it; until then it
 * may well be running, and its shards with it.  Evicting its region would
 * re-home them onto this side of the partition and give each one a second live
 * home, so the sweep leaves such a region to the membership decision.  The
 * fixture pins a downing provider that never decides, so what it observes is the
 * sweep's own rule and not whatever the default downing configuration is.
 */
import { match } from 'ts-pattern';
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import type { DowningDecision, DowningProvider } from '../../../../../src/cluster/downing/DowningProvider.js';
import type { FailureDetectorOptionsType } from '../../../../../src/cluster/FailureDetectorOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import type { MemberStatus, WireMessage } from '../../../../../src/cluster/Protocol.js';
import type {
  CoordinatorStateData,
  CoordinatorStateStore,
} from '../../../../../src/cluster/sharding/CoordinatorState.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { hashShardId } from '../../../../../src/cluster/sharding/ShardAllocator.js';
import { entityName } from '../../../../../src/cluster/sharding/Shard.js';
import { SystemGroups, shardRegionName, systemActorPath } from '../../../../../src/internal/SystemPaths.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { coordinatorSegments, regionSegments } from '../../../../util/SystemPaths.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

type WorkCommand = { id: string; kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';
const NUM_SHARDS = 16;
/**
 * Compressed hard, because the whole point is to watch a threshold expire.  The
 * ordering that matters is the shipped one — the beat well inside the window,
 * the window several beats wide — not the magnitudes.
 */
const HEARTBEAT_INTERVAL_MS = 100;
const STALE_AFTER_MS = 500;
/** The sweep rides this tick, so it also bounds how late an eviction can be. */
const REBALANCE_INTERVAL_MS = 100;

/**
 * The partition case's window, wider than the others on purpose: the failure
 * detector below has to have marked the cut-off node `unreachable` well before
 * a region on it could be judged silent, or the case would race the very rule
 * it pins.  At {@link PARTITION_FAILURE_DETECTOR}'s 300 ms that is a five-fold
 * margin.
 */
const PARTITION_STALE_AFTER_MS = 1_500;
/** Three windows — how long the cut-off node's shard has to stay where it is. */
const PARTITION_WATCH_MS = 4_500;
/**
 * Compressed like everything else here, so the cut-off node is `unreachable` in
 * a fraction of {@link PARTITION_STALE_AFTER_MS}.  `down-after` is reached too,
 * and is what hands the node to the downing provider — which never decides.
 */
const PARTITION_FAILURE_DETECTOR: Partial<FailureDetectorOptionsType> = {
  heartbeatIntervalMs: 100,
  unreachableAfterMs: 300,
  downAfterMs: 600,
};

/**
 * The registers-again case's membership, with a down-after short enough that
 * the coordinator's settle window — `down-after` with no downing provider —
 * leaves the case's budget almost whole.  The move back onto the re-registered
 * region is a voluntary rebalance, and the coordinator rebalances only once the
 * set of regions on `up` members has held still for that window (#1467): at the
 * shipped 5 s it would take half of a 10 s budget on its own.  Unreachable-after
 * stays a full second, so a stalled event loop does not park a healthy node.
 */
const REJOIN_FAILURE_DETECTOR: Partial<FailureDetectorOptionsType> = {
  heartbeatIntervalMs: 100,
  unreachableAfterMs: 1_000,
  downAfterMs: 1_500,
};

/**
 * The window of the seeded-then-registered case, twice the others: the region's
 * registration has to land well inside it after the seeding, or the case would
 * be measuring an eviction that raced the registration rather than the rule
 * that the registration ends the seeded grace.
 */
const REGISTERING_STALE_AFTER_MS = 1_000;
/** Three of those windows — how long the registered entry has to survive. */
const REGISTERING_WATCH_MS = 3_000;
/**
 * A register retry far below {@link REGISTERING_STALE_AFTER_MS}, so the region
 * whose `Register` frames were being dropped registers promptly once they are
 * not.  The shipped 500 ms would eat half the window.
 */
const FAST_REGISTER_RETRY_MS = 50;

/**
 * The busy-region cases' window, twice the others, against a frame every
 * {@link BUSY_PACE_MS}: a ten-fold margin, so nothing but a frame that stopped
 * counting can let the region's silence reach it.
 */
const BUSY_STALE_AFTER_MS = 1_000;
/** Three of those windows — how long the region stays busy and mute. */
const BUSY_WATCH_MS = 3_000;
/** The gap between two of the region's frames while it is busy. */
const BUSY_PACE_MS = 100;
/**
 * Shards enough that the region never runs out of ones it has not asked about:
 * each asks for a home once, so the asking case needs one per pace step.
 */
const BUSY_NUM_SHARDS = 64;

let delivered = 0;
/**
 * Full paths of every entity actor that has run `postStop`.
 *
 * The one *latching* witness that an evicted region actually gave its shard
 * up.  `hostsShard` is a snapshot and the allocation moves again once the
 * evicted region registers afresh, so a poll can be on either side of that;
 * an entity that has stopped stays stopped, and the path names which node it
 * stopped on.
 */
const stoppedEntities: string[] = [];

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  override postStop(): void { stoppedEntities.push(this.self.path.toString()); }

  private onWork(): void { delivered++; }
}

/** One `RegionEvicted` a coordinator put on the wire, as the sweep stamped it. */
type EvictionNotice = { readonly to: string; readonly silentForMs: number };

/**
 * A transport that can stop delivering some of *this node's* frames while the
 * rest keep flowing: its region's liveness beats, or every frame to a peer it
 * has been cut off from.
 *
 * Dropped on the sending side deliberately: the receiving side is then in
 * precisely the state a lost frame leaves it in, with no test-only branch
 * anywhere in `src/`.
 */
class FaultInjectingTransport extends InMemoryTransport {
  dropBeats = false;
  /**
   * Every beat this node *tried* to send, counted before `dropBeats` gets a
   * say — so it measures whether the region beats at all, not whether a beat
   * arrived.  That is the observable the "off costs nothing" claim needs: the
   * coordinator's records only say what reached it.
   */
  beatsSent = 0;
  /**
   * Drop this node's `sharding.Register` frames, so its region cannot get
   * itself into a coordinator's registry until the flag is cleared.
   */
  dropRegisters = false;
  /**
   * Peers this node sends nothing to — cluster heartbeats and gossip included.
   * Listing each side in the other's set is a full partition between the two.
   */
  readonly cutOffFrom = new Set<string>();
  /**
   * Every eviction notice this node's coordinator *sent*, recorded before any
   * drop.  A latching witness that the sweep evicted a remote region, and the
   * stamp it evicted it on.
   */
  readonly evictionNotices: EvictionNotice[] = [];

  override send(to: NodeAddress, message: WireMessage): void {
    const kind = FaultInjectingTransport.shardingKind(message);
    if (kind === 'sharding.RegionHeartbeat') this.beatsSent++;
    if (kind === 'sharding.RegionEvicted') {
      const body = (message as { body: { silentForMs: number } }).body;
      this.evictionNotices.push({ to: to.toString(), silentForMs: body.silentForMs });
    }
    if (this.cutOffFrom.has(to.toString())) return;
    if (kind === 'sharding.RegionHeartbeat' && this.dropBeats) return;
    if (kind === 'sharding.Register' && this.dropRegisters) return;
    super.send(to, message);
  }

  /** The `kind` of the sharding frame an envelope carries, or `undefined`. */
  private static shardingKind(message: WireMessage): unknown {
    if (message.kind !== 'envelope') return undefined;
    const body = message.body as { kind?: unknown } | null;
    return typeof body === 'object' && body !== null ? body.kind : undefined;
  }
}

/** A node that has joined the cluster, whether or not it runs a region for the type. */
type JoinedNode = {
  system: ActorSystem;
  cluster: Cluster;
  transport: FaultInjectingTransport;
};

type Node = JoinedNode & { region: ActorRef<Command> };

/**
 * A downing provider that never decides — the shape a strategy has while it
 * waits for a stable view, kept up for good.  Configured explicitly so the
 * partition case does not depend on what the default downing configuration
 * does with a silent node.
 */
class NeverDecides implements DowningProvider {
  decide(): DowningDecision { return new Set<string>(); }
}

/** What a case may change about a node's membership; unset means the defaults. */
type ClusterFixture = {
  readonly seeds?: string[];
  readonly downing?: DowningProvider;
  readonly failureDetector?: Partial<FailureDetectorOptionsType>;
};

/** What a case may change about a node's region; `detect` is the one every case sets. */
type RegionFixture = {
  readonly detect: boolean;
  readonly staleAfterMs?: number;
  readonly numShards?: number;
  readonly coordinatorStateStore?: CoordinatorStateStore;
  readonly registerRetryIntervalMs?: number;
};

/**
 * What a case applies to both nodes of a pair alike — the partition case's
 * membership, a wider window, more shards; every other case leaves it unset.
 */
type MembershipFixture = Omit<ClusterFixture, 'seeds'> & {
  readonly staleAfterMs?: number;
  readonly numShards?: number;
};

/** What the coordinator records about one region, including the #853 stamps. */
type RegionInfoView = {
  readonly node: NodeAddress;
  readonly path: string;
  readonly lastSeenAtMs: number;
  readonly lastHeartbeatAtMs: number | null;
};

/** The coordinator state this test reads straight off the actor instance. */
type CoordinatorState = {
  readonly regions: Map<string, RegionInfoView>;
  readonly shardHome: Map<number, string>;
};

const running: JoinedNode[] = [];

afterEach(async () => {
  for (const node of running.splice(0)) {
    await node.cluster.leave().catch(() => { /* best-effort */ });
    await node.system.terminate().catch(() => { /* best-effort */ });
  }
  delivered = 0;
  stoppedEntities.length = 0;
});

async function joinNode(systemName: string, port: number, options: ClusterFixture): Promise<JoinedNode> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const transport = new FaultInjectingTransport(new NodeAddress(systemName, 'h', port));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(options.seeds ?? [])
    .withTransport(transport)
    .withGossipIntervalMs(30);
  if (options.downing) clusterOptions.withDowning(options.downing);
  if (options.failureDetector) clusterOptions.withFailureDetector(options.failureDetector);
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster, transport };
  running.push(node);
  return node;
}

function startRegion(node: JoinedNode, options: RegionFixture): Node {
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(options.numShards ?? NUM_SHARDS)
    .withPassivationIdleMs(0)
    .withRebalanceIntervalMs(REBALANCE_INTERVAL_MS)
    .withStaleRegionDetection(options.detect)
    .withRegionHeartbeatIntervalMs(HEARTBEAT_INTERVAL_MS)
    .withRegionStaleAfterMs(options.staleAfterMs ?? STALE_AFTER_MS);
  if (options.coordinatorStateStore) shardingOptions.withCoordinatorStateStore(options.coordinatorStateStore);
  if (options.registerRetryIntervalMs !== undefined) {
    shardingOptions.withRegisterRetryIntervalMs(options.registerRetryIntervalMs);
  }
  const region = node.cluster.sharding.start<Command>(shardingOptions);
  return { ...node, region };
}

async function startNode(systemName: string, port: number, options: ClusterFixture & RegionFixture): Promise<Node> {
  return startRegion(await joinNode(systemName, port, options), options);
}

/**
 * A coordinator-state store holding one snapshot and accepting every save
 * without keeping it — so each load hands back exactly what the case put in,
 * however the coordinator's own saves interleave with it.
 */
function snapshotStore(snapshot: CoordinatorStateData): CoordinatorStateStore {
  return {
    load: async () => snapshot,
    save: async () => { /* discarded: the case is about the seeding, not the persistence */ },
  };
}

/** Wait until every node sees every other as `up`. */
async function converge(nodes: ReadonlyArray<JoinedNode>): Promise<void> {
  await awaitCondition(() => nodes.every((node) => node.cluster.upMembers().length === nodes.length), {
    timeoutMs: 5_000,
    label: 'the cluster converged',
  });
}

function coordinatorState(node: Node): CoordinatorState {
  const resolved = node.system._resolvePath(coordinatorSegments(node.system.name, TYPE_NAME));
  if (resolved.isNone()) throw new Error('coordinator actor not found');
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  const actor = cell?.actor;
  if (!actor) throw new Error('coordinator cell holds no actor');
  return actor as CoordinatorState;
}

/**
 * {@link coordinatorState}, or `undefined` while the coordinator is not up yet —
 * for a poll that starts before it is, where a throw would end the wait.
 */
function coordinatorStateOnceLive(node: Node): CoordinatorState | undefined {
  const resolved = node.system._resolvePath(coordinatorSegments(node.system.name, TYPE_NAME));
  if (resolved.isNone()) return undefined;
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  return cell?.actor as CoordinatorState | undefined;
}

/** The coordinator's entry for the region living on `address`, if it still has one. */
function regionOn(leader: Node, address: NodeAddress): RegionInfoView | undefined {
  return Array.from(coordinatorState(leader).regions.values())
    .find((info) => info.node.equals(address));
}

/** The registry key of that entry — what `shardHome` names as a shard's home. */
function regionKeyOn(leader: Node, address: NodeAddress): string | undefined {
  return Array.from(coordinatorState(leader).regions.entries())
    .find(([, info]) => info.node.equals(address))?.[0];
}

/** The status `observer` holds for the member at `address`, or `absent`. */
function statusOn(observer: Node, address: NodeAddress): MemberStatus | 'absent' {
  return observer.cluster.getMembers().find((member) => member.address.equals(address))?.status ?? 'absent';
}

function hostsShard(node: Node, shardId: number): boolean {
  return node.system._resolvePath([
    ...regionSegments(node.system.name, TYPE_NAME),
    `shard-${shardId}`,
  ]).isSome();
}

/**
 * Whether `node` still has a live entity actor for `entityId` under `shardId`.
 *
 * A shard's entities are its children, so this is the sharpest form of "that
 * node is still serving the shard": a region that has merely been told it no
 * longer owns the shard, without giving the shard up, keeps answering out of
 * exactly this actor.
 */
function hostsEntity(node: Node, shardId: number, entityId: string): boolean {
  return node.system._resolvePath([
    ...regionSegments(node.system.name, TYPE_NAME),
    `shard-${shardId}`,
    entityName(entityId),
  ]).isSome();
}

/** The shard ids a region still believes it owns — what {@link route} reads. */
function ownedShards(node: Node): ReadonlySet<number> {
  const resolved = node.system._resolvePath(regionSegments(node.system.name, TYPE_NAME));
  if (resolved.isNone()) throw new Error('region actor not found');
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  const actor = cell?.actor;
  if (!actor) throw new Error('region cell holds no actor');
  return (actor as { localShards: ReadonlySet<number> }).localShards;
}

/**
 * Bring up a two-node cluster with one shard homed on the non-leader, and hand
 * back the pair plus the entity that lives on it.
 *
 * `leaderDetects` / `otherDetects` are the only knobs the three cases differ
 * in, which is what makes each of them a one-variable experiment.  `fixture`
 * is what the later cases add, applied to both nodes alike.
 */
async function twoNodesHostingOneShard(
  systemName: string, base: number, leaderDetects: boolean, otherDetects: boolean,
  fixture: MembershipFixture = {},
): Promise<{ seed: Node; other: Node; shardId: number; entityId: string }> {
  // The seed is the leader (lowest address), so it hosts the active coordinator.
  const seed = await startNode(systemName, base, { ...fixture, detect: leaderDetects });
  const other = await startNode(systemName, base + 1, {
    ...fixture,
    seeds: [`${systemName}@h:${base}`],
    detect: otherDetects,
  });
  const nodes = [seed, other];

  await awaitCondition(() => nodes.every((node) => node.cluster.upMembers().length === 2), {
    timeoutMs: 5_000,
    label: 'the two-node cluster converged',
  });

  // `HashAllocationStrategy` places shard n on `sorted[n % 2]`, and the seed
  // sorts first — so an odd shard id belongs to the other node.
  const numShards = fixture.numShards ?? NUM_SHARDS;
  const entityId = ['user-1', 'user-2', 'user-3', 'user-4', 'user-5', 'user-6']
    .find((id) => hashShardId(id, numShards) % 2 === 1);
  expect(entityId).toBeDefined();
  const shardId = hashShardId(entityId!, numShards);

  seed.region.tell({ id: entityId!, kind: 'work' });
  await awaitCondition(() => delivered === 1, {
    timeoutMs: 5_000,
    label: 'the entity came up on the node that owns its shard',
  });
  expect(hostsShard(other, shardId)).toBe(true);
  return { seed, other, shardId, entityId: entityId! };
}

/**
 * The precondition both silencing cases rest on: with no beat recorded the
 * region is not a sweep candidate at all, so muting it afterwards would prove
 * nothing about the threshold.
 */
async function awaitFirstBeat(seed: Node, other: Node): Promise<void> {
  await awaitCondition(() => regionOn(seed, other.cluster.selfAddress)?.lastHeartbeatAtMs != null, {
    timeoutMs: 5_000,
    label: "the silent-to-be region's beat reached the coordinator at least once",
  });
}

describe('ClusterSharding — a region that goes silent (#853)', () => {
  test('the coordinator re-homes the shards of a region that stops beating', async () => {
    const { seed, other, shardId, entityId } =
      await twoNodesHostingOneShard('stale-region-on', 47_520, true, true);
    await awaitFirstBeat(seed, other);

    // From here the region is alive, registered and hosting — and mute.  Its
    // node keeps gossiping, so membership never moves and nothing but the
    // missing beat can tell the coordinator anything is wrong.
    other.transport.dropBeats = true;

    await awaitCondition(() => hostsShard(seed, shardId), {
      timeoutMs: 5_000,
      label: 'the surviving region was given the silent one\'s shard',
    });
    expect([seed, other].every((node) => node.cluster.upMembers().length === 2)).toBe(true);
    // The eviction is a *removal*, not merely a re-home: a coordinator that
    // kept the entry would propose the shard back on the next allocation.
    //
    // Observed after the fact rather than at the instant of the delete, because
    // an evicted region that is still alive registers again — see the
    // stands-down case below.  A re-registered entry is a demonstrably *new*
    // one: `onRegister` carries `lastHeartbeatAtMs` across a surviving entry
    // and `awaitFirstBeat` proved this one was non-null, so `null` here can
    // only mean the entry was deleted and rebuilt.
    await awaitCondition(() => {
      const info = regionOn(seed, other.cluster.selfAddress);
      return info === undefined || info.lastHeartbeatAtMs === null;
    }, {
      timeoutMs: 5_000,
      label: "the silent region's registry entry was removed, not merely re-homed",
    });

    // And the shard is genuinely usable at its new home, not merely re-listed.
    seed.region.tell({ id: entityId, kind: 'work' });
    await awaitCondition(() => delivered === 2, {
      timeoutMs: 5_000,
      label: 'traffic reaches the entity at its new home',
    });
  }, 30_000);

  test('the evicted region stands down, so the shard does not get a second live home', async () => {
    // The case the mechanism is *for*: gone or wedged on a node that is still
    // up.  The fixture builds the benign end of it — the region is alive and
    // serving and only its beats are lost — which is precisely the shape that
    // turns an eviction into double-hosting if the coordinator keeps it to
    // itself.  Rewriting `shardHome` moves nothing on the evicted node: its
    // `localShards` still names the shard, its shard actor is still up, and the
    // entity under it is still taking traffic from every sender that cached the
    // old home.
    //
    // The invariant is that the eviction *reaches* the region, not that the two
    // homes never overlap for an instant: the notice and the new home's
    // `ShardHome` are both asynchronous, so the overlap is bounded rather than
    // zero.  What the defect made it was unbounded — permanent.
    const { seed, other, shardId, entityId } =
      await twoNodesHostingOneShard('stale-region-handoff', 47_550, true, true);
    await awaitFirstBeat(seed, other);
    expect(hostsEntity(other, shardId, entityId)).toBe(true);

    other.transport.dropBeats = true;

    await awaitCondition(() => hostsShard(seed, shardId), {
      timeoutMs: 5_000,
      label: 'the surviving region was given the silent one\'s shard',
    });

    // The entity stopped *on the evicted node* — latching, so it cannot be
    // read on the wrong side of the re-registration that follows.
    const evictedEntityPath = `actor-ts://${other.system.name}/`;
    await awaitCondition(
      () => stoppedEntities.some((path) => path.startsWith(evictedEntityPath)),
      {
        timeoutMs: 5_000,
        label: 'the evicted region stopped the entity it was still serving',
      },
    );
    await awaitCondition(() => !hostsShard(other, shardId), {
      timeoutMs: 5_000,
      label: 'the evicted region gave up the shard actor as well',
    });
    expect(hostsEntity(other, shardId, entityId)).toBe(false);
    expect(ownedShards(other).has(shardId)).toBe(false);
  }, 30_000);

  test('an evicted region that is alive registers again rather than staying exiled', async () => {
    // The other half of standing down.  A region that gave its shards up and
    // then sat there would be worse than the double-hosting: the node is fully
    // alive, in the cluster and hosting nothing, and nothing would put it back
    // — `ensureRegistered` re-enters only from a leader or membership change,
    // and the register retry the acknowledgment cancelled is not re-armed.
    const { seed, other, shardId } = await twoNodesHostingOneShard(
      'stale-region-rejoin', 47_560, true, true,
      { failureDetector: REJOIN_FAILURE_DETECTOR },
    );
    await awaitFirstBeat(seed, other);

    other.transport.dropBeats = true;

    // Waited for as a *rebuilt* entry rather than as a passing absence: the
    // eviction, the notice and the re-registration are three message turns, and
    // a poll can miss the window between them entirely — which is what makes
    // `undefined` a state this test cannot depend on seeing.  A present entry
    // whose beat record is back to `null` is the same fact, latched:
    // `awaitFirstBeat` proved it was non-null, and `onRegister` only carries
    // that value across an entry that survived.
    await awaitCondition(
      () => regionOn(seed, other.cluster.selfAddress)?.lastHeartbeatAtMs === null,
      {
        timeoutMs: 5_000,
        label: 'the evicted region registered again on its own initiative',
      },
    );
    // A fresh entry has beaten to nobody, so it is not a sweep candidate — which
    // is what stops a permanently muted region from cycling through eviction and
    // re-registration every `stale-after`.  Re-read, so the assertion is about
    // the state the test goes on to use.
    expect(regionOn(seed, other.cluster.selfAddress)).toBeDefined();

    // And the cluster converges back onto the placement the strategy wants,
    // which for an odd shard id is the node that was evicted.  That move is a
    // voluntary rebalance, so it waits until the set of regions on `up` members
    // — changed twice here, by the eviction and by the re-registration — has
    // held still for the settle window: `REJOIN_FAILURE_DETECTOR`'s down-after,
    // plus up to one rebalance tick and the hand-off itself.
    await awaitCondition(() => hostsShard(other, shardId), {
      timeoutMs: 10_000,
      label: 'the re-registered region is a placement candidate again',
    });
  }, 30_000);

  test('with the switch off the same silence evicts nothing', async () => {
    // Identical fixture but for `staleRegionDetection` on the coordinator's
    // node, so this is the discriminating half: the region still beats, the
    // coordinator still records the beat, and the only thing that changes is
    // whether the sweep runs.
    const { seed, other, shardId } =
      await twoNodesHostingOneShard('stale-region-off', 47_530, false, true);
    await awaitFirstBeat(seed, other);

    other.transport.dropBeats = true;

    // The assertion is an absence, so the wait has to outlast the threshold it
    // proves is not being applied — several times over, and several rebalance
    // ticks, since the sweep would ride one of those.
    await sleep(STALE_AFTER_MS * 4);

    expect(hostsShard(other, shardId)).toBe(true);
    expect(hostsShard(seed, shardId)).toBe(false);
    expect(regionOn(seed, other.cluster.selfAddress)).toBeDefined();
    // Latching, where the readings above are snapshots: not evicted at any
    // point in the span, not merely back in place by the end of it.
    expect(seed.transport.evictionNotices).toEqual([]);
  }, 30_000);

  test('a region that never beat is never swept, however long it stays quiet', async () => {
    // The rolling-deploy window, and the reason the sweep needs a second
    // condition rather than a timestamp alone: the leader has the switch on
    // while a node still on the old configuration has it off, so that node's
    // region never beats.  Judged on `lastSeenAtMs` alone it would be evicted
    // every `stale-after`, re-register, and go round again — a loop of entity
    // teardowns out of a mechanism meant to be a rare backstop.
    //
    // Nothing needs muting here: with `staleRegionDetection` off on its own
    // node the region arms no heartbeat timer at all.
    const { seed, other, shardId } =
      await twoNodesHostingOneShard('stale-region-unarmed', 47_540, true, false);

    // An absence again, and unpollable for the same reason as the case above:
    // the region is still there at t=0 and has to be still there afterwards.
    // The wait outlasts the threshold, several times and several sweep ticks.
    await sleep(STALE_AFTER_MS * 4);

    expect(hostsShard(other, shardId)).toBe(true);
    expect(regionOn(seed, other.cluster.selfAddress)).toBeDefined();
    // Asserted *after* the wait, not before it.  At t=0 this holds whether or
    // not the switch is honoured — the first beat has not had time to land —
    // so an instant reading is a timing window, not a check.  After twenty
    // heartbeat intervals it is a statement about the whole span.
    expect(regionOn(seed, other.cluster.selfAddress)?.lastHeartbeatAtMs).toBeNull();
    // And never evicted in between.  The three readings above are snapshots,
    // and an evicted region that is alive registers again and is given its
    // shard back — so a sweep that took never-beaten regions passed all three,
    // one eviction-and-return per window.  The notice latches.
    expect(seed.transport.evictionNotices).toEqual([]);
  }, 30_000);

  test('a region with the switch off sends no beat at all, for as long as it runs', async () => {
    // "Off costs nothing" is the claim the CHANGELOG, `reference.conf` and both
    // `configuration.mdx` pages make, and until now nothing bound it: the
    // region's own `if (staleRegionDetection)` could be replaced by `if (true)`
    // and the whole suite stayed green, because every other case reads the
    // *coordinator's* records and those only say what reached it.  The frame
    // count on the sending transport is the direct observable, and counting
    // over a span rather than sampling at an instant is what makes it a check.
    const { other } = await twoNodesHostingOneShard('stale-region-silent', 47_570, true, false);

    // Unpollable, and for once the elapsed time *is* the assertion: the claim
    // is that a count stays at zero across a span, so the span has to be spent.
    // Twenty intervals, because one is a window and twenty is a statement.
    await sleep(HEARTBEAT_INTERVAL_MS * 20);

    expect(other.transport.beatsSent).toBe(0);
  }, 30_000);

  test('a region with the switch on does beat, so the count above measures something', async () => {
    // The control for the case above.  A frame counter that can only ever read
    // zero — a `kind` string that no longer matches, a beat that never reaches
    // this transport because the coordinator is node-local — would pass the
    // "off" assertion for a reason that has nothing to do with the switch.
    const { other } = await twoNodesHostingOneShard('stale-region-beating', 47_580, true, true);

    await awaitCondition(() => other.transport.beatsSent > 0, {
      timeoutMs: 5_000,
      label: 'the switched-on region beat through the transport being counted',
    });
  }, 30_000);
});

describe('ClusterSharding — a region on a node that is cut off (#853, #1467)', () => {
  test('the shard stays homed on the cut-off node until the membership decides', async () => {
    // Detection on everywhere, the region beating and its beat recorded — every
    // precondition of an eviction the sweep would otherwise act on — and then
    // the node is cut off completely, in both directions.  The seed's view
    // moves it to `unreachable` and parks it there: the downing provider never
    // decides.  The node may be running its shard the whole time, so re-homing
    // it here is what would give it a second live home.
    const { seed, other, shardId } = await twoNodesHostingOneShard(
      'stale-region-partition', 47_590, true, true,
      {
        downing: new NeverDecides(),
        failureDetector: PARTITION_FAILURE_DETECTOR,
        staleAfterMs: PARTITION_STALE_AFTER_MS,
      },
    );
    await awaitFirstBeat(seed, other);
    const otherAddress = other.cluster.selfAddress;
    const homeKey = regionKeyOn(seed, otherAddress);
    expect(homeKey).toBeDefined();
    expect(coordinatorState(seed).shardHome.get(shardId)).toBe(homeKey!);

    seed.transport.cutOffFrom.add(otherAddress.toString());
    other.transport.cutOffFrom.add(seed.cluster.selfAddress.toString());

    // The state under test, reached first: a member the cluster has not decided
    // about.  Well inside the window, by construction of the fixture.
    await awaitCondition(() => statusOn(seed, otherAddress) === 'unreachable', {
      timeoutMs: 4_000,
      label: "the seed's view marked the cut-off node unreachable",
    });

    // Held for three windows and sampled throughout, so a shard that moved and
    // came back would still be caught.  An absence cannot be polled *for* — so
    // this polls for the violation, and the window running out is the pass.
    const violation = (): string => {
      if (coordinatorState(seed).shardHome.get(shardId) !== homeKey) return 'the shard was re-homed';
      if (hostsShard(seed, shardId)) return 'the seed hosts the shard as well';
      return '';
    };
    await awaitCondition(() => violation() !== '', {
      timeoutMs: PARTITION_WATCH_MS,
      intervalMs: 20,
      label: 'a second home for the cut-off node\'s shard (not expected)',
    }).then(
      () => { throw new Error(`during the partition: ${violation()}`); },
      () => { /* the window ran out with the shard where it was: the pass */ },
    );

    // Read again directly, so a sampler that could not see anything cannot pass.
    expect(coordinatorState(seed).shardHome.get(shardId)).toBe(homeKey!);
    expect(hostsShard(seed, shardId)).toBe(false);
    expect(seed.transport.evictionNotices).toEqual([]);
    // Still undecided at the end: the case is the parked node, not a removal.
    expect(statusOn(seed, otherAddress)).toBe('unreachable');
  }, 30_000);
});

describe('ClusterSharding — a region seeded from a coordinator-state snapshot (#853)', () => {
  /** The odd shard ids — what `HashAllocationStrategy` places on the second node of two. */
  const oddShards = Array.from({ length: NUM_SHARDS }, (_, shardId) => shardId)
    .filter((shardId) => shardId % 2 === 1);

  /** A snapshot homing {@link oddShards} to one region on `address` at `path`. */
  function snapshotNaming(name: string, seedPort: number, address: NodeAddress, path: string): CoordinatorStateData {
    const key = `${address}|${path}`;
    return {
      leader: `${name}@h:${seedPort}`,
      takenAt: 0,
      numShards: NUM_SHARDS,
      regions: [{ key, node: address.toJSON(), path, proxy: false, shards: oddShards }],
      shardHome: oddShards.map((shardId) => [shardId, key] as const),
    };
  }

  test('a seeded region that never registers has its shards re-homed once its grace runs out', async () => {
    // The snapshot names a region on a node that is up and runs no region for
    // the type at all — the coordinator came back and the region did not.
    // Nothing else will ever evict it: the node is up, so no membership event
    // fires, and a region that does not exist sends no goodbye.  Until the
    // sweep notices, every shard the snapshot gave it is homed to nobody.
    const name = 'stale-region-seeded-ghost';
    const seedPort = 47_620;
    const ghostAddress = new NodeAddress(name, 'h', seedPort + 1);
    const ghostPath = systemActorPath(name, SystemGroups.clusterSharding, shardRegionName(TYPE_NAME));
    const ghostKey = `${ghostAddress}|${ghostPath}`;

    const seedJoined = await joinNode(name, seedPort, {});
    const ghostHost = await joinNode(name, seedPort + 1, { seeds: [`${name}@h:${seedPort}`] });
    await converge([seedJoined, ghostHost]);
    // Only the seed starts the type; the snapshot is all the coordinator knows
    // about the other node.
    const seed = startRegion(seedJoined, {
      detect: true,
      coordinatorStateStore: snapshotStore(snapshotNaming(name, seedPort, ghostAddress, ghostPath)),
    });

    await awaitCondition(() => coordinatorStateOnceLive(seed)?.regions.has(ghostKey) === true, {
      timeoutMs: 5_000,
      label: "the coordinator seeded the snapshot's region",
    });
    expect(oddShards.every((shardId) => coordinatorState(seed).shardHome.get(shardId) === ghostKey)).toBe(true);

    await awaitCondition(
      () => oddShards.every((shardId) => coordinatorState(seed).shardHome.get(shardId) !== ghostKey),
      { timeoutMs: 4_000, label: "the seeded region's shards were re-homed" },
    );
    expect(coordinatorState(seed).regions.has(ghostKey)).toBe(false);
    // Re-homed, not merely unhomed: the one region that is there took them.
    const seedKey = regionKeyOn(seed, seed.cluster.selfAddress);
    expect(oddShards.every((shardId) => coordinatorState(seed).shardHome.get(shardId) === seedKey)).toBe(true);
    // And not before the grace: the sweep stamps the eviction with how long the
    // entry had been silent, counted from its seeding.
    expect(seed.transport.evictionNotices).toHaveLength(1);
    expect(seed.transport.evictionNotices[0]!.to).toBe(ghostAddress.toString());
    expect(seed.transport.evictionNotices[0]!.silentForMs).toBeGreaterThanOrEqual(STALE_AFTER_MS);
  }, 30_000);

  test('a seeded entry whose region registers is judged like any registered one', async () => {
    // The other half of the rule, and why it cannot loop: a seeded region that
    // is alive registers on its own — on the leader change and on its register
    // retry — and from then on it is an ordinary registered entry.  This one
    // never beats (detection is off on its node, the rolling-deploy shape), so
    // a seeded grace that survived the registration would evict it one window
    // later, it would register again, and the loop would run.
    const name = 'stale-region-seeded-live';
    const seedPort = 47_630;
    const seedJoined = await joinNode(name, seedPort, {});
    const otherJoined = await joinNode(name, seedPort + 1, { seeds: [`${name}@h:${seedPort}`] });
    await converge([seedJoined, otherJoined]);

    // The region exists but its registrations are held back, so the coordinator
    // learns about it from the snapshot first — the order the case is about.
    otherJoined.transport.dropRegisters = true;
    const other = startRegion(otherJoined, {
      detect: false,
      staleAfterMs: REGISTERING_STALE_AFTER_MS,
      registerRetryIntervalMs: FAST_REGISTER_RETRY_MS,
    });
    const otherAddress = other.cluster.selfAddress;
    const otherPath = other.region.path.toString();
    const otherKey = `${otherAddress}|${otherPath}`;
    const seed = startRegion(seedJoined, {
      detect: true,
      staleAfterMs: REGISTERING_STALE_AFTER_MS,
      coordinatorStateStore: snapshotStore(snapshotNaming(name, seedPort, otherAddress, otherPath)),
    });

    await awaitCondition(() => coordinatorStateOnceLive(seed)?.regions.has(otherKey) === true, {
      timeoutMs: 5_000,
      label: "the coordinator seeded the snapshot's region",
    });
    const seededEntry = coordinatorState(seed).regions.get(otherKey);

    other.transport.dropRegisters = false;
    // A registration always writes a new entry, so a different object under the
    // same key is the registration having landed.  An eviction followed by a
    // fresh registration would look the same here, which is what the eviction
    // notices below rule out.
    await awaitCondition(() => coordinatorState(seed).regions.get(otherKey) !== seededEntry, {
      timeoutMs: 4_000,
      label: 'the seeded region registered',
    });
    // No beat record is invented on the way: the entry is a registered region
    // that has never beaten, the shape the sweep leaves alone.
    expect(coordinatorState(seed).regions.get(otherKey)?.lastHeartbeatAtMs).toBeNull();

    // Held for three windows and sampled throughout.  An absence cannot be
    // polled *for*, so this polls for the eviction, and the window running out
    // is the pass.
    await awaitCondition(
      () => seed.transport.evictionNotices.length > 0 || !coordinatorState(seed).regions.has(otherKey),
      { timeoutMs: REGISTERING_WATCH_MS, intervalMs: 20, label: 'an eviction of the registered region (not expected)' },
    ).then(
      () => { throw new Error('the registered region was evicted as if it were still seeded'); },
      () => { /* the window ran out with the region registered: the pass */ },
    );

    // Read again directly, so a sampler that could not see anything cannot pass.
    expect(seed.transport.evictionNotices).toEqual([]);
    expect(coordinatorState(seed).regions.has(otherKey)).toBe(true);
  }, 30_000);
});

describe('ClusterSharding — a region that is busy but no longer beating (#853)', () => {
  // The beat only has to cover an *idle* region: every coordinator-bound frame
  // that names a region refreshes when it was last heard from, so one under
  // load never needs to beat at all.  Both cases drop the beats of a region
  // that has beaten — so it is a sweep candidate — and keep it talking in one
  // other way for three windows; each binds one of the frames that count.

  test('a region that keeps asking for shard homes is not evicted', async () => {
    const { seed, other, shardId } = await twoNodesHostingOneShard(
      'stale-region-busy-asking', 47_640, true, true,
      { staleAfterMs: BUSY_STALE_AFTER_MS, numShards: BUSY_NUM_SHARDS },
    );
    await awaitFirstBeat(seed, other);
    const beatenEntry = regionOn(seed, other.cluster.selfAddress);

    // One entity per shard this region has not routed to yet: the first message
    // for each makes it ask the coordinator for that shard's home, and only the
    // home it already knows — the fixture's own shard — would not.
    const unaskedShards = new Set<number>();
    const entityIds: string[] = [];
    for (let candidate = 0; entityIds.length < BUSY_NUM_SHARDS - 1 && candidate < 10_000; candidate++) {
      const id = `asking-${candidate}`;
      const candidateShard = hashShardId(id, BUSY_NUM_SHARDS);
      if (candidateShard === shardId || unaskedShards.has(candidateShard)) continue;
      unaskedShards.add(candidateShard);
      entityIds.push(id);
    }

    other.transport.dropBeats = true;
    const busyUntil = Date.now() + BUSY_WATCH_MS;
    for (const entityId of entityIds) {
      if (Date.now() >= busyUntil) break;
      other.region.tell({ id: entityId, kind: 'work' });
      // Pacing, not a wait for a state: the region's own traffic is the
      // experiment, one new shard per step and far inside the window.
      await sleep(BUSY_PACE_MS);
    }
    // The asking covered the whole span, so the region was never silent for a
    // window's worth of it — otherwise the case would end before it proved
    // anything.
    expect(Date.now()).toBeGreaterThanOrEqual(busyUntil);

    expect(seed.transport.evictionNotices).toEqual([]);
    // The same entry, never rebuilt by an eviction and a fresh registration.
    expect(regionOn(seed, other.cluster.selfAddress)).toBe(beatenEntry);
  }, 30_000);

  test('a region that keeps answering statistics queries is not evicted', async () => {
    const { seed, other } = await twoNodesHostingOneShard(
      'stale-region-busy-stats', 47_642, true, true,
      { staleAfterMs: BUSY_STALE_AFTER_MS },
    );
    await awaitFirstBeat(seed, other);
    const beatenEntry = regionOn(seed, other.cluster.selfAddress);

    other.transport.dropBeats = true;
    const busyUntil = Date.now() + BUSY_WATCH_MS;
    while (Date.now() < busyUntil) {
      // Every query fans out to every registered region, and each answer names
      // the region that sent it — asked from the seed, so the mute region's
      // only traffic is its answer.
      await seed.cluster.sharding.shards(TYPE_NAME, 2_000);
      // Pacing, not a wait for a state: the queries are the experiment.
      await sleep(BUSY_PACE_MS);
    }

    expect(seed.transport.evictionNotices).toEqual([]);
    expect(regionOn(seed, other.cluster.selfAddress)).toBe(beatenEntry);
  }, 30_000);

  test('traffic alone does not opt a region into the sweep', async () => {
    // The other half of the contract: a frame says the region is alive, not
    // that it agreed to be swept once it stops talking — only the beat says
    // that.  A region on a node with detection off asks for one home and then
    // goes quiet; it never beat, so its silence must cost it nothing.
    const { seed, other, shardId } =
      await twoNodesHostingOneShard('stale-region-unarmed-traffic', 47_644, true, false);
    const entityId = ['user-1', 'user-2', 'user-3', 'user-4', 'user-5', 'user-6', 'user-7', 'user-8']
      .find((id) => hashShardId(id, NUM_SHARDS) !== shardId);
    expect(entityId).toBeDefined();

    other.region.tell({ id: entityId!, kind: 'work' });
    await awaitCondition(() => delivered === 2, {
      timeoutMs: 5_000,
      label: 'the unarmed region asked for a home and its message arrived',
    });

    // An absence across three windows: unpollable, so the span is spent.
    await sleep(STALE_AFTER_MS * 3);

    expect(seed.transport.evictionNotices).toEqual([]);
    expect(regionOn(seed, other.cluster.selfAddress)?.lastHeartbeatAtMs).toBeNull();
  }, 30_000);
});

describe('ClusterSharding.isRegistered across an eviction (#853, #1465)', () => {
  test('reads false while the evicted region cannot register again, and true once it has', async () => {
    // `isRegistered` is what a readiness check reads.  An evicted region gives
    // up its shards and registers afresh, and until a coordinator acknowledges
    // that it is not registered, whatever it was a moment ago — the coordinator
    // holds no entry for it and will place nothing there.  Its `Register`
    // frames are dropped here so that window stays open long enough to read.
    const { seed, other } = await twoNodesHostingOneShard('stale-region-registration', 47_650, true, true);
    await awaitFirstBeat(seed, other);
    await awaitCondition(() => other.cluster.sharding.isRegistered(TYPE_NAME), {
      timeoutMs: 4_000,
      label: 'the region reads as registered before it goes mute',
    });
    const otherAddress = other.cluster.selfAddress;

    other.transport.dropRegisters = true;
    other.transport.dropBeats = true;

    await awaitCondition(() => regionOn(seed, otherAddress) === undefined, {
      timeoutMs: 5_000,
      label: 'the coordinator evicted the mute region',
    });
    await awaitCondition(() => !other.cluster.sharding.isRegistered(TYPE_NAME), {
      timeoutMs: 4_000,
      label: 'isRegistered went false on the evicted node',
    });
    // Both sides agree: the coordinator holds no entry, the node does not
    // claim one — and the eviction notice is what told it.
    expect(regionOn(seed, otherAddress)).toBeUndefined();
    expect(seed.transport.evictionNotices.map((notice) => notice.to)).toEqual([otherAddress.toString()]);

    other.transport.dropRegisters = false;
    await awaitCondition(() => other.cluster.sharding.isRegistered(TYPE_NAME), {
      timeoutMs: 4_000,
      label: 'isRegistered read true again once the new registration was acknowledged',
    });
    expect(regionOn(seed, otherAddress)).toBeDefined();
  }, 30_000);
});
