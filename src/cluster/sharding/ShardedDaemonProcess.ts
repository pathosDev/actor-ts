import type { ActorClassOrFactory } from '../../Actor.js';
import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { ActorSystem } from '../../ActorSystem.js';
import type { Cancellable } from '../../Scheduler.js';
import type { Cluster } from '../Cluster.js';
import { PersistenceExtensionId } from '../../persistence/PersistenceExtension.js';
import { mergeOptions } from '../../util/OptionsMerge.js';
import { LeaderChanged, MemberRemoved } from '../ClusterEvents.js';
import { LeastShardAllocationStrategy } from './AllocationStrategy.js';
import { ClusterSharding } from './ClusterSharding.js';
import { Passivate } from './Passivate.js';
import { hashShardId } from './ShardAllocator.js';
import { JournalRememberEntitiesStore } from './RememberEntitiesStore.js';
import { StartShardingOptions } from './StartShardingOptions.js';
import {
  DEFAULT_DAEMON_LIVENESS_INTERVAL_MS,
  ShardedDaemonProcessOptionsValidator,
  readShardedDaemonProcessOptionsFromConfig,
} from './ShardedDaemonProcessOptions.js';
import type { ShardedDaemonProcessOptions, ShardedDaemonProcessOptionsType } from './ShardedDaemonProcessOptions.js';

/** Envelope the sharded region routes to daemon #index. */
type DaemonEnvelope<T> = { readonly index: number; readonly body: T | Wakeup; };

/** Internal no-op message used to materialize a daemon on startup. */
type Wakeup = { readonly kind: 'sharded-daemon.wakeup'; };
const WAKEUP: Wakeup = { kind: 'sharded-daemon.wakeup' };

/** What a host sends itself, through its shard's passivation, to go away for good. */
type Retire = { readonly kind: 'sharded-daemon.retire'; };
const RETIRE: Retire = { kind: 'sharded-daemon.retire' };

export interface ShardedDaemonProcessHandle<T> {
  /**
   * Sharded region ref.  Messages sent here must carry a `{index, body}`
   * envelope — use `tell(i, message)` on the handle instead.
   */
  readonly region: ActorRef<DaemonEnvelope<T>>;

  /** Send a user message to daemon #i. */
  tell(index: number, message: T): void;

  /**
   * Stop the liveness heartbeat + cluster subscription.  Idempotent.
   * Does NOT stop the running daemon entities — that happens when the
   * cluster shuts down or the region itself is stopped.
   */
  stop(): void;
}

/**
 * Starts exactly N named daemon actors spread across the cluster.  Built on
 * top of ClusterSharding: each daemon becomes an entity, each entity gets
 * its own shard via a 1-to-1 allocation — the entity ids are chosen so that
 * daemon `i` hashes onto shard `i` ({@link daemonEntityIds}) — and
 * `rememberEntities` ensures the daemons respawn after a node failure.
 *
 * The allocation strategy defaults to `LeastShardAllocationStrategy` so
 * daemons spread evenly over nodes.  Every daemon index receives a
 * synthetic "wake-up" message at init time which causes the sharding
 * machinery to materialize it on the node the coordinator chose.
 */
