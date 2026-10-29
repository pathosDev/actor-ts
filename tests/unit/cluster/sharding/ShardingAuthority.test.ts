/**
 * A ShardRegion credits the connection, not the `kind` string (#584).
 *
 * The region used to treat any frame whose `kind` started with `sharding.` as a
 * framework directive.  Five of those kinds are things only the coordinator may
 * say — `HandOff` stops every entity under a shard, `ShardHome` moves
 * ownership, `RememberedEntities` pre-creates entities, `ShardMapUpdate`
 * publishes an allocation map to every local subscriber, and `RegionEvicted`
 * (#853) drops *every* shard the region holds — and the region honoured all of
 * them without ever asking who sent it.  It could not have asked: sharding
 * registered no per-path envelope handler, so an inbound frame reached the
 * actor through generic path resolution, which delivers with no sender at all.
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
import {
  AuthenticatedShardingMessage,
  type ShardingMessage,
} from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { SystemGroups, shardRegionName, systemActorPath } from '../../../../src/internal/SystemPaths.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import type { WireMessage } from '../../../../src/cluster/Protocol.js';
import { coordinatorSegments, regionSegments } from '../../../util/SystemPaths.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';

type WorkCommand = { id: string; kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';
const NUM_SHARDS = 4;
const ENTITY_ID = 'user-1';

let delivered = 0;

/**
 * While set, every entity's `postStop` waits on it — how a case holds a
 * shard's stop open.  Opened and cleared after every case.
 */
let entityStopGate: Promise<void> | null = null;
let openEntityStops: () => void = () => { /* nothing is held */ };

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  override async postStop(): Promise<void> {
    if (entityStopGate !== null) await entityStopGate;
  }

  private onWork(): void { delivered++; }
}

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
  openEntityStops();
  entityStopGate = null;
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

/**
 * Hand the region a directive the way its own coordinator would — wrapped, and
 * from the node the region accepts as the coordinator's.
 *
 * The ownership cases below need a frame that *passes* the origin gate, because
 * what they pin is the precondition sitting behind it: a directive can be
 * perfectly authentic and still be a duplicate, or name a shard this region does
 * not have.  Single node, so the coordinator's node is this one.
 */
function tellAsCoordinator(victim: Victim, message: ShardingMessage): void {
  const resolved = victim.system._resolvePath(regionSegments(victim.system.name, TYPE_NAME));
  if (resolved.isNone()) throw new Error('region actor not found');
  (resolved.value as ActorRef<ShardingMessage | AuthenticatedShardingMessage>)
    .tell(new AuthenticatedShardingMessage(victim.cluster.selfAddress, message));
}

/**
 * The region's routing cache and ownership sets, read straight off the actor
 * instance.
 *
 * A stray `HandOff` evicts cache entries and nothing else observable happens —
 * the `HandOffComplete` it emits is discarded by a coordinator with no rebalance
 * in flight — so asserting on a downstream symptom would pass for a region that
 * threw the cache away and merely had nothing to route yet.
 */
type RegionState = {
  readonly shardHomes: Map<number, string>;
  readonly shardHomeNodes: Map<number, NodeAddress>;
  readonly localShards: Set<number>;
};

