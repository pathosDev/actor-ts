/**
 * A ShardCoordinator credits the connection, not the payload (#712).
 *
 * Every coordinator-inbound sharding kind is a claim about the sender's *own*
 * node — which shards its region hosts, that its region is gone, that a hand-off
 * finished, where to send a shard home or a statistics reply — and the
 * coordinator read all of it out of the payload.  Its only gate was
 * `isLeader()` plus, with a lease, `leaseState === 'held'`, which answers "am I
 * the authoritative coordinator?" and never "may this sender speak for that
 * region?".  So one well-formed `sharding.Register` frame naming somebody else's
 * address seized every shard of a type, and one `sharding.RegionTerminated`
 * evicted its region — from anyone who could reach the leader's port.
 *
 * It could not have asked who sent it: sharding registered a per-path envelope
 * handler for the *region* (#584) and none for the coordinator, so a frame
 * addressed to the coordinator fell through to generic path resolution, which
 * resolves the path and delivers the raw body with no sender at all.
 *
 * The forging is done with a plain `InMemoryTransport` under an attacker
 * address, the same way `ShardingAuthority.test.ts` does it for the region side:
 * `send` stamps the *sending transport's* own address as the peer, so a frame the
 * victim receives from it is exactly what a hostile (or merely confused) peer
 * produces.  The precondition is only that the frame is well-formed —
 * `handleWire` applies no membership check to `envelope`, and wire validation
 * inspects an envelope's `to` and `from` and nothing about `body`.
 *
 * Every case runs against a live single-node cluster whose entity is up, and it
 * is up only because the coordinator accepted its *own* region's registration —
 * which now has to arrive attributed too.  So the setup of each test doubles as
 * the positive control for the local leg: if the gate refused everything,
 * `startVictim` would time out before any attack was sent.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import { SystemGroups, shardRegionName, systemActorPath } from '../../../../src/internal/SystemPaths.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { WireMessage } from '../../../../src/cluster/Protocol.js';
import { coordinatorSegments, regionSegments } from '../../../util/SystemPaths.js';
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
  coordinatorPath: string;
  shardId: number;
};

/**
 * The two maps the attack aims at.  Read straight off the actor instance
 * because they are the authoritative allocation state — asserting on a
 * downstream symptom would pass for a coordinator that recorded the forgery and
 * merely had nobody left to tell.
 */
