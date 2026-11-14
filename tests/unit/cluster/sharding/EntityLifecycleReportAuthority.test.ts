/**
 * `sharding.EntityStarted` / `EntityStopped` are taken only from whoever can
 * truthfully say them (#1267).
 *
 * Both kinds arrived through the same door as every other sharding frame and
 * were gated on nothing but attribution.  One frame from any authenticated
 * member planted an attacker-chosen entity id in a region's index, kept a
 * shard's idle clock from ever starting, and — through the coordinator — wrote
 * phantom pairs into the durable remember-entities registry, which the next
 * allocation pre-creates as real entities.  `EntityStopped` made it forget
 * real ones.
 *
 * Now:
 *
 * - the **region** takes a lifecycle report only from its own shards — a
 *   frame that came off the wire has no business reporting a local shard's
 *   lifecycle — and an `EntityStarted` only for a shard id in range that it
 *   hosts;
 * - the **coordinator** takes one only from the node its `shardHome` names for
 *   that shard, only with an entity id that is a non-empty string within
 *   {@link MAX_REMEMBERED_ENTITY_ID_LENGTH}, and stops adding to a shard at
 *   {@link MAX_REMEMBERED_ENTITIES_PER_SHARD}, with a warning.
 *
 * The honest relay — a shard reports to its region, the region to the
 * coordinator under `rememberEntities` — is the positive control: the entity
 * this harness starts must still end up in the coordinator's registry.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import {
  MAX_REMEMBERED_ENTITIES_PER_SHARD,
  MAX_REMEMBERED_ENTITY_ID_LENGTH,
} from '../../../../src/cluster/Constants.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../../src/cluster/Protocol.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import {
  AuthenticatedShardingMessage,
  type EntityStarted,
  type EntityStopped,
} from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { SystemGroups, shardRegionName, systemActorPath } from '../../../../src/internal/SystemPaths.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';
import { coordinatorSegments, regionSegments } from '../../../util/SystemPaths.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';

type WorkCommand = { readonly id: string; readonly kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';
const NUM_SHARDS = 4;
const ENTITY_ID = 'user-1';
const SHARD = hashShardId(ENTITY_ID, NUM_SHARDS);

let delivered = 0;

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { delivered++; }
}

type CoordinatorInternals = {
  readonly entitiesPerShard: Map<number, Set<string>>;
};

type RegionInternals = {
  readonly shardEntities: Map<number, Set<string>>;
  readonly entityActivity: Map<string, unknown>;
};

type Victim = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly log: RecordingLogger;
  readonly regionPath: string;
  readonly coordinatorPath: string;
  readonly coordinator: () => CoordinatorInternals;
  readonly region: () => RegionInternals;
  /** Tell the coordinator a frame attributed to this node — the hosting peer for every shard here. */
  readonly tellCoordinatorAsHost: (message: EntityStarted | EntityStopped) => void;
};

let running: Victim | null = null;
const transports: InMemoryTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.shutdown().catch(() => { /* best-effort */ })));
  if (running) {
    await running.cluster.leave().catch(() => { /* best-effort */ });
    await running.system.terminate().catch(() => { /* best-effort */ });
    running = null;
  }
  delivered = 0;
});

function actorAt<T>(system: ActorSystem, segments: string[]): T {
  const resolved = system._resolvePath(segments);
  if (resolved.isNone()) throw new Error(`no actor at ${segments.join('/')}`);
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  return cell?.actor as T;
}

/**
 * A single-node cluster remembering entities in memory, with `user-1` up —
 * which also proves the honest relay reached the coordinator.
 */