function regionState(victim: Victim): RegionState {
  const resolved = victim.system._resolvePath(regionSegments(victim.system.name, TYPE_NAME));
  if (resolved.isNone()) throw new Error('region actor not found');
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  const actor = cell?.actor;
  if (!actor) throw new Error('region cell holds no actor');
  return actor as RegionState;
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
    // The assertion is an absence: give the region a turn to act on the forged
    // frame, then prove it did not.  A poll cannot express this — the condition
    // is already true at t=0 and must still hold later.
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
    // The assertion is an absence: give the region a turn to act on the forged
    // frame, then prove it did not.  A poll cannot express this — the condition
    // is already true at t=0 and must still hold later.
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
    // The assertion is an absence: the routing cache must be unchanged, so the
    // forged frame only gets a turn.  A poll cannot express that — the shard
    // already resolves locally at t=0 and has to still resolve locally later.
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
    // The assertion is an absence: the two ghosts must never exist, so the
    // forged frame only gets a turn.  A poll cannot express that — the
    // condition is already true at t=0 and must still hold later.
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
    // The assertion is an absence: no `ShardMapChanged` for the forged type may
    // ever reach a local subscriber, so the forged frame only gets a turn.  A
    // poll cannot express that — the condition holds at t=0 and must hold later.
    await sleep(200);

    // The coordinator's own broadcasts still arrive, so assert on the forgery
    // rather than on the absence of events.
    expect(victim.mapEvents.map((event) => event.type)).not.toContain('forged-type');
  });

  test('a forged RegionEvicted does not empty the region', async () => {
    // The most destructive kind on the list, and the newest (#853): honoured,
    // it drops *every* shard this region holds — not one, as `HandOff` does —
    // stops every entity beneath them, and throws away the whole routing cache.
    // One 90-byte frame per node, and the type is dark for as long as the
    // re-registration takes.
    const victim = await startVictim('authority-evicted', 47_360);
    expect(entityIsUp(victim)).toBe(true);
    const evil = await attacker('evil-evicted', 47_361);

    forge(evil, victim, victim.regionPath, {
      kind: 'sharding.RegionEvicted',
      coordinator: '/system/cluster/sharding/coordinator-entity',
      silentForMs: 60_000,
    });
    // The assertion is an absence: give the region a turn to act on the forged
    // frame, then prove it did not.  A poll cannot express this — the condition
    // is already true at t=0 and must still hold later.
    await sleep(200);

    expect(entityIsUp(victim)).toBe(true);
    expect(regionState(victim).localShards.has(victim.shardId)).toBe(true);
    victim.region.tell({ id: ENTITY_ID, kind: 'work' });
    await awaitCondition(() => delivered === 2, {
      timeoutMs: 4_000,
      label: 'the region still owns its shard and routes to it',
    });
  });

  test('a forged RegistrationRequest does not make the region register again', async () => {
    // The mildest kind on the list (#853): honoured, it only makes the region
    // repeat its registration to its own coordinator.  Still a directive, and
    // still the coordinator's alone — anybody else could make every region of
    // a type re-register on demand.  The coordinator stamps an entry each time
    // its region registers, and nothing else in this idle fixture touches it,
    // so an unchanged stamp is a registration that did not happen.
    const victim = await startVictim('authority-registration-request', 62_160);
    const evil = await attacker('evil-registration-request', 62_161);
    const registeredAt = (): number | undefined => coordinatorEntry(victim)?.lastSeenAtMs;
    const before = registeredAt();
    expect(before).toBeDefined();
    const request = { kind: 'sharding.RegistrationRequest', coordinator: '/system/cluster/sharding/coordinator-entity' };

    forge(evil, victim, victim.regionPath, request);
    await awaitCondition(() => registeredAt() !== before, {
      timeoutMs: 300,
      intervalMs: 10,
      label: 'a registration answering the forged request (not expected)',
    }).then(
      () => { throw new Error('the region registered again on a forged request'); },
      () => { /* the window ran out with nothing registered */ },
    );

    // The positive control, so the stamp is known to move: the same request
    // from the coordinator's own node is answered.
    tellAsCoordinator(victim, request as ShardingMessage);
    await awaitCondition(() => registeredAt() !== before, {
      timeoutMs: 4_000,
      label: 'the region registered again when its own coordinator asked',
    });
  });
});

/** The coordinator's registry entry for the victim's own region. */
function coordinatorEntry(victim: Victim): { readonly lastSeenAtMs: number } | undefined {
  const resolved = victim.system._resolvePath(coordinatorSegments(victim.system.name, TYPE_NAME));
  if (resolved.isNone()) return undefined;
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  const regions = (cell?.actor as { regions?: Map<string, { lastSeenAtMs: number }> } | undefined)?.regions;
  return regions === undefined ? undefined : Array.from(regions.values())[0];
}

