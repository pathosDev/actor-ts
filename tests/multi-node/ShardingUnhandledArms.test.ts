/**
 * Healthy sharded traffic never reaches a sharding actor's `.otherwise` arm
 * (#1441).
 *
 * `Shard`, `ShardRegion` and `ShardCoordinator` each end their dispatch in an
 * arm that declines what no other arm claimed, through `Actor.unhandled`: a
 * dead letter naming the actor, and a tick of `actor_unhandled_total{class}`.
 * That is only worth having if the arm stays quiet under ordinary operation —
 * one dead letter per routine message would bury the drift signal it exists
 * for, which is why the three arms were silent no-ops until each had a test
 * showing it does not fire.  This is that test: one cluster driven through
 * every kind of traffic sharding produces, then the counter, per class.
 *
 * **The counter, not the dead-letter stream.**  A healthy hand-off already
 * produces dead letters: entities stopping under a shard that has itself just
 * stopped send it `Terminated`, and those are delivered to the dead-letter
 * office like any message to a stopped actor.  The counter moves only when an
 * actor declines what it was handed, so it is the one signal here that a
 * healthy run must leave at zero.
 *
 * **What is asserted about the traffic itself is only that it flowed.**  Some
 * asks issued straight after a rebalance, a member leaving or a leader crash
 * time out today — routing gaps of their own, tracked apart from this — so
 * those phases require that answers arrived, not that every one did.  The
 * phases before any topology change require every answer.
 */
import { describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../src/Actor.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { LeastShardAllocationStrategy } from '../../src/cluster/sharding/AllocationStrategy.js';
import { Passivate } from '../../src/cluster/sharding/Passivate.js';
import { JournalRememberEntitiesStore } from '../../src/cluster/sharding/RememberEntitiesStore.js';
import { hashShardId } from '../../src/cluster/sharding/ShardAllocator.js';
import type { ShardStats } from '../../src/cluster/sharding/ShardingProtocol.js';
import { StartShardingOptions } from '../../src/cluster/sharding/StartShardingOptions.js';
import type { MetricsRegistry } from '../../src/metrics/Metrics.js';
import { MetricsExtensionId } from '../../src/metrics/MetricsExtension.js';
import { InMemoryJournal } from '../../src/persistence/journals/InMemoryJournal.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';
import { awaitCondition } from '../util/AwaitCondition.js';
import { coordinatorSegments } from '../util/SystemPaths.js';

type PingCommand = { readonly kind: 'ping'; readonly id: string };

/** Ask the shard for a cooperative passivation; it hands back `stop`. */
type ByeCommand = { readonly kind: 'bye'; readonly id: string };

/** The stop-message a shard hands back once it grants the passivation. */
type StopCommand = { readonly kind: 'stop'; readonly id: string };

type Command = PingCommand | ByeCommand | StopCommand;

/** Per entity id, across every node — the ids carry a per-type prefix. */
const starts = new Map<string, number>();
const stops = new Map<string, number>();

const bump = (counts: Map<string, number>, entityId: string): void => {
  counts.set(entityId, (counts.get(entityId) ?? 0) + 1);
};

/** How many entities whose id starts with `prefix` are running right now. */
const running = (prefix: string): number => {
  let total = 0;
  for (const [entityId, started] of starts) {
    if (entityId.startsWith(prefix)) total += started - (stops.get(entityId) ?? 0);
  }
  return total;
};

class Entity extends Actor<Command> {
  override preStart(): void { bump(starts, this.entityId); }

  override postStop(): void { bump(stops, this.entityId); }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'ping' }, () => this.onPing())
      .with({ kind: 'bye' }, () => this.onBye())
      .with({ kind: 'stop' }, () => this.onStop())
      .exhaustive();
  }

  private onPing(): void { this.sender.forEach((sender) => sender.tell('pong')); }

  private onBye(): void {
    const stopCommand: StopCommand = { kind: 'stop', id: this.entityId };
    this.context.parent.forEach((parent) =>
      parent.tell(new Passivate(stopCommand, this.self) as never, this.self));
    this.sender.forEach((sender) => sender.tell('bye-ack'));
  }

  private onStop(): void { this.context.stopSelf(); }
}

