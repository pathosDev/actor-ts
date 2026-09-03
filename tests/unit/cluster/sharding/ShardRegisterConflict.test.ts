/**
 * A `Register` is a claim, and the coordinator adjudicates it (#948).
 *
 * `hostedShards` is a region's statement about itself.  #712 made the *sender*
 * honest — the frame arrives attributed to the peer and its ids are range-
 * checked, deduped and capped — and left the *claim* adopted unconditionally:
 * `onRegister` wrote `shardHome[N] = claimant` for every id in the array with no
 * read of the current owner.  So a region whose `localShards` had gone stale
 * took its old shards back from whoever had taken over, and both nodes ran the
 * same entity ids — two writers on one `persistenceId` for a `PersistentActor`.
 *
 * Nothing clears a region's `localShards` when its node is downed by a false
 * positive (`invalidateHomesOnNode` deliberately leaves it alone) and
 * `ensureRegistered()` re-sends the claim on every `MemberUp`, `MemberRemoved`
 * and `LeaderChanged` plus a 500 ms retry, so the stale claim is not a rare
 * race — it is what a re-admitted node says as its first word.
 *
 * The same handler carried the inverse bug, which the issue missed:
 * `regions.set(key, { shards: new Set(hostedShards) })` *replaced* the entry, so
 * a `Register` that crossed an in-flight `ShardHome` dropped the shard from
 * `RegionInfo.shards` while `shardHome` still named the region — after which
 * `onRegionTerminated` (which iterates `info.shards`) never reallocated it.
 *
 * The harness is `ShardCoordinatorAuthority.test.ts`'s: a single-node victim
 * whose own region legitimately owns a shard, and a second address speaking the
 * wire under its own identity through a bare `InMemoryTransport`.  Its frames
 * are *genuine*, not forged — a region is entitled to register itself, which is
 * exactly why the identity gate cannot help here.  Coordinator state is read off
 * the actor instance because it is the authoritative allocation map; a
 * downstream symptom would pass for a coordinator that recorded the claim and
 * merely had nobody left to tell.
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
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';

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

type Victim = {
  system: ActorSystem;
  cluster: Cluster;
  region: ReturnType<Cluster['sharding']['start']>;
  regionPath: string;
  coordinatorPath: string;
  /** The shard the victim's own region legitimately owns. */
  shardId: number;
};

/**
 * The three maps a claim can corrupt.  `rebalanceInProgress` is here because the
 * conflict directive must deliberately *not* appear in it: that map's timeout
 * callback deletes `shardHome[shardId]` and reallocates, which over a conflict
 * release would destroy the true owner's ownership on a timer.
 */
type RegionInfo = {
  readonly node: NodeAddress;
  readonly path: string;
  readonly proxy: boolean;
  readonly shards: Set<number>;
};

type CoordinatorState = {
  readonly regions: Map<string, RegionInfo>;
  readonly shardHome: Map<number, string>;
  readonly rebalanceInProgress: Map<number, { readonly from: string }>;
};

/** A second node speaking the wire under its own identity, and recording replies. */
type Claimant = {
  readonly transport: InMemoryTransport;
  readonly address: NodeAddress;
  readonly regionPath: string;
  readonly received: WireMessage[];
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
 * A single-node cluster with one live entity, so this node is its own leader and
 * the only legitimate region for the type sits on it.
 *
 * The strategy-driven rebalance tick is pushed out of the run deliberately: a
 * second non-proxy candidate joining makes `HashAllocationStrategy.rebalance`
 * want to move half the map, and a `HandOff` from *that* would be
 * indistinguishable from the conflict release these tests are about.
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
    .withRebalanceIntervalMs(600_000)
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
    label: 'the entity came up, so the local region owns its shard',
  });
  return victim;
}

async function claimant(name: string, port: number): Promise<Claimant> {
  const address = new NodeAddress(name, 'h', port);
  const transport = new InMemoryTransport(address);
  const received: WireMessage[] = [];
  transport.setHandler((_from, message) => { received.push(message); });
  await transport.start();
  transports.push(transport);
  return {
    transport,
    address,
    regionPath: systemActorPath(name, SystemGroups.clusterSharding, shardRegionName(TYPE_NAME)),
    received,
  };
}

/** Post a sharding frame to the victim's coordinator under the claimant's own address. */
function post(from: Claimant, victim: Victim, body: unknown): void {
  from.transport.send(victim.cluster.selfAddress, {
    kind: 'envelope',
    to: victim.coordinatorPath,
    from: null,
    body,
  } as unknown as WireMessage);
}

function register(from: Claimant, victim: Victim, hostedShards: number[], proxy = false): void {
  post(from, victim, {
    kind: 'sharding.Register',
    region: from.regionPath,
    node: from.address.toJSON(),
    proxy,
    hostedShards,
    numShards: NUM_SHARDS,
  });
}