async function startVictim(systemName: string, port: number): Promise<Victim> {
  const log = new RecordingLogger();
  const system = ActorSystem.create(systemName, ActorSystemOptions.create().withLogger(log));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    .withRememberEntities(true)
    .withRememberEntitiesStore(null)
    .withPassivationIdleMs(0);
  const regionRef = cluster.sharding.start<Command>(shardingOptions);

  const coordinator = (): CoordinatorInternals =>
    actorAt<CoordinatorInternals>(system, coordinatorSegments(systemName, TYPE_NAME));
  const victim: Victim = {
    system,
    cluster,
    log,
    regionPath: systemActorPath(systemName, SystemGroups.clusterSharding, shardRegionName(TYPE_NAME)),
    coordinatorPath: systemActorPath(systemName, SystemGroups.clusterSharding, `coordinator-${TYPE_NAME}`),
    coordinator,
    region: () => actorAt<RegionInternals>(system, regionSegments(systemName, TYPE_NAME)),
    tellCoordinatorAsHost: (message) => {
      const resolved = system._resolvePath(coordinatorSegments(systemName, TYPE_NAME));
      if (resolved.isNone()) throw new Error('coordinator actor not found');
      resolved.value.tell(new AuthenticatedShardingMessage(cluster.selfAddress, message) as never);
    },
  };
  running = victim;
  regionRef.tell({ id: ENTITY_ID, kind: 'work' });
  await awaitCondition(
    () => delivered === 1 && (coordinator().entitiesPerShard.get(SHARD)?.has(ENTITY_ID) ?? false),
    { timeoutMs: 4_000, label: 'the entity came up and the honest relay reached the coordinator' },
  );
  return victim;
}

async function attacker(name: string, port: number): Promise<InMemoryTransport> {
  const transport = new InMemoryTransport(new NodeAddress(name, 'h', port));
  transport.setHandler(() => { /* replies are not read */ });
  await transport.start();
  transports.push(transport);
  return transport;
}

function forge(from: InMemoryTransport, victim: Victim, to: string, body: unknown): void {
  from.send(victim.cluster.selfAddress, { kind: 'envelope', to, from: null, body } as unknown as WireMessage);
}

const started = (shardId: number, entityId: unknown): EntityStarted =>
  ({ kind: 'sharding.EntityStarted', shardId, entityId } as EntityStarted);

const stopped = (shardId: number, entityId: unknown): EntityStopped =>
  ({ kind: 'sharding.EntityStopped', shardId, entityId } as EntityStopped);

const remembered = (victim: Victim): string[] =>
  Array.from(victim.coordinator().entitiesPerShard.get(SHARD) ?? []).sort();

describe('the region takes lifecycle reports only from its own shards (#1267)', () => {
  test('an EntityStarted off the wire does not enter the index, nor reach the coordinator', async () => {
    const victim = await startVictim('1267-region-started', 44_420);
    const evil = await attacker('evil-1267-region-started', 44_421);

    forge(evil, victim, victim.regionPath, started(SHARD, 'phantom'));
    // The assertion is an absence: give the region a turn to act on the forged
    // frame, then prove it did not.  A poll cannot express this — the
    // condition is already true at t=0 and must still hold later.
    await sleep(200);

    expect(victim.region().shardEntities.get(SHARD)?.has('phantom') ?? false).toBe(false);
    expect(victim.region().entityActivity.has('phantom')).toBe(false);
    expect(remembered(victim)).toEqual([ENTITY_ID]);
  });

  test('an EntityStopped off the wire does not make the region or the coordinator forget', async () => {
    const victim = await startVictim('1267-region-stopped', 44_422);
    const evil = await attacker('evil-1267-region-stopped', 44_423);

    forge(evil, victim, victim.regionPath, stopped(SHARD, ENTITY_ID));
    // Absence again: the forged stop must not have been applied after a turn.
    await sleep(200);

    expect(victim.region().shardEntities.get(SHARD)?.has(ENTITY_ID) ?? false).toBe(true);
    expect(remembered(victim)).toEqual([ENTITY_ID]);
  });

  test('a local report for a shard the region does not host, or out of range, is not indexed', async () => {
    const victim = await startVictim('1267-region-unhosted', 44_424);
    const unhosted = (SHARD + 1) % NUM_SHARDS;
    const resolved = victim.system._resolvePath(regionSegments(victim.system.name, TYPE_NAME));
    if (resolved.isNone()) throw new Error('region actor not found');

    resolved.value.tell(started(unhosted, 'elsewhere') as never);
    resolved.value.tell(started(NUM_SHARDS + 3, 'out-of-range') as never);
    // Absence: neither report may have been indexed after the region's turn.
    await sleep(200);

    expect(victim.region().shardEntities.has(unhosted)).toBe(false);
    expect(victim.region().shardEntities.has(NUM_SHARDS + 3)).toBe(false);
    expect(victim.region().entityActivity.has('elsewhere')).toBe(false);
    expect(victim.region().entityActivity.has('out-of-range')).toBe(false);
  });
});