export class ShardedDaemonProcess {
  static init<T>(
    system: ActorSystem,
    cluster: Cluster,
    options: ShardedDaemonProcessOptions<T>,
  ): ShardedDaemonProcessHandle<T> {
    // The config seam this module had none of: `options` used to be cast
    // straight to the settings type, so a daemon set was tunable from code and
    // from nowhere else (#854).  The merge runs BEFORE the validator so the
    // validator sees the values the node will actually run with — a HOCON
    // `liveness-interval = -1s` is then named as `livenessIntervalMs`, not
    // silently armed.
    const resolvedOptions = mergeOptions<ShardedDaemonProcessOptionsType<T>>(
      {},
      readShardedDaemonProcessOptionsFromConfig(system.config) as Partial<ShardedDaemonProcessOptionsType<T>>,
      options as Partial<ShardedDaemonProcessOptionsType<T>>,
    );
    new ShardedDaemonProcessOptionsValidator<T>().validate(resolvedOptions);
    const sharding = ClusterSharding.get(system, cluster);

    // The registry is wired explicitly, not left to ClusterSharding's auto
    // path, because the #1356 refusal there protects a property SDP does not
    // depend on: plain rememberEntities IS the respawn mechanism, so a
    // node-local registry silently loses it on coordinator failover — here
    // the liveness tick and the topology re-wake below respawn every daemon
    // regardless, and the registry only accelerates.  Same journal, same
    // store as before; the storage advisory still notes the degraded half at
    // warning level instead of refusing a self-healing setup.
    const persistenceExtension = system.extension(PersistenceExtensionId);
    const registryJournal = persistenceExtension.journal;
    persistenceExtension.noteStoreUse('remember-entities', registryJournal);

    const entityIds = daemonEntityIds(resolvedOptions.numDaemons);
    const indexByEntityId = new Map(entityIds.map((entityId, index) => [entityId, index] as const));
    const startOptions = StartShardingOptions.create<DaemonEnvelope<T>>()
      .withTypeName(`daemon-${resolvedOptions.name}`)
      .withEntityActor(
        () => new DaemonHost<T>(resolvedOptions.actorFor, indexByEntityId) as unknown as Actor<DaemonEnvelope<T>>,
      )
      // An index outside `0..numDaemons-1` has no id in the table; its decimal
      // string names no daemon either, so its host retires (see `DaemonHost`).
      .withExtractEntityId((env) => entityIds[env.index] ?? String(env.index))
      .withExtractEntityMessage((env) => env.body)
      .withNumShards(resolvedOptions.numDaemons)
      .withRememberEntities(true)
      .withRememberEntitiesStore(new JournalRememberEntitiesStore(registryJournal))
      // A daemon is supposed to run continuously, so the node-wide idle sweep
      // must not apply to it: a daemon that only wakes on its own schedule
      // looks idle, and passivating it would both drop it from the
      // remember-entities registry and leave `wakeAll` resurrecting it on
      // every liveness tick.  Explicit, so it beats HOCON as well.
      .withPassivationIdleMs(0)
      .withAllocationStrategy(new LeastShardAllocationStrategy());
    if (resolvedOptions.role !== undefined) startOptions.withRole(resolvedOptions.role);
    const region = sharding.start<DaemonEnvelope<T>>(startOptions);

    // Wake every daemon so the coordinator allocates a shard and the host
    // actor's preStart runs.  Afterwards rememberEntities keeps them alive.
    const wakeAll = (): void => {
      for (let i = 0; i < resolvedOptions.numDaemons; i++) {
        region.tell({ index: i, body: WAKEUP });
      }
    };
    queueMicrotask(wakeAll);

    // Re-wake when the cluster topology changes — this lets the region
    // re-resolve homes for any orphaned shards after a node left, without
    // waiting for the next user message to trigger the lookup.  Full
    // respawn of entities that lived on a departed node is a function of
    // ShardCoordinator's rebalance + rememberEntities path; this hook just
    // makes sure the SDP-owned messages keep flowing.
    const unsubscribe = cluster.subscribe((evt) =>
      match(evt)
        .with(
          P.union(P.instanceOf(LeaderChanged), P.instanceOf(MemberRemoved)),
          () => onTopologyChanged(wakeAll),
        )
        .otherwise(() => onOtherClusterEvent()),
    );

    // Periodic liveness backstop — fires even when no cluster events do,
    // so any wake-up that got lost in transit (rare, but possible during
    // brief partition + heal cycles) gets retried.
    // The `??` still earns its place even though `reference.conf` ships the
    // leaf: a system built on `Config.empty()` reaches here with the field
    // genuinely absent.
    const livenessIntervalMs = resolvedOptions.livenessIntervalMs ?? DEFAULT_DAEMON_LIVENESS_INTERVAL_MS;
    let livenessTimer: Cancellable | null = null;
    if (livenessIntervalMs > 0) {
      livenessTimer = system.scheduler.scheduleAtFixedRateFunction(
        livenessIntervalMs, livenessIntervalMs, wakeAll,
      );
    }

    let stopped = false;
    return {
      region,
      tell(index: number, message: T): void {
        region.tell({ index, body: message });
      },
      stop(): void {
        if (stopped) return;
        stopped = true;
        livenessTimer?.cancel();
        unsubscribe();
      },
    };
  }
}

/**
 * Host actor spawned by ShardRegion for each daemon index.  On first start
 * it reads its daemon index off its sharding identity and constructs the
 * real user Actor as a child.  All user messages are forwarded to that child.
 */