function coordinatorState(victim: Victim): CoordinatorState {
  const resolved = victim.system._resolvePath(coordinatorSegments(victim.system.name, TYPE_NAME));
  if (resolved.isNone()) throw new Error('coordinator actor not found');
  const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
  const actor = cell?.actor;
  if (!actor) throw new Error('coordinator cell holds no actor');
  return actor as CoordinatorState;
}

/** The coordinator's `[key, RegionInfo]` for a region path, or `undefined`. */
function regionEntry(victim: Victim, path: string): [string, RegionInfo] | undefined {
  return Array.from(coordinatorState(victim).regions.entries())
    .find(([, info]) => info.path === path);
}

/** The kinds the claimant's node was sent, in arrival order. */
function receivedKinds(from: Claimant): string[] {
  return from.received
    .map((message) => (message as { body?: { kind?: unknown } }).body?.kind)
    .filter((kind): kind is string => typeof kind === 'string');
}

/** Every shard id the claimant was told to give up, in arrival order. */
function handedOff(from: Claimant): number[] {
  return from.received
    .map((message) => (message as { body?: { kind?: unknown; shardId?: unknown } }).body)
    .filter((body): body is { kind: string; shardId: number } =>
      !!body && body.kind === 'sharding.HandOff' && typeof body.shardId === 'number')
    .map((body) => body.shardId);
}

function entityIsUp(victim: Victim): boolean {
  return victim.system._resolvePath([
    ...regionSegments(victim.system.name, TYPE_NAME),
    `shard-${victim.shardId}`,
    `entity-${ENTITY_ID}`,
  ]).isSome();
}

/** Ids in range that the victim's own region does not own. */
function freeShards(victim: Victim): number[] {
  return Array.from({ length: NUM_SHARDS }, (_unused, shardId) => shardId)
    .filter((shardId) => shardId !== victim.shardId);
}

