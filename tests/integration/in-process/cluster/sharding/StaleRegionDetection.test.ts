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
 * The two cases differ in **one** setting — whether the *coordinator's* node has
 * `staleRegionDetection` on.  The silent region has it on in both, so it beats
 * in both and the coordinator records that beat in both; only the sweep changes.
 * Without that symmetry the `off` case would pass for the wrong reason (a region
 * that never beat is never swept regardless) and would say nothing about the
 * switch.
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

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

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

  override send(to: NodeAddress, message: WireMessage): void {
    if (this.dropBeats && BeatDroppingTransport.isRegionHeartbeat(message)) return;
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
    expect(regionOn(seed, other.cluster.selfAddress)).toBeUndefined();

    // And the shard is genuinely usable at its new home, not merely re-listed.
    seed.region.tell({ id: entityId, kind: 'work' });
    await awaitCondition(() => delivered === 2, {
      timeoutMs: 5_000,
      label: 'traffic reaches the entity at its new home',
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

    expect(regionOn(seed, other.cluster.selfAddress)?.lastHeartbeatAtMs).toBeNull();
    // An absence again, and unpollable for the same reason as the case above:
    // the region is still there at t=0 and has to be still there afterwards.
    // The wait outlasts the threshold, several times and several sweep ticks.
    await sleep(STALE_AFTER_MS * 4);

    expect(hostsShard(other, shardId)).toBe(true);
    expect(regionOn(seed, other.cluster.selfAddress)).toBeDefined();
  }, 30_000);
});
