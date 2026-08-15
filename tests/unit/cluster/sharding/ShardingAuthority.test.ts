/**
 * A ShardRegion credits the connection, not the `kind` string (#584).
 *
 * The region used to treat any frame whose `kind` started with `sharding.` as a
 * framework directive.  Four of those kinds are things only the coordinator may
 * say — `HandOff` stops every entity under a shard, `ShardHome` moves
 * ownership, `RememberedEntities` pre-creates entities, `ShardMapUpdate`
 * publishes an allocation map to every local subscriber — and the region
 * honoured all of them without ever asking who sent it.  It could not have
 * asked: sharding registered no per-path envelope handler, so an inbound frame
 * reached the actor through generic path resolution, which delivers with no
 * sender at all.
 *
 * The forging is done with a plain `InMemoryTransport` under an attacker
 * address, the same way `tests/unit/crdt/DistributedDataAuthority.test.ts`
 * does it: `send` stamps the *sending transport's* own address as the peer, so
 * a frame the victim's region receives from it is exactly what a hostile (or
 * merely confused) peer produces.  The precondition is only that the frame is
 * well-formed — `handleWire` applies no membership check to `envelope`.
 *
 * Every case below needs a live shard to attack, and that shard exists only
 * because the *coordinator's* own frames are accepted — the local leg of
 * `ShardCoordinator.replyTo` builds the same wrapper the gate demands.  So the
 * setup of each test doubles as the positive control: if the gate refused
 * everything, `entityIsUp` would already be false before the attack.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { ShardMapChanged } from '../../../../src/cluster/ClusterEvents.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import { SystemGroups, shardRegionName, systemActorPath } from '../../../../src/internal/SystemPaths.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { WireMessage } from '../../../../src/cluster/Protocol.js';
import { regionSegments } from '../../../util/SystemPaths.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type WorkCommand = { id: string; kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';
const NUM_SHARDS = 4;
const ENTITY_ID = 'user-1';

let delivered = 0;

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { delivered++; }
}

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

type Victim = {
  system: ActorSystem;
  cluster: Cluster;
  region: ReturnType<Cluster['sharding']['start']>;
  regionPath: string;
  shardId: number;
  mapEvents: ShardMapChanged[];
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

/**
 * A single-node cluster with one live entity.  Single node on purpose: this
 * node is its own leader, so the coordinator's node — the one origin the
 * region accepts — is the victim's own address, and every attacker address is
 * therefore a different one.
 */
async function startVictim(systemName: string, port: number): Promise<Victim> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);

  const mapEvents: ShardMapChanged[] = [];
  cluster.subscribe((event) => { if (event instanceof ShardMapChanged) mapEvents.push(event); });

  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    // A sweep firing mid-test would take the entity down for its own reasons.
    .withPassivationIdleMs(0);
  const region = cluster.sharding.start<Command>(shardingOptions);

  const victim: Victim = {
    system,
    cluster,
    region: region as Victim['region'],
    regionPath: systemActorPath(systemName, SystemGroups.clusterSharding, shardRegionName(TYPE_NAME)),
    shardId: hashShardId(ENTITY_ID, NUM_SHARDS),
    mapEvents,
  };
  running = victim;

  region.tell({ id: ENTITY_ID, kind: 'work' });
  await awaitCondition(() => delivered === 1, {
    timeoutMs: 4_000,
    label: 'the entity came up on a genuine coordinator ShardHome',
  });
  return victim;
}

/** A bare transport that speaks the wire under its own identity. */
async function attacker(name: string, port: number): Promise<InMemoryTransport> {
  const transport = new InMemoryTransport(new NodeAddress(name, 'h', port));
  transport.setHandler(() => { /* the attacker ignores replies */ });
  await transport.start();
  transports.push(transport);
  return transport;
}

/** Post a forged sharding frame to `to` on the victim, under the attacker's address. */
function forge(from: InMemoryTransport, victim: Victim, to: string, body: unknown): void {
  from.send(victim.cluster.selfAddress, {
    kind: 'envelope',
    to,
    from: null,
    body,
  } as unknown as WireMessage);
}

function actorIsUp(victim: Victim, ...tail: string[]): boolean {
  return victim.system._resolvePath([
    ...regionSegments(victim.system.name, TYPE_NAME),
    ...tail,
  ]).isSome();
}

