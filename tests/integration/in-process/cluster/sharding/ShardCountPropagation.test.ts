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
import { hashShardId } from '../../../../../src/cluster/sharding/ShardAllocator.js';
import { DEFAULT_NUM_SHARDS } from '../../../../../src/cluster/sharding/ShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

/**
 * A configured `numShards` has to reach the coordinator, not just the region
 * (#1026).
 *
 * `ClusterSharding.start` used to call `ensureCoordinator` before it populated
 * `numShardsByType`, and `ensureCoordinator` resolved the count out of exactly
 * that map — so on the first (and only) start of a type the lookup missed and
 * the coordinator fell back to `DEFAULT_NUM_SHARDS`.  The region then hashed
 * with the real value while the coordinator bounded with 64: every
 * `GetShardHome` for a shard id at or above 64 was refused, the shard never
 * got a home, and its messages accumulated in the region's unbounded buffer
 * until the process ran out of memory.  With the documented `numShards: 1000`
 * that is roughly 94 % of entities.
 *
 * The test drives it end to end rather than reading the coordinator's config,
 * because the buffered-forever message is the symptom an operator actually
 * meets.
 */

type WorkCommand = { id: string; kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';
const NUM_SHARDS = 1_000;

/**
 * Entity ids that actually received their message.  Recorded on delivery
 * rather than in `preStart`, because "the message arrived" is the property
 * under test — under the defect the entity is never even asked for.
 */
const delivered = new Set<string>();

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, (m) => this.onWork(m))
      .exhaustive();
  }

  private onWork(message: WorkCommand): void { delivered.add(message.id); }
}

/**
 * Kept as a name so every call site here stays unchanged; the body forwards to
 * the shared helper (#418), which names the awaited state in its timeout message
 * and — unlike the deadline loop it replaces — cannot fall through silently.
 */
const waitFor = (
  predicate: () => boolean,
  timeoutMs = 5_000,
  stepMs = 10,
  label = 'the awaited shard-count propagation state',
): Promise<void> => awaitCondition(predicate, { timeoutMs, intervalMs: stepMs, label });

/**
 * An entity id whose shard lands beyond `DEFAULT_NUM_SHARDS`.  Searched rather
 * than hard-coded so the test keeps meaning if the hash ever changes — it is
 * the *region above 64* that matters, not any particular id.
 */
function entityIdBeyondDefaultShards(): string {
  for (let i = 0; i < 10_000; i++) {
    const candidate = `entity-${i}`;
    if (hashShardId(candidate, NUM_SHARDS) >= DEFAULT_NUM_SHARDS) return candidate;
  }
  throw new Error(`no entity id hashed beyond shard ${DEFAULT_NUM_SHARDS}`);
}

let running: { system: ActorSystem; cluster: Cluster } | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => {});
    await running.system.terminate().catch(() => {});
    running = null;
  }
  delivered.clear();
});

describe('ClusterSharding shard-count propagation', () => {
  test('an entity beyond the default shard count still gets a home', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('sharding-count', systemOptions);
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(2600)
      .withSeeds([])
      .withTransport(new InMemoryTransport(new NodeAddress('sharding-count', 'h', 2600)))
      .withGossipIntervalMs(30);
    const cluster = await Cluster.join(system, clusterOptions);
    running = { system, cluster };

    const shardingOptions = StartShardingOptions.create<Command>()
      .withTypeName(TYPE_NAME)
      .withEntityActor(Entity)
      .withExtractEntityId((message) => message.id)
      .withNumShards(NUM_SHARDS)
      .withRememberEntitiesStore(null)
      .withPassivationIdleMs(0);

    const region = cluster.sharding.start<Command>(shardingOptions);

    const farEntity = entityIdBeyondDefaultShards();
    expect(hashShardId(farEntity, NUM_SHARDS)).toBeGreaterThanOrEqual(DEFAULT_NUM_SHARDS);

    region.tell({ id: farEntity, kind: 'work' });

    // Under the defect this never arrives: the coordinator bounds at 64,
    // refuses the home, and the message waits in the region's buffer.
    await waitFor(() => delivered.has(farEntity));
    expect(delivered.has(farEntity)).toBe(true);
  });

  test('an entity inside the default range keeps working', async () => {
    // The control: shard ids below 64 were always allocated, so this passed
    // before the fix too.  It is here so a regression that breaks the low
    // range is not mistaken for the same bug returning.
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('sharding-count-low', systemOptions);
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(2601)
      .withSeeds([])
      .withTransport(new InMemoryTransport(new NodeAddress('sharding-count-low', 'h', 2601)))
      .withGossipIntervalMs(30);
    const cluster = await Cluster.join(system, clusterOptions);
    running = { system, cluster };

    const shardingOptions = StartShardingOptions.create<Command>()
      .withTypeName(TYPE_NAME)
      .withEntityActor(Entity)
      .withExtractEntityId((message) => message.id)
      .withNumShards(NUM_SHARDS)
      .withRememberEntitiesStore(null)
      .withPassivationIdleMs(0);

    const region = cluster.sharding.start<Command>(shardingOptions);

    let nearEntity: string | null = null;
    for (let i = 0; i < 10_000 && nearEntity === null; i++) {
      const candidate = `entity-${i}`;
      if (hashShardId(candidate, NUM_SHARDS) < DEFAULT_NUM_SHARDS) nearEntity = candidate;
    }
    if (nearEntity === null) throw new Error('no entity id hashed inside the default range');

    region.tell({ id: nearEntity, kind: 'work' });
    await waitFor(() => delivered.has(nearEntity));
    expect(delivered.has(nearEntity)).toBe(true);
  });
});