class DaemonHost<T> extends Actor<DaemonEnvelope<T>> {
  private inner: ActorRef<T> | null = null;

  constructor(
    private readonly actorFor: (i: number) => ActorClassOrFactory<T>,
    private readonly indexByEntityId: ReadonlyMap<string, number>,
  ) { super(); }

  override preStart(): void {
    const index = this.indexByEntityId.get(this.entityId);
    if (index === undefined) {
      this.retire();
      return;
    }
    this.inner = this.context.spawn(this.actorFor(index), 'daemon');
  }

  override onReceive(message: DaemonEnvelope<T> | T | Wakeup | Retire): void {
    // ShardRegion uses `extractEntityMessage` to unwrap the envelope before
    // delivery, so `message` here is actually the `body` field of the envelope.
    if (isWakeup(message)) return; // already awake — preStart ran
    if (isRetire(message)) {
      this.context.stopSelf();
      return;
    }
    this.inner?.tell(message as T);
  }

  /**
   * An entity id that names no daemon: one a registry written before #951
   * remembers — the bare index, for a daemon whose id moved so it gets a shard
   * of its own — or an index `tell` was given outside `0..numDaemons-1`.
   * Running it would be a second copy of a daemon, so it goes away through its
   * shard's passivation, which is the stop that also drops it from the
   * remember-entities registry: a plain stop would be read as a failure and
   * kept there, to be revived on every failover.
   */
  private retire(): void {
    this.log.warn(
      `[sharding] daemon entity '${this.entityId}' names no daemon index of this set; `
      + 'retiring it (a pre-0.19 remembered id, or an index outside 0..numDaemons-1)',
    );
    this.context.parent.toNullable()?.tell(new Passivate(RETIRE, this.self) as never);
  }
}

/**
 * The entity id of every daemon, by index — chosen so the region's own hash
 * puts daemon `i` on shard `i` (#951).
 *
 * The type is governed with `numShards = numDaemons`, and the region places an
 * entity on `hashShardId(entityId, numShards)`.  The bare index as the id hashed
 * N ids into N buckets, which is the birthday problem: 100 daemons landed on 58
 * shards, four on one, and since a shard is the unit of allocation no rebalance
 * could ever separate them.  Choosing the ids instead of the hash keeps the
 * region untouched and makes the "one shard per daemon" placement exact.
 *
 * An index whose decimal string already lands on its own shard keeps it, so a
 * registry written before this change keeps every daemon that was placed
 * right.  The other shards are filled from a deterministic sequence of
 * candidates, `shard-key-0`, `shard-key-1`, …, each taking the first empty
 * shard it hashes to — a coupon collector, about `N·ln N` hashes in all
 * (under 20 ms for 10 000 daemons; per-index searching was quadratic, and half
 * a minute at that size).  Every node computes the same table.
 */
export function daemonEntityIds(numDaemons: number): readonly string[] {
  const entityIds = new Array<string | undefined>(numDaemons);
  let unplaced = numDaemons;
  for (let index = 0; index < numDaemons; index++) {
    const decimal = String(index);
    if (hashShardId(decimal, numDaemons) !== index) continue;
    entityIds[index] = decimal;
    unplaced--;
  }
  for (let candidate = 0; unplaced > 0; candidate++) {
    const entityId = `shard-key-${candidate}`;
    const shardId = hashShardId(entityId, numDaemons);
    if (entityIds[shardId] !== undefined) continue;
    entityIds[shardId] = entityId;
    unplaced--;
  }
  return entityIds as string[];
}

/**
 * A leader change or a departed member can leave shards without a home.
 * The short delay lets the coordinator finish reallocating before we
 * re-wake, so the wake-ups don't race the allocation they depend on.
 *
 * Module-level rather than a method: the subscription is set up in static
 * `init`, where there is no instance, and the handler needs `wakeAll` from
 * the enclosing scope.
 */
function onTopologyChanged(wakeAll: () => void): void {
  setTimeout(wakeAll, 100);
}

/** Every other cluster event leaves shard homes intact — nothing to re-wake. */
function onOtherClusterEvent(): void {}

function isWakeup(x: unknown): x is Wakeup {
  return !!x && typeof x === 'object' && (x as { kind?: string }).kind === 'sharded-daemon.wakeup';
}

function isRetire(x: unknown): x is Retire {
  return !!x && typeof x === 'object' && (x as { kind?: string }).kind === 'sharded-daemon.retire';
}