type CoordinatorState = {
  readonly regions: Map<string, { readonly node: NodeAddress; readonly path: string; readonly shards: Set<number> }>;
  readonly shardHome: Map<number, string>;
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
 * A single-node cluster with one live entity.  Single node on purpose: this node
 * is its own leader, so the coordinator and the only legitimate region sit here
 * and every attacker address is a different one.
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
    coordinatorPath: systemActorPath(
      systemName, SystemGroups.clusterSharding, `coordinator-${TYPE_NAME}`,
    ),
    shardId: hashShardId(ENTITY_ID, NUM_SHARDS),
  };
  running = victim;

  region.tell({ id: ENTITY_ID, kind: 'work' });
  await awaitCondition(() => delivered === 1, {
    timeoutMs: 4_000,
    label: 'the entity came up, so the local region registered through the gate',
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

/**
 * A transport that only records what arrives — the reflection target for the
 * statistics arm, where the harm is the coordinator *dialling* an
 * attacker-named address rather than anything it writes down.
 */
async function recorder(name: string, port: number): Promise<{
  address: NodeAddress;
  received: WireMessage[];
}> {
  const address = new NodeAddress(name, 'h', port);
  const transport = new InMemoryTransport(address);
  const received: WireMessage[] = [];
  transport.setHandler((_from, message) => { received.push(message); });
  await transport.start();
  transports.push(transport);
  return { address, received };
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

function coordinatorState(victim: Victim): CoordinatorState {
  const resolved = victim.system._resolvePath(coordinatorSegments(victim.system.name, TYPE_NAME));
  if (resolved.isNone()) throw new Error('coordinator actor not found');
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  const actor = cell?.actor;
  if (!actor) throw new Error('coordinator cell holds no actor');
  return actor as CoordinatorState;
}

/** Every node the coordinator currently believes hosts a region for the type. */
function registeredNodes(victim: Victim): string[] {
  return Array.from(coordinatorState(victim).regions.values())
    .map((info) => info.node.toString())
    .sort();
}

function entityIsUp(victim: Victim): boolean {
  return victim.system._resolvePath([
    ...regionSegments(victim.system.name, TYPE_NAME),
    `shard-${victim.shardId}`,
    `entity-${ENTITY_ID}`,
  ]).isSome();
}

describe('ShardCoordinator sender authority (#712)', () => {
  test('the genuine local registration is recorded and homes the shard to itself', async () => {
    // The positive control, stated once explicitly.  Every other case depends on
    // it: the region's own `Register` is a bare local `tell` when the leader is
    // this node, so a gate that only accepted wire frames would break every
    // single-node and leader-hosted cluster instead of only the forgeries.
    const victim = await startVictim('coordinator-control', 47_360);
    const state = coordinatorState(victim);

    expect(registeredNodes(victim)).toEqual([victim.cluster.selfAddress.toString()]);
    const home = state.shardHome.get(victim.shardId);
    expect(home).toBeDefined();
    expect(state.regions.get(home!)?.path).toBe(victim.regionPath);
  });

  test('a forged Register naming another node does not seize the shard map', async () => {
    const victim = await startVictim('coordinator-register', 47_362);
    const evil = await attacker('evil-register', 47_363);

    // The whole finding in one frame: claim to be a region on a third address
    // and declare ownership of every shard of the type.  Before the gate the
    // coordinator wrote `shardHome` for all of them and answered every
    // subsequent `GetShardHome` with the attacker's region, so honest regions
    // forwarded entity commands — business payloads — to a node of the
    // attacker's choosing.
    forge(evil, victim, victim.coordinatorPath, {
      kind: 'sharding.Register',
      region: '/system/cluster/sharding/region-entity',
      node: new NodeAddress('ghost', 'attacker.example', 2_552).toJSON(),
      proxy: false,
      hostedShards: Array.from({ length: NUM_SHARDS }, (_unused, shardId) => shardId),
      numShards: NUM_SHARDS,
    });
    await sleep(200);

    expect(registeredNodes(victim)).toEqual([victim.cluster.selfAddress.toString()]);
    const state = coordinatorState(victim);
    const ownKey = state.shardHome.get(victim.shardId);
    expect(state.regions.get(ownKey!)?.node.toString()).toBe(victim.cluster.selfAddress.toString());

    // And routing is still local, which is what the seizure was for.
    victim.region.tell({ id: ENTITY_ID, kind: 'work' });
    await awaitCondition(() => delivered === 2, {
      timeoutMs: 4_000,
      label: 'the entity still takes traffic on its own node',
    });
  });

  test('a Register addressed non-canonically is refused even when it names its own sender', async () => {
    // `_envelopeHandlersByPath` is an exact-string lookup while
    // `parsePathSegments` filters empty segments, so a trailing slash misses the
    // coordinator's per-path handler and still resolves to the same actor through
    // the tree — arriving unwrapped, with no sender to compare against.
    // Registering the handler is therefore necessary but not sufficient:
    // refusing an unattributed frame is what closes the bypass, and this frame
    // would sail through a check that only compared `node` against a sender it
    // did not have.
    const victim = await startVictim('coordinator-bypass', 47_364);
    const evil = await attacker('evil-bypass', 47_365);

    forge(evil, victim, `${victim.coordinatorPath}/`, {
      kind: 'sharding.Register',
      region: '/forged',
      node: evil.self.toJSON(),
      proxy: false,
      hostedShards: Array.from({ length: NUM_SHARDS }, (_unused, shardId) => shardId),
      numShards: NUM_SHARDS,
    });
    await sleep(200);

    expect(registeredNodes(victim)).toEqual([victim.cluster.selfAddress.toString()]);
  });

  test('a forged RegionTerminated does not evict the victim region', async () => {
    const victim = await startVictim('coordinator-terminated', 47_366);
    const evil = await attacker('evil-terminated', 47_367);

    // `onRegionTerminated` sends no `HandOff`, so the victim keeps its shard
    // actors and its entities — the outcome of an accepted forgery is a second
    // owner for a live shard, not a clean stop.
    forge(evil, victim, victim.coordinatorPath, {
      kind: 'sharding.RegionTerminated',
      region: victim.regionPath,
      node: victim.cluster.selfAddress.toJSON(),
    });
    await sleep(200);

    expect(registeredNodes(victim)).toEqual([victim.cluster.selfAddress.toString()]);
    expect(coordinatorState(victim).shardHome.get(victim.shardId)).toBeDefined();
    expect(entityIsUp(victim)).toBe(true);
  });

  test('a forged GetClusterShardingStats does not make the coordinator dial the named address', async () => {
    // The arm the issue body omits.  A statistics query is answered at the
    // address in its own payload, through `replyTo` → `Cluster._sendEnvelope` →
    // `transport.send`, none of which consults membership — so a frame naming a
    // third party turns the coordinator into a reflector that fans out to every
    // region first and then dials whoever the payload named.
    const victim = await startVictim('coordinator-stats', 47_368);
    const evil = await attacker('evil-stats', 47_369);
    const reflected = await recorder('ghost-stats', 47_370);

    forge(evil, victim, victim.coordinatorPath, {
      kind: 'sharding.GetClusterShardingStats',
      correlationId: 1,
      requester: '/forged',
      requesterNode: reflected.address.toJSON(),
      timeoutMs: 100,
    });
    await sleep(400);

    expect(reflected.received).toEqual([]);
  });

  test('a self-registered hostedShards claim is bounded and capped', async () => {
    // The second half of the finding, and the half a `from`-equality check does
    // *not* close: a peer registering its own region passes the identity gate,
    // and `hostedShards` is still an unverified self-declaration.  It was also
    // the only caller-*sized* input the coordinator had — one frame wrote a
    // `shardHome` entry per array element, into state that is broadcast to every
    // region and persisted to the coordinator-state store, so the growth
    // survived restarts.
    const victim = await startVictim('coordinator-hosted', 47_372);
    const evil = await attacker('evil-hosted', 47_373);

    const outOfRange = [
      ...Array.from({ length: 4_000 }, () => NUM_SHARDS + 3),
      -1, NUM_SHARDS, 1.5, null, '2',
    ];
    forge(evil, victim, victim.coordinatorPath, {
      kind: 'sharding.Register',
      region: '/self-declared',
      node: evil.self.toJSON(),
      // A proxy so the claim exercises the `hostedShards` write path without
      // also becoming an allocation candidate — placement is a separate
      // question, and #948 owns the live-owner conflict this still leaves open.
      proxy: true,
      hostedShards: [
        ...outOfRange,
        // Twice as many in-range ids as there are shards, so the accepted set
        // has to dedupe as well as bound.
        0, 1, 2, 3, 0, 1, 2, 3,
        ...Array.from({ length: 4_000 }, () => -2),
      ],
      numShards: NUM_SHARDS,
    });
    await sleep(300);

    const state = coordinatorState(victim);
    const claimant = Array.from(state.regions.values())
      .find((info) => info.path === '/self-declared');
    // The identity gate lets this one in — it speaks for itself.
    expect(claimant).toBeDefined();
    expect(Array.from(claimant!.shards).sort((a, b) => a - b))
      .toEqual([0, 1, 2, 3]);

    // Nothing outside `0..numShards-1` reached the allocation map, and it cannot
    // have grown past one entry per shard.
    const homedIds = Array.from(state.shardHome.keys());
    expect(homedIds.length).toBeLessThanOrEqual(NUM_SHARDS);
    for (const shardId of homedIds) {
      expect(Number.isInteger(shardId)).toBe(true);
      expect(shardId).toBeGreaterThanOrEqual(0);
      expect(shardId).toBeLessThan(NUM_SHARDS);
    }
  });
});