describe('the coordinator takes lifecycle reports only from the shard\'s host (#1267)', () => {
  test('an EntityStarted from a member that does not host the shard is refused', async () => {
    const victim = await startVictim('1267-coordinator-started', 44_426);
    const evil = await attacker('evil-1267-coordinator-started', 44_427);

    forge(evil, victim, victim.coordinatorPath, started(SHARD, 'phantom'));
    forge(evil, victim, victim.coordinatorPath, stopped(SHARD, ENTITY_ID));
    await awaitCondition(
      () => victim.log.records.filter((r) => r.level === 'warn' && r.message.includes('does not host')).length >= 2,
      { timeoutMs: 4_000, label: 'both forged reports were refused' },
    );

    expect(remembered(victim)).toEqual([ENTITY_ID]);
  });

  test('from the host, an entity id that is empty, too long or not a string is refused', async () => {
    const victim = await startVictim('1267-coordinator-entity-id', 44_428);

    victim.tellCoordinatorAsHost(started(SHARD, ''));
    victim.tellCoordinatorAsHost(started(SHARD, 'x'.repeat(MAX_REMEMBERED_ENTITY_ID_LENGTH + 1)));
    victim.tellCoordinatorAsHost(started(SHARD, 42));
    // The control, behind the three: an id at the bound is taken.
    const longest = 'y'.repeat(MAX_REMEMBERED_ENTITY_ID_LENGTH);
    victim.tellCoordinatorAsHost(started(SHARD, longest));
    await awaitCondition(() => remembered(victim).includes(longest), {
      timeoutMs: 4_000,
      label: 'the coordinator handled every report',
    });

    expect(remembered(victim)).toEqual([ENTITY_ID, longest].sort());
  });

  test('a shard at the cap takes no further entity, and says so once', async () => {
    const victim = await startVictim('1267-coordinator-cap', 44_430);
    const entities = victim.coordinator().entitiesPerShard.get(SHARD)!;
    for (let index = entities.size; index < MAX_REMEMBERED_ENTITIES_PER_SHARD; index++) entities.add(`filler-${index}`);

    victim.tellCoordinatorAsHost(started(SHARD, 'one-too-many'));
    victim.tellCoordinatorAsHost(started(SHARD, 'two-too-many'));
    // A stop still lands at the cap, and makes room for the next start.
    victim.tellCoordinatorAsHost(stopped(SHARD, 'filler-1'));
    victim.tellCoordinatorAsHost(started(SHARD, 'fits-again'));
    await awaitCondition(() => entities.has('fits-again'), {
      timeoutMs: 4_000,
      label: 'the coordinator handled every report',
    });

    expect(entities.has('one-too-many')).toBe(false);
    expect(entities.has('two-too-many')).toBe(false);
    expect(entities.size).toBe(MAX_REMEMBERED_ENTITIES_PER_SHARD);
    const warnings = victim.log.records.filter((r) => r.level === 'warn' && r.message.includes('remembered entities'));
    expect(warnings).toHaveLength(1);
  });
});