describe('ShardCoordinator register conflict (#948)', () => {
  test('a claim on a live owner\'s shard does not move it, and the rest of the claim is honoured', async () => {
    const victim = await startVictim('register-conflict-owned', 47_460);
    const stale = await claimant('register-conflict-stale', 47_461);
    const free = freeShards(victim);

    // What a node re-admitted after a false-positive downing says: everything it
    // used to host, including the shard somebody else has taken over.
    register(stale, victim, [victim.shardId, ...free]);
    await awaitCondition(() => regionEntry(victim, stale.regionPath) !== undefined, {
      label: 'the claimant was registered',
    });

    const state = coordinatorState(victim);
    const claimantEntry = regionEntry(victim, stale.regionPath)!;
    const ownerEntry = regionEntry(victim, victim.regionPath)!;

    // Criterion 1: ownership did not move.
    expect(state.shardHome.get(victim.shardId)).toBe(ownerEntry[0]);

    // Criterion 4, both directions: the claimant does not record the shard it
    // lost the argument about, and the true owner did not lose it from its own
    // `RegionInfo.shards` — which `currentShardCounts()` and
    // `onRegionTerminated` both read.
    expect(claimantEntry[1].shards.has(victim.shardId)).toBe(false);
    expect(ownerEntry[1].shards.has(victim.shardId)).toBe(true);

    // And the positive half of the same claim: unowned ids are still adopted,
    // so adjudicating a claim is not the same as refusing it.
    expect(Array.from(claimantEntry[1].shards).sort((a, b) => a - b)).toEqual(free);
    for (const shardId of free) expect(state.shardHome.get(shardId)).toBe(claimantEntry[0]);

    // The entity the claim would have double-homed is still the victim's alone.
    victim.region.tell({ id: ENTITY_ID, kind: 'work' });
    await awaitCondition(() => delivered === 2, {
      timeoutMs: 4_000,
      label: 'the entity still takes traffic on its own node',
    });
  });

  test('the colliding claimant is told to stop its copy, after its registration is acknowledged', async () => {
    const victim = await startVictim('register-conflict-handoff', 47_462);
    const stale = await claimant('register-conflict-handoff-peer', 47_463);

    register(stale, victim, [victim.shardId]);
    await awaitCondition(() => handedOff(stale).includes(victim.shardId), {
      label: 'the claimant was told to hand the colliding shard off',
    });

    // A `HandOff` and not a bare authoritative `ShardHome`: the region's
    // `onShardHome` remote branch only forgets the id and leaves the `Shard`
    // actor and its entities running (#953), while `onHandOff` stops them — so
    // this is the frame that makes the release real rather than bookkeeping.
    expect(handedOff(stale)).toEqual([victim.shardId]);

    // Order matters.  The acknowledgment is what cancels the claimant's 500 ms
    // register retry, so a directive that overtakes it lands on a region still
    // re-registering.
    const kinds = receivedKinds(stale);
    expect(kinds.indexOf('sharding.RegisterAcknowledgment')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('sharding.RegisterAcknowledgment'))
      .toBeLessThan(kinds.indexOf('sharding.HandOff'));
  });

  test('a first registration of unowned shards is adopted whole', async () => {
    // The positive control, and the one case that must not move: the conflict
    // check may only refuse a claim the map already answers differently.  A
    // region joining an empty part of the map still gets everything it asks for.
    const victim = await startVictim('register-conflict-adopt', 47_464);
    const fresh = await claimant('register-conflict-adopt-peer', 47_465);
    const free = freeShards(victim);

    register(fresh, victim, free);
    await awaitCondition(() => regionEntry(victim, fresh.regionPath) !== undefined, {
      label: 'the new region was registered',
    });

    const state = coordinatorState(victim);
    const entry = regionEntry(victim, fresh.regionPath)!;
    expect(Array.from(entry[1].shards).sort((a, b) => a - b)).toEqual(free);
    for (const shardId of free) expect(state.shardHome.get(shardId)).toBe(entry[0]);
    expect(handedOff(fresh)).toEqual([]);
  });

  test('a claim that omits a shard the coordinator already assigned to it does not orphan the shard', async () => {
    // The inverse bug.  `tryAllocate` writes `shardHome[N] = K` and
    // `K.shards.add(N)` and only *then* pushes `ShardHome` at K, so a `Register`
    // already in flight carries a `localShards` without N.  Replacing the entry
    // dropped N from `RegionInfo.shards` while `shardHome` still named K — and
    // `onRegionTerminated` iterates `info.shards`, so N was never reallocated
    // and `snapshotCoordinatorState` persisted the hole.
    const victim = await startVictim('register-conflict-merge', 47_466);
    const region = await claimant('register-conflict-merge-peer', 47_467);
    const [first, second] = freeShards(victim);
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    register(region, victim, [first!]);
    await awaitCondition(
      () => regionEntry(victim, region.regionPath)?.[1].shards.has(first!) === true,
      { label: 'the first claim was adopted' },
    );

    // The second registration omits `first` and adds `second`.  Adding one is
    // what makes the frame's arrival observable without asserting the very
    // thing under test — waiting on an absence would pass vacuously against a
    // coordinator that had not processed it yet.
    register(region, victim, [second!]);
    await awaitCondition(
      () => regionEntry(victim, region.regionPath)?.[1].shards.has(second!) === true,
      { label: 'the second claim was processed' },
    );

    const entry = regionEntry(victim, region.regionPath)!;
    expect(entry[1].shards.has(first!)).toBe(true);
    expect(coordinatorState(victim).shardHome.get(first!)).toBe(entry[0]);

    // And the consequence the merge exists for: the shard is still reachable
    // through the bookkeeping `onRegionTerminated` walks, so losing the region
    // reallocates it instead of stranding it on a key nothing holds.
    post(region, victim, {
      kind: 'sharding.RegionTerminated',
      region: region.regionPath,
      node: region.address.toJSON(),
    });
    await awaitCondition(() => regionEntry(victim, region.regionPath) === undefined, {
      label: 'the region was evicted',
    });

    const afterTermination = coordinatorState(victim);
    const ownerKey = regionEntry(victim, victim.regionPath)![0];
    expect(afterTermination.shardHome.get(first!)).toBe(ownerKey);
    expect(afterTermination.shardHome.get(second!)).toBe(ownerKey);
  });

  test('the conflict hand-off is not a rebalance, so the claimant cannot complete it away', async () => {
    const victim = await startVictim('register-conflict-complete', 47_468);
    const stale = await claimant('register-conflict-complete-peer', 47_469);

    register(stale, victim, [victim.shardId]);
    await awaitCondition(() => handedOff(stale).includes(victim.shardId), {
      label: 'the claimant was told to hand the colliding shard off',
    });

    // Recording it as a rebalance would arm a timeout whose callback deletes
    // `shardHome[shardId]` and reallocates — destroying the *true owner's*
    // ownership on a timer, over a hand-off it never agreed to.
    expect(coordinatorState(victim).rebalanceInProgress.size).toBe(0);

    // The other half of leaving it out: `onHandOffComplete` returns on a shard
    // with no rebalance entry, so the claimant's completion frame is the
    // harmless no-op it should be.  Without that, this frame — from a region
    // that never owned the shard — would delete the owner's home and reallocate.
    const ownerKey = regionEntry(victim, victim.regionPath)![0];
    post(stale, victim, {
      kind: 'sharding.HandOffComplete',
      shardId: victim.shardId,
      region: stale.regionPath,
      node: stale.address.toJSON(),
    });
    // The assertion is an absence: give the coordinator a turn to act on the
    // completion, then prove it did not.
    await sleep(200);

    expect(coordinatorState(victim).shardHome.get(victim.shardId)).toBe(ownerKey);
    expect(entityIsUp(victim)).toBe(true);
  });
});