describe('ShardRegion handoff ownership (#584)', () => {
  test('an authentic HandOff for a shard this region does not own changes nothing', async () => {
    // The criterion the origin gate does *not* cover.  `onHandOff` had no
    // ownership or idempotence precondition, so a duplicate or late `HandOff` —
    // authentic, from the coordinator's own node, which is what `Transport`
    // flushes when frames buffered before a handshake finally go out — marked the
    // shard `'handing-off'`, acknowledged it, and, finding no shard actor to
    // stop, fell straight into `completeHandOff`.  That deletes `shardHomes` and
    // `shardHomeNodes` for the id: a routing-cache eviction for a shard the
    // region was never handing off, repeatable across every id in range.
    const victim = await startVictim('authority-handoff-unowned', 47_380);
    const elsewhere = new NodeAddress('handoff-elsewhere', 'h', 47_381);
    const elsewhereRegion = '/system/cluster/sharding/region-entity';
    const remoteShardId = (victim.shardId + 1) % NUM_SHARDS;

    // A genuine placement first: this shard lives on another node, so the region
    // caches where to forward and does *not* add it to `localShards`.
    tellAsCoordinator(victim, {
      kind: 'sharding.ShardHome',
      shardId: remoteShardId,
      region: elsewhereRegion,
      node: elsewhere.toJSON(),
    });
    await awaitCondition(
      () => regionState(victim).shardHomes.get(remoteShardId) === elsewhereRegion,
      { timeoutMs: 4_000, label: 'the region cached the remote home' },
    );
    expect(regionState(victim).localShards.has(remoteShardId)).toBe(false);
    const heardBefore = coordinatorEntry(victim)?.lastSeenAtMs;

    tellAsCoordinator(victim, { kind: 'sharding.HandOff', shardId: remoteShardId });
    // The assertion is an absence: give the region a turn to act on the
    // directive, then prove it did not. A poll cannot express this — the
    // condition is already true at t=0 and must still hold later.
    await sleep(200);

    const state = regionState(victim);
    expect(state.shardHomes.get(remoteShardId)).toBe(elsewhereRegion);
    expect(state.shardHomeNodes.get(remoteShardId)?.toString()).toBe(elsewhere.toString());
    // And the shard the region really does own is untouched by the refusal.
    expect(entityIsUp(victim)).toBe(true);
    // Nor did it answer: a registered region that does not own the shard may
    // be mid-way through handing it off, and only a refused one holds nothing
    // by construction (#1467).  An answer would have stamped its entry.
    expect(coordinatorEntry(victim)?.lastSeenAtMs).toBe(heardBefore);
  });

  test('a refused region answers a HandOff once the shard it is releasing has stopped', async () => {
    // A refused region holds nothing once its release is through, so it answers
    // every `HandOff` with `HandOffComplete` (#1467).  But a shard it was hosting
    // when the refusal came is stopped asynchronously, each entity's `postStop`
    // included, and until that finishes the shard still runs here: an answer
    // then would let the coordinator start the shard elsewhere while its
    // entities here are still flushing.  The stop is held open below, and the
    // coordinator's stamp on this region's entry is the witness that an answer
    // went out — nothing else in this idle fixture touches it.
    const victim = await startVictim('authority-refused-hand-off', 62_162);
    const heardBefore = coordinatorEntry(victim)?.lastSeenAtMs;
    entityStopGate = new Promise<void>((resolve) => { openEntityStops = resolve; });

    tellAsCoordinator(victim, {
      kind: 'sharding.RegisterRefused',
      coordinator: '/system/cluster/sharding/coordinator-entity',
      numShards: NUM_SHARDS * 2,
      regionNumShards: NUM_SHARDS,
    });
    tellAsCoordinator(victim, { kind: 'sharding.HandOff', shardId: victim.shardId });
    await awaitCondition(() => coordinatorEntry(victim)?.lastSeenAtMs !== heardBefore, {
      timeoutMs: 300,
      intervalMs: 10,
      label: 'an answer while the shard was still stopping (not expected)',
    }).then(
      () => { throw new Error('the refused region answered before its shard had stopped'); },
      () => { /* the window ran out with no answer */ },
    );

    openEntityStops();
    await awaitCondition(() => coordinatorEntry(victim)?.lastSeenAtMs !== heardBefore, {
      timeoutMs: 4_000,
      label: 'the refused region answered once the shard had stopped',
    });
    expect(entityIsUp(victim)).toBe(false);
  });

  test('an authentic HandOff for the shard this region owns still hands it off', async () => {
    // The control that makes the case above a discrimination rather than a ban:
    // the precondition reads `localShards`, so a shard this region genuinely
    // owns still goes, entities and all.  Without this, refusing every `HandOff`
    // would pass the case above and break rebalancing outright.
    const victim = await startVictim('authority-handoff-owned', 47_390);
    expect(regionState(victim).localShards.has(victim.shardId)).toBe(true);
    expect(entityIsUp(victim)).toBe(true);

    tellAsCoordinator(victim, { kind: 'sharding.HandOff', shardId: victim.shardId });
    await awaitCondition(() => !entityIsUp(victim), {
      timeoutMs: 4_000,
      label: 'the owned shard handed off and took its entity down',
    });
  });
});
