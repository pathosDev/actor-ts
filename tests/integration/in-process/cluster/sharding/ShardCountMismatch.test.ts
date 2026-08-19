/**
 * Two nodes that disagree about `numShards` used to double-home entities
 * silently (#633).
 *
 * A shard id is `hash(entityId) % numShards`, computed independently on every
 * node.  Nothing ever travelled in the sharding handshake to make the nodes
 * agree, so one entity id hashed into one shard on one node and into another
 * on its peer, each node owned the shard *its* hash produced, and both
 * instantiated the entity — at two paths that never collide, which is
 * precisely why nothing warned.  The bound added in #583 catches only the
 * direction where a region
 * asks for an id above the coordinator's range, and turns that into a silent
 * hang rather than a diagnosis.
 *
 * `RegisterRegion` now carries the count and the coordinator refuses a region
 * that disagrees.  Two things have to hold for that to be a fix rather than a
 * log line: the refused region must never be a placement candidate (it is not
 * in `regions`), and it must not get a home through the back door either —
 * `onGetShardHome` never required a registration, so its first buffered
 * message would otherwise have been allocated a shard anyway.
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
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { ShardKey } from '../../../../../src/cluster/sharding/ShardKey.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { regionSegments } from '../../../../util/SystemPaths.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

type WorkCommand = { id: string; kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';
/**
 * The two counts and the entity id are picked together so that the mismatch is
 * actually *observable*, which takes more care than it looks.
 *
 * `HashAllocationStrategy` places shard `n` on `sorted[n % nodeCount]`, so with
 * two nodes the owner is decided by the shard id's parity — and `x % m` has the
 * same parity as `x` for every **even** `m`.  A 64/32 pair therefore always
 * sends both incarnations to the same node, where the receiving region
 * re-derives the id under its own count and lands on the entity that is already
 * there.  Two live instances need the two hashes to be owned by *different*
 * nodes, which needs one odd modulus.
 *
 * `user-7` hashes to shard 50 under 33.  Node A (the leader, and the lower
 * address) owns 50; node B owns 19.  So each node hosts the shard its own
 * arithmetic produced, and both would run `user-7`.
 */
const NUM_SHARDS_AGREED = 64;
const NUM_SHARDS_DISAGREEING = 33;
const ENTITY_ID = 'user-7';
/** Wide enough to cover every shard id either configuration can produce. */
const SCAN_LIMIT = 64;

let delivered = 0;

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { delivered++; }
}

type Node = {
  system: ActorSystem;
  cluster: Cluster;
  region: ActorRef<Command>;
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
  numShards: number,
  seeds: string[] = [],
): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(numShards)
    .withPassivationIdleMs(0);
  const region = cluster.sharding.start<Command>(shardingOptions);
  const node = { system, cluster, region };
  running.push(node);
  return node;
}

/**
 * How many live actors named `entity-<ENTITY_ID>` exist across the cluster.
 *
 * Scans every shard id either configuration could produce, on every node —
 * the whole point is that the two incarnations sit at *different* paths, so a
 * lookup at one known path would miss the second one.
 */
function liveEntityCount(nodes: Node[]): number {
  let count = 0;
  for (const node of nodes) {
    for (let shardId = 0; shardId < SCAN_LIMIT; shardId++) {
      const resolved = node.system._resolvePath([
        ...regionSegments(node.system.name, TYPE_NAME),
        `shard-${shardId}`,
        `entity-${ENTITY_ID}`,
      ]);
      if (resolved.isSome()) count++;
    }
  }
  return count;
}

describe('ClusterSharding — numShards mismatch (#633)', () => {
  test('a node configured with a different numShards never double-homes an entity', async () => {
    const systemName = 'mismatch';
    const base = 47_400;
    // The seed has the lowest address, so it is the leader and its coordinator
    // is the one that governs the type.
    const seed = await startNode(systemName, base, NUM_SHARDS_AGREED);
    const other = await startNode(
      systemName, base + 1, NUM_SHARDS_DISAGREEING, [`${systemName}@h:${base}`],
    );
    const nodes = [seed, other];

    await awaitCondition(() => nodes.every((node) => node.cluster.upMembers().length === 2), {
      timeoutMs: 5_000,
      label: 'the two-node cluster converged',
    });

    // The correctly configured node brings the entity up where it belongs.
    seed.region.tell({ id: ENTITY_ID, kind: 'work' });
    await awaitCondition(() => delivered === 1, {
      timeoutMs: 5_000,
      label: 'the entity came up on the agreeing node',
    });

    // The misconfigured node asks for the same entity.  Under its own modulus
    // that is a different shard, owned by itself, and before the fix it got
    // one — a second live instance, writing the same persistenceId.
    other.region.tell({ id: ENTITY_ID, kind: 'work' });
    // An absence: the claim is that no *second* live instance appears and that
    // the misrouted message is buffered rather than delivered.  Both are already
    // true at t=0, so only a window can disprove them — and a poll on
    // `liveEntityCount === 1` would return on the first tick and assert nothing.
    await sleep(600);

    expect(liveEntityCount(nodes)).toBe(1);
    // Buffered, not delivered: a misconfigured node fails stop rather than
    // quietly running a second copy.
    expect(delivered).toBe(1);
  }, 20_000);

  test('agreeing nodes are unaffected', async () => {
    // The control for the case above: the same shape, one count, and the
    // refusal must not fire.
    const systemName = 'agree';
    const base = 47_410;
    const seed = await startNode(systemName, base, NUM_SHARDS_AGREED);
    const other = await startNode(
      systemName, base + 1, NUM_SHARDS_AGREED, [`${systemName}@h:${base}`],
    );
    const nodes = [seed, other];

    await awaitCondition(() => nodes.every((node) => node.cluster.upMembers().length === 2), {
      timeoutMs: 5_000,
      label: 'the two-node cluster converged',
    });

    other.region.tell({ id: ENTITY_ID, kind: 'work' });
    await awaitCondition(() => delivered === 1, {
      timeoutMs: 5_000,
      label: 'the entity came up somewhere in the cluster',
    });
    seed.region.tell({ id: ENTITY_ID, kind: 'work' });
    await awaitCondition(() => delivered === 2, {
      timeoutMs: 5_000,
      label: 'the other node routes to the same instance',
    });

    expect(liveEntityCount(nodes)).toBe(1);
  }, 20_000);

  test('start() after startProxy() for the same type is refused', async () => {
    // The related hazard: `start` returns the existing region for a type, and
    // `startProxy` populates the same registry — so the caller got the *proxy*
    // back, whose placeholder entity factory throws the moment a shard lands
    // locally.  A misconfiguration that used to surface as a spawn failure
    // nobody wrote now surfaces at the call that caused it.
    const node = await startNode('proxy-clash', 47_420, 16);
    const key = ShardKey.of<Command>('proxy-type', (message) => message.id);

    node.cluster.sharding.startProxy<Command>(key);
    expect(() => node.cluster.sharding.start<Command>(key, Entity))
      .toThrow(/already started on this node as a proxy region/);

    // And the reverse order, which is just as wrong: the caller asked for a
    // routing-only node and would have been handed one that hosts entities.
    expect(() => node.cluster.sharding.startProxy<Command>(ShardKey.of<Command>(
      TYPE_NAME, (message) => message.id,
    ))).toThrow(/already started on this node as a hosting region/);
  }, 20_000);
});