function entityIsUp(victim: Victim, entityId = ENTITY_ID): boolean {
  return actorIsUp(victim, `shard-${victim.shardId}`, `entity-${entityId}`);
}

describe('ShardRegion coordinator authority (#584)', () => {
  test('a forged HandOff does not tear the shard down', async () => {
    const victim = await startVictim('authority-handoff', 47_310);
    expect(entityIsUp(victim)).toBe(true);

    const evil = await attacker('evil', 47_311);
    forge(evil, victim, victim.regionPath, { kind: 'sharding.HandOff', shardId: victim.shardId });
    await sleep(200);

    // The whole finding in one assertion: one 100-byte frame used to stop every
    // entity under a shard, repeatably, from anyone who could reach the port.
    expect(entityIsUp(victim)).toBe(true);
    victim.region.tell({ id: ENTITY_ID, kind: 'work' });
    await awaitCondition(() => delivered === 2, {
      timeoutMs: 4_000,
      label: 'the surviving entity still takes traffic',
    });
  });

  test('a HandOff addressed non-canonically is refused too', async () => {
    // `_envelopeHandlersByPath` is an exact-string lookup while `parsePathSegments`
    // filters empty segments, so a trailing slash misses the new per-path handler
    // and still resolves to the same region through the actor tree — arriving
    // unwrapped.  Registering the handler is therefore necessary but not
    // sufficient; refusing an unwrapped directive is what closes it.
    const victim = await startVictim('authority-bypass', 47_320);
    const evil = await attacker('evil-bypass', 47_321);

    forge(evil, victim, `${victim.regionPath}/`, { kind: 'sharding.HandOff', shardId: victim.shardId });
    await sleep(200);

    expect(entityIsUp(victim)).toBe(true);
  });

  test('a forged ShardHome does not move the shard to the attacker', async () => {
    const victim = await startVictim('authority-home', 47_330);
    const evil = await attacker('evil-home', 47_331);

    forge(evil, victim, victim.regionPath, {
      kind: 'sharding.ShardHome',
      shardId: victim.shardId,
      region: '/system/cluster/sharding/region-entity',
      node: new NodeAddress('evil-home', 'h', 47_331).toJSON(),
    });
    await sleep(200);

    // Had the region adopted it, routing would leave the node: the tell would
    // be forwarded to the attacker instead of the local entity.
    victim.region.tell({ id: ENTITY_ID, kind: 'work' });
    await awaitCondition(() => delivered === 2, {
      timeoutMs: 4_000,
      label: 'routing still resolves the shard locally',
    });
    expect(entityIsUp(victim)).toBe(true);
  });

  test('a forged RememberedEntities does not conjure entities', async () => {
    const victim = await startVictim('authority-remember', 47_340);
    const evil = await attacker('evil-remember', 47_341);

    forge(evil, victim, victim.regionPath, {
      kind: 'sharding.RememberedEntities',
      shardId: victim.shardId,
      entityIds: ['ghost-1', 'ghost-2'],
    });
    await sleep(200);

    expect(entityIsUp(victim, 'ghost-1')).toBe(false);
    expect(entityIsUp(victim, 'ghost-2')).toBe(false);
  });

  test('a forged ShardMapUpdate is not published to local subscribers', async () => {
    // This arm is the one the issue body omits.  The region turns a
    // ShardMapUpdate into a cluster-wide-looking `ShardMapChanged` on every
    // local listener — the DevTools panel and any application subscriber — so a
    // forged frame writes an attacker-authored allocation map into all of them.
    const victim = await startVictim('authority-map', 47_350);
    const evil = await attacker('evil-map', 47_351);

    forge(evil, victim, victim.regionPath, {
      kind: 'sharding.ShardMapUpdate',
      typeName: 'forged-type',
      version: 9_999,
      shards: [[0, 'evil-map@h:47351|/forged']],
      regions: [{
        key: 'evil-map@h:47351|/forged',
        address: 'evil-map@h:47351',
        path: '/forged',
        proxy: false,
        shardCount: 1,
      }],
    });
    await sleep(200);

    // The coordinator's own broadcasts still arrive, so assert on the forgery
    // rather than on the absence of events.
    expect(victim.mapEvents.map((event) => event.type)).not.toContain('forged-type');
  });
});
