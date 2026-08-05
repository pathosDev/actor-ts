import type { ActorClassOrFactory } from '../../Actor.js';
import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { ActorSystem } from '../../ActorSystem.js';
import type { Cancellable } from '../../Scheduler.js';
import type { Cluster } from '../Cluster.js';
import { LeaderChanged, MemberRemoved } from '../ClusterEvents.js';
import { LeastShardAllocationStrategy } from './AllocationStrategy.js';
import { ClusterSharding } from './ClusterSharding.js';
import { StartShardingOptions } from './StartShardingOptions.js';
import { ShardedDaemonProcessOptionsValidator } from './ShardedDaemonProcessOptions.js';
import type { ShardedDaemonProcessOptions, ShardedDaemonProcessOptionsType } from './ShardedDaemonProcessOptions.js';

/** Envelope the sharded region routes to daemon #index. */
type DaemonEnvelope<T> = { readonly index: number; readonly body: T | Wakeup; };

/** Internal no-op message used to materialize a daemon on startup. */
type Wakeup = { readonly kind: 'sharded-daemon.wakeup'; };
const WAKEUP: Wakeup = { kind: 'sharded-daemon.wakeup' };

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
 * its own shard via a 1-to-1 allocation, and `rememberEntities` ensures the
 * daemons respawn after a node failure.
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
    const resolvedOptions = options as ShardedDaemonProcessOptionsType<T>;
    new ShardedDaemonProcessOptionsValidator<T>().validate(resolvedOptions);
    const sharding = ClusterSharding.get(system, cluster);

    const startOptions = StartShardingOptions.create<DaemonEnvelope<T>>()
      .withTypeName(`daemon-${resolvedOptions.name}`)
      .withEntityActor(() => new DaemonHost<T>(resolvedOptions.actorFor) as unknown as Actor<DaemonEnvelope<T>>)
      .withExtractEntityId((env) => String(env.index))
      .withExtractEntityMessage((env) => env.body)
      .withNumShards(resolvedOptions.numDaemons)
      .withRememberEntities(true)
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
    const livenessIntervalMs = resolvedOptions.livenessIntervalMs ?? 30_000;
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

  constructor(private readonly actorFor: (i: number) => ActorClassOrFactory<T>) { super(); }

  override preStart(): void {
    // The entity id IS the daemon index — `extractEntityId` stringifies it.
    const daemon = this.actorFor(Number.parseInt(this.entityId, 10));
    this.inner = this.context.spawn(daemon, 'daemon');
  }

  override onReceive(message: DaemonEnvelope<T> | T | Wakeup): void {
    // ShardRegion uses `extractEntityMessage` to unwrap the envelope before
    // delivery, so `message` here is actually the `body` field of the envelope.
    if (isWakeup(message)) return; // already awake — preStart ran
    this.inner?.tell(message as T);
  }
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
