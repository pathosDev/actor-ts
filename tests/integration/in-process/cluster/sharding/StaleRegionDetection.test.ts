/**
 * A region that goes silent without its node dying (#853).
 *
 * #648 gave a region a way to say goodbye, and its own docs concede the
 * notification is best-effort: single-shot, unacknowledged, and a transport
 * failure on the way down is logged and swallowed.  Lose it and the cluster is
 * back in the orphaned state #648 fixed — the coordinator keeps naming a dead
 * region as the home of its shards, senders cache that home, and nothing
 * self-heals, because `candidates()` is derived from the registry with no
 * liveness check.  The node is still up, so no `MemberRemoved` will ever fire
 * either: the failure detector answers "is the node alive", never "is that
 * region still there".
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
 */
import { match } from 'ts-pattern';
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../../../src/cluster/Protocol.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { hashShardId } from '../../../../../src/cluster/sharding/ShardAllocator.js';
import { entityName } from '../../../../../src/cluster/sharding/Shard.js';
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

/**
 * A transport that can stop delivering *this node's* liveness beats while
 * everything else — cluster heartbeats, gossip, every other sharding frame —
 * keeps flowing.
 *
 * Dropped on the sending side deliberately: the receiving coordinator is then
 * in precisely the state a lost frame leaves it in, with no test-only branch
 * anywhere in `src/`.
 */
class BeatDroppingTransport extends InMemoryTransport {
  dropBeats = false;
  /**
   * Every beat this node *tried* to send, counted before `dropBeats` gets a
   * say — so it measures whether the region beats at all, not whether a beat
   * arrived.  That is the observable the "off costs nothing" claim needs: the
   * coordinator's records only say what reached it.
   */
  beatsSent = 0;

  override send(to: NodeAddress, message: WireMessage): void {
    if (BeatDroppingTransport.isRegionHeartbeat(message)) {
      this.beatsSent++;
      if (this.dropBeats) return;
    }
    super.send(to, message);
  }

  private static isRegionHeartbeat(message: WireMessage): boolean {
    if (message.kind !== 'envelope') return false;
    const body = message.body as { kind?: unknown } | null;
    return typeof body === 'object' && body !== null && body.kind === 'sharding.RegionHeartbeat';
  }
}

type Node = {
  system: ActorSystem;
  cluster: Cluster;
  region: ActorRef<Command>;
  transport: BeatDroppingTransport;
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

const running: Node[] = [];

afterEach(async () => {
  for (const node of running.splice(0)) {
    await node.cluster.leave().catch(() => { /* best-effort */ });
    await node.system.terminate().catch(() => { /* best-effort */ });
  }
  delivered = 0;
  stoppedEntities.length = 0;
});

async function startNode(
  systemName: string,
  port: number,
  options: { seeds?: string[]; detect: boolean },
): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const transport = new BeatDroppingTransport(new NodeAddress(systemName, 'h', port));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(options.seeds ?? [])
    .withTransport(transport)
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    .withPassivationIdleMs(0)
    .withRebalanceIntervalMs(REBALANCE_INTERVAL_MS)
    .withStaleRegionDetection(options.detect)
    .withRegionHeartbeatIntervalMs(HEARTBEAT_INTERVAL_MS)
    .withRegionStaleAfterMs(STALE_AFTER_MS);
  const region = cluster.sharding.start<Command>(shardingOptions);
  const node = { system, cluster, region, transport };
  running.push(node);
  return node;
}

function coordinatorState(node: Node): CoordinatorState {
  const resolved = node.system._resolvePath(coordinatorSegments(node.system.name, TYPE_NAME));
  if (resolved.isNone()) throw new Error('coordinator actor not found');
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  const actor = cell?.actor;
  if (!actor) throw new Error('coordinator cell holds no actor');
  return actor as CoordinatorState;
}

/** The coordinator's entry for the region living on `address`, if it still has one. */
function regionOn(leader: Node, address: NodeAddress): RegionInfoView | undefined {
  return Array.from(coordinatorState(leader).regions.values())
    .find((info) => info.node.equals(address));
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
 * in, which is what makes each of them a one-variable experiment.
 */
async function twoNodesHostingOneShard(
  systemName: string, base: number, leaderDetects: boolean, otherDetects: boolean,
): Promise<{ seed: Node; other: Node; shardId: number; entityId: string }> {
  // The seed is the leader (lowest address), so it hosts the active coordinator.
  const seed = await startNode(systemName, base, { detect: leaderDetects });
  const other = await startNode(systemName, base + 1, {
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
  const entityId = ['user-1', 'user-2', 'user-3', 'user-4', 'user-5', 'user-6']
    .find((id) => hashShardId(id, NUM_SHARDS) % 2 === 1);
  expect(entityId).toBeDefined();
  const shardId = hashShardId(entityId!, NUM_SHARDS);

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
    const { seed, other, shardId } =
      await twoNodesHostingOneShard('stale-region-rejoin', 47_560, true, true);
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
    // which for an odd shard id is the node that was evicted.
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