/** Asks for a passivation and then ignores its stop-message, so the stop timeout has to act. */
class StubbornEntity extends Actor<Command> {
  override preStart(): void { bump(starts, this.entityId); }

  override postStop(): void { bump(stops, this.entityId); }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'ping' }, () => this.onPing())
      .with({ kind: 'bye' }, () => this.onBye())
      .with({ kind: 'stop' }, () => this.onStop())
      .exhaustive();
  }

  private onPing(): void { this.sender.forEach((sender) => sender.tell('pong')); }

  private onBye(): void {
    const stopCommand: StopCommand = { kind: 'stop', id: this.entityId };
    this.context.parent.forEach((parent) =>
      parent.tell(new Passivate(stopCommand, this.self) as never, this.self));
    this.sender.forEach((sender) => sender.tell('bye-ack'));
  }

  private onStop(): void { /* deliberately never acts on it */ }
}

const ROLES = ['a', 'b', 'c', 'd'] as const;

type Role = typeof ROLES[number];

/** The classes whose `.otherwise` arm this test watches. */
const DECLINING_CLASSES = ['Shard', 'ShardRegion', 'ShardCoordinator'] as const;

type DecliningClass = typeof DECLINING_CLASSES[number];

/** Long enough for a first placement, short enough to name a stalled phase. */
const ASK_TIMEOUT_MS = 4_000;

const TIGHT_FD = { heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 } as const;

/** `[prefix-from, …, prefix-(to-1)]`. */
const ids = (prefix: string, from: number, to: number): string[] =>
  Array.from({ length: to - from }, (_unused, index) => `${prefix}-${from + index}`);

/** An entity id with `prefix` that hashes into `shardId`. */
function idOnShard(prefix: string, shardId: number, numShards: number): string {
  for (let index = 0; index < 10_000; index++) {
    const candidate = `${prefix}-${index}`;
    if (hashShardId(candidate, numShards) === shardId) return candidate;
  }
  throw new Error(`no ${prefix} id hashes into shard ${shardId}`);
}

/** Answers that came back as `expected`, out of an ask per id. */
async function answered(
  ids: readonly string[],
  ask: (id: string) => Promise<unknown>,
  expected = 'pong',
): Promise<number> {
  const results = await Promise.allSettled(ids.map(ask));
  return results.filter((result) => result.status === 'fulfilled' && result.value === expected).length;
}

/**
 * The region actor behind a region ref — a test-only hop into private state,
 * for the facts no public surface reports: which shards a node owns, which
 * shard actors it is running, and where it believes each shard lives.
 */
type RegionInternals = {
  readonly localShards: ReadonlySet<number>;
  readonly shards: ReadonlyMap<number, unknown>;
  readonly shardHomeNodes: ReadonlyMap<number, { toString(): string }>;
};

/** `null` until the region has had its first turn — the actor is built there, not at spawn. */
function regionInternals(region: ActorRef<Command>): RegionInternals | null {
  const cell = (region as unknown as { getCell?: () => { actor?: RegionInternals | null } }).getCell?.();
  return cell?.actor ?? null;
}

/** Whether `region` runs no shard actor at all. */
const runsNoShard = (region: ActorRef<Command>): boolean => regionInternals(region)?.shards.size === 0;

/** How many shards `region` owns, or `0` while it is not built yet. */
const ownedShards = (region: ActorRef<Command>): number => regionInternals(region)?.localShards.size ?? 0;

/** Whether `region` still routes some shard to `node` — or cannot say yet. */
function routesTo(region: ActorRef<Command>, node: string): boolean {
  const internals = regionInternals(region);
  if (internals === null) return true;
  return [...internals.shardHomeNodes.values()].some((home) => home.toString() === node);
}

/** How many regions the coordinator on `role` has on record for `typeName`; `-1` if it hosts none. */
function registeredRegions(spec: MultiNodeSpec, role: Role, typeName: string): number {
  const system = spec.systemFor(role);
  const resolved = system._resolvePath(coordinatorSegments(system.name, typeName));
  if (resolved.isNone()) return -1;
  const cell = (resolved.value as unknown as {
    getCell?: () => { actor?: { regions: Map<string, unknown> } };
  }).getCell?.();
  return cell?.actor?.regions.size ?? -1;
}

function declinedBy(registries: ReadonlyMap<Role, MetricsRegistry>, className: DecliningClass): number {
  let total = 0;
  for (const registry of registries.values()) {
    total += registry.collect()
      .filter((s) => s.name === 'actor_unhandled_total' && s.labels['class'] === className)
      .reduce((sum, sample) => sum + sample.value, 0);
  }
  return total;
}

/** The count per class after one phase of the run. */
type Checkpoint = {
  readonly phase: string;
  readonly declined: Readonly<Record<DecliningClass, number>>;
};

/** Every phase in which `className` declined something, with how much it had declined by then. */
function phasesThatDeclined(checkpoints: readonly Checkpoint[], className: DecliningClass): string[] {
  return checkpoints
    .filter((checkpoint, index) => checkpoint.declined[className] > (checkpoints[index - 1]?.declined[className] ?? 0))
    .map((checkpoint) => `${checkpoint.phase}: ${checkpoint.declined[className]}`);
}

describe('sharding actors under healthy traffic (#1441)', () => {
  test('no Shard, ShardRegion or ShardCoordinator declines a message', async () => {
    const spec = new MultiNodeSpec({
      roles: [...ROLES],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 80,
    });
    const registries = new Map<Role, MetricsRegistry>();
    const checkpoints: Checkpoint[] = [];
    const checkpoint = (phase: string): void => {
      const declined = Object.fromEntries(
        DECLINING_CLASSES.map((className) => [className, declinedBy(registries, className)]),
      ) as Record<DecliningClass, number>;
      checkpoints.push({ phase, declined });
    };
    try {
      await spec.start();
      await Promise.all(ROLES.map((role) => spec.awaitMembers(role, ROLES.length)));
      for (const role of ROLES) {
        registries.set(role, spec.systemFor(role).extension(MetricsExtensionId).enable());
      }
      // 'a' leads by the lowest-address rule, so the coordinators start there.
      expect(spec.clusterFor('a').isLeader()).toBe(true);

      const journal = new InMemoryJournal();
      const entityOptions = StartShardingOptions.create<Command>()
        .withTypeName('entity')
        .withEntityActor(Entity)
        .withExtractEntityId((message) => message.id)
        .withNumShards(12)
        // Rebalances as soon as one region holds a shard more than another.
        .withAllocationStrategy(new LeastShardAllocationStrategy(1, 3))
        .withRebalanceIntervalMs(150)
        .withPassivationIdleMs(600)
        .withShardPassivationIdleMs(900)
        .withMaxEntities(6)
        .withStaleRegionDetection(true)
        .withRegionHeartbeatIntervalMs(100);
      const rememberedOptions = StartShardingOptions.create<Command>()
        .withTypeName('remembered')
        .withEntityActor(Entity)
        .withExtractEntityId((message) => message.id)
        .withNumShards(3)
        .withRememberEntities(true)
        .withRememberEntitiesStore(new JournalRememberEntitiesStore(journal))
        .withRebalanceIntervalMs(150);
      const stubbornOptions = StartShardingOptions.create<Command>()
        .withTypeName('stubborn')
        .withEntityActor(StubbornEntity)
        .withExtractEntityId((message) => message.id)
        .withNumShards(4)
        .withPassivationStopTimeoutMs(200);

      // ---- Spawn and cross-node routing -----------------------------------
      const entity = new Map<Role, ActorRef<Command>>();
      const remembered = new Map<Role, ActorRef<Command>>();
      for (const role of ['a', 'b', 'c'] as const) {
        entity.set(role, spec.clusterFor(role).sharding.start<Command>(entityOptions));
        remembered.set(role, spec.clusterFor(role).sharding.start<Command>(rememberedOptions));
      }
      // 'd' routes the remembered type without hosting it.
      remembered.set('d', spec.clusterFor('d').sharding.startProxy<Command>(rememberedOptions));
      const stubbornA = spec.clusterFor('a').sharding.start<Command>(stubbornOptions);
      const stubbornB = spec.clusterFor('b').sharding.start<Command>(stubbornOptions);

      const routedIds = ids('e', 0, 36);
      // Every node asks for every third id, so most asks cross a node; the cap
      // of six entities per node evicts as they arrive.
      expect(await answered(routedIds, (id) => {
        const role = (['a', 'b', 'c'] as const)[hashShardId(id, 3)]!;
        return entity.get(role)!.ask<string>({ id, kind: 'ping' }, ASK_TIMEOUT_MS);
      })).toBe(routedIds.length);
      expect(await answered(ids('x', 0, 6), (id) =>
        spec.clusterFor('c').sharding.entityRefFor<Command>('entity', id).ask<string>({ id, kind: 'ping' }, ASK_TIMEOUT_MS),
      )).toBe(6);
      expect(await answered(ids('r', 0, 9), (id) =>
        remembered.get('d')!.ask<string>({ id, kind: 'ping' }, ASK_TIMEOUT_MS),
      )).toBe(9);
      expect(await answered(ids('s', 0, 4), (id) =>
        stubbornA.ask<string>({ id, kind: 'ping' }, ASK_TIMEOUT_MS),
      )).toBe(4);
      checkpoint('spawn and cross-node routing');

      // ---- Shard refs and introspection -----------------------------------
      const placements = await spec.clusterFor('a').sharding.shards('entity', ASK_TIMEOUT_MS);
      const local = placements.find((info) => info.local);
      const remote = placements.find((info) => !info.local);
      if (local === undefined || remote === undefined) {
        throw new Error(`expected a local and a remote shard, got ${JSON.stringify(placements.map((p) => p.shardId))}`);
      }
      const localShard = await spec.clusterFor('a').sharding.shardRefFor<Command>('entity', local.shardId);
      const startedLocally = idOnShard('e-ref', local.shardId, 12);
      localShard.tell({ kind: 'sharding.StartEntity', entityId: startedLocally });
      const stats = await localShard.ask<ShardStats>({ kind: 'sharding.GetShardStats' }, ASK_TIMEOUT_MS);
      expect(stats.entityIds).toContain(startedLocally);
      const remoteShard = await spec.clusterFor('a').sharding.shardRefFor<Command>('entity', remote.shardId);
      const startedRemotely = idOnShard('e-remote', remote.shardId, 12);
      const envelopedRemotely = idOnShard('e-enveloped', remote.shardId, 12);
      remoteShard.tell({ kind: 'sharding.StartEntity', entityId: startedRemotely });
      remoteShard.tell({
        kind: 'sharding.EntityEnvelope',
        entityId: envelopedRemotely,
        message: { id: envelopedRemotely, kind: 'ping' },
      });
      await awaitCondition(() => starts.has(startedRemotely) && starts.has(envelopedRemotely), {
        timeoutMs: 4_000,
        label: 'both entities addressed through the remote shard ref started',
      });
      checkpoint('shard refs and introspection');

      // ---- Passivation: cooperative, stop timeout, idle, empty shard ------
      const [cooperative] = routedIds as [string];
      expect(await entity.get('a')!.ask<string>({ id: cooperative, kind: 'bye' }, ASK_TIMEOUT_MS)).toBe('bye-ack');
      expect(await stubbornA.ask<string>({ id: 's-0', kind: 'bye' }, ASK_TIMEOUT_MS)).toBe('bye-ack');
      expect(await remembered.get('d')!.ask<string>({ id: 'r-0', kind: 'bye' }, ASK_TIMEOUT_MS)).toBe('bye-ack');
      await awaitCondition(() => (stops.get('s-0') ?? 0) >= 1, {
        timeoutMs: 4_000,
        label: 'the stop timeout stopped the entity that ignored its stop-message',
      });
      await awaitCondition(() => (stops.get('r-0') ?? 0) >= 1, {
        timeoutMs: 4_000,
        label: 'the remembered entity passivated cooperatively',
      });
      // Idle for a window, every entity of the capped type is passivated, and
      // once a shard has stood empty for its own window the shard goes too.
      await awaitCondition(() => running('e-') === 0 && running('x-') === 0, {
        timeoutMs: 10_000,
        label: 'the idle sweep passivated every entity of the capped type',
      });
      await awaitCondition(() => (['a', 'b', 'c'] as const).every((role) => runsNoShard(entity.get(role)!)), {
        timeoutMs: 10_000,
        label: 'the empty-shard sweep stopped every empty shard of the capped type',
      });
      checkpoint('passivation');

      // ---- Rebalance onto a joining region --------------------------------
      entity.set('d', spec.clusterFor('d').sharding.start<Command>(entityOptions));
      await awaitCondition(() => ownedShards(entity.get('d')!) >= 2, {
        timeoutMs: 15_000,
        label: 'the coordinator rebalanced shards onto the joining region',
      });
      expect(await answered(routedIds, (id) =>
        entity.get('d')!.ask<string>({ id, kind: 'ping' }, ASK_TIMEOUT_MS))).toBeGreaterThan(0);
      checkpoint('rebalance onto a joining region');

      // ---- A region stops while its node stays up -------------------------
      stubbornB.stop();
      await awaitCondition(() => registeredRegions(spec, 'a', 'stubborn') === 1, {
        timeoutMs: 4_000,
        label: "the coordinator dropped the stopped region from its registry",
      });
      expect(await answered(ids('s', 0, 8), (id) =>
        stubbornA.ask<string>({ id, kind: 'ping' }, ASK_TIMEOUT_MS))).toBeGreaterThan(0);
      checkpoint('region stop');

      // ---- A member leaves gracefully -------------------------------------
      const leaver = spec.addressFor('c').toString();
      await spec.leave('c');
      await Promise.all((['a', 'b', 'd'] as const).map((role) => spec.awaitMembers(role, 3)));
      await awaitCondition(() => (['a', 'b', 'd'] as const).every((role) => !routesTo(entity.get(role)!, leaver)), {
        timeoutMs: 10_000,
        label: 'the surviving regions dropped every shard home on the member that left',
      });
      expect(await answered(routedIds, (id) =>
        entity.get('b')!.ask<string>({ id, kind: 'ping' }, ASK_TIMEOUT_MS))).toBeGreaterThan(0);
      checkpoint('graceful leave');

      // ---- The leader crashes, and the coordinators fail over -------------
      const crashed = spec.addressFor('a').toString();
      await spec.crash('a');
      await Promise.all((['b', 'd'] as const).map((role) => spec.awaitMembers(role, 2)));
      await awaitCondition(() => spec.clusterFor('b').isLeader(), {
        timeoutMs: 10_000,
        label: "'b' took over as leader",
      });
      await awaitCondition(() => (['b', 'd'] as const).every((role) => !routesTo(entity.get(role)!, crashed)), {
        timeoutMs: 10_000,
        label: 'the surviving regions dropped every shard home on the crashed leader',
      });
      expect(await answered(routedIds, (id) =>
        entity.get('d')!.ask<string>({ id, kind: 'ping' }, ASK_TIMEOUT_MS))).toBeGreaterThan(0);
      expect(await answered(ids('r', 1, 9), (id) =>
        remembered.get('d')!.ask<string>({ id, kind: 'ping' }, ASK_TIMEOUT_MS))).toBeGreaterThan(0);
      checkpoint('leader crash and coordinator failover');

      // Shard: every kind a shard is sent above has an arm of its own — the
      // envelope from its region, a passivation it is told to perform, the
      // starts a recovery or a shard ref sends, the stats query, and its own
      // system traffic (`Terminated`, `Passivate`, the stop-timeout tick).
      expect(phasesThatDeclined(checkpoints, 'Shard')).toEqual([]);
      // ShardRegion: the coordinator's directives and replies, the spawn
      // reports of its own shards, envelopes and replies between regions, the
      // shard refs' `ToShard`, the introspection queries and their fan-out, and
      // the map broadcasts all have arms; a proxy region's traffic is the same.
      expect(phasesThatDeclined(checkpoints, 'ShardRegion')).toEqual([]);
      // ShardCoordinator: registrations and their re-sends after the failover,
      // home requests, the hand-off acknowledgments of the rebalance, the
      // stopped region's notice, heartbeats, the remembered entities' reports
      // and the stats fan-out all have arms on whichever node leads.
      expect(phasesThatDeclined(checkpoints, 'ShardCoordinator')).toEqual([]);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
      starts.clear();
      stops.clear();
    }
  }, 90_000);
});
