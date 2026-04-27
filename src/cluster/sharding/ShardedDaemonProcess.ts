import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { ActorSystem } from '../../ActorSystem.js';
import { Props } from '../../Props.js';
import type { Cluster } from '../Cluster.js';
import { LeaderChanged, MemberRemoved } from '../ClusterEvents.js';
import { LeastShardAllocationStrategy } from './AllocationStrategy.js';
import { ClusterSharding } from './ClusterSharding.js';

/** Envelope the sharded region routes to daemon #index. */
interface DaemonEnvelope<T> { readonly index: number; readonly body: T | Wakeup; }

/** Internal no-op message used to materialize a daemon on startup. */
interface Wakeup { readonly t: 'sharded-daemon.wakeup'; }
const WAKEUP: Wakeup = { t: 'sharded-daemon.wakeup' };

export interface ShardedDaemonProcessSettings<T> {
  /** Logical name used for the shard type; must be unique per daemon set. */
  readonly name: string;
  /** Total number of daemons to keep running cluster-wide. */
  readonly numDaemons: number;
  /** Props factory — gets the daemon's stable index (0..numDaemons-1). */
  readonly behaviorFor: (daemonIndex: number) => Props<T>;
  /** Optional role — only members carrying the role host daemons. */
  readonly role?: string;
}

export interface ShardedDaemonProcessHandle<T> {
  /**
   * Sharded region ref.  Messages sent here must carry a `{index, body}`
   * envelope — use `tell(i, msg)` on the handle instead.
   */
  readonly region: ActorRef<DaemonEnvelope<T>>;

  /** Send a user message to daemon #i. */
  tell(index: number, message: T): void;
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
    settings: ShardedDaemonProcessSettings<T>,
  ): ShardedDaemonProcessHandle<T> {
    const sharding = ClusterSharding.get(system, cluster);

    const region = sharding.start<DaemonEnvelope<T>>({
      typeName: `daemon-${settings.name}`,
      entityProps: Props.create(() => new DaemonHost<T>(settings.behaviorFor) as unknown as Actor<DaemonEnvelope<T>>),
      extractEntityId: (env) => String(env.index),
      extractEntityMessage: (env) => env.body,
      numShards: settings.numDaemons,
      role: settings.role,
      rememberEntities: true,
      allocationStrategy: new LeastShardAllocationStrategy(),
    });

    // Wake every daemon so the coordinator allocates a shard and the host
    // actor's preStart runs.  Afterwards rememberEntities keeps them alive.
    const wakeAll = (): void => {
      for (let i = 0; i < settings.numDaemons; i++) {
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
    cluster.subscribe((evt) =>
      match(evt)
        .with(
          P.union(P.instanceOf(LeaderChanged), P.instanceOf(MemberRemoved)),
          () => { setTimeout(wakeAll, 100); },
        )
        .otherwise(() => { /* other events don't warrant a re-wake */ }),
    );

    return {
      region,
      tell(index: number, message: T): void {
        region.tell({ index, body: message });
      },
    };
  }
}

/**
 * Host actor spawned by ShardRegion for each daemon index.  On first start
 * it derives its daemon index from its actor name and constructs the real
 * user Actor as a child.  All user messages are forwarded to that child.
 */
class DaemonHost<T> extends Actor<DaemonEnvelope<T>> {
  private inner: ActorRef<T> | null = null;

  constructor(private readonly behaviorFor: (i: number) => Props<T>) { super(); }

  override preStart(): void {
    const index = indexFromEntityName(this.context.path.name);
    const props = this.behaviorFor(index);
    this.inner = this.context.actorOf(props, 'daemon');
  }

  override onReceive(msg: DaemonEnvelope<T> | T | Wakeup): void {
    // ShardRegion uses `extractEntityMessage` to unwrap the envelope before
    // delivery, so `msg` here is actually the `body` field of the envelope.
    if (isWakeup(msg)) return; // already awake — preStart ran
    this.inner?.tell(msg as T);
  }
}

function indexFromEntityName(name: string): number {
  // Names are set by ShardRegion as `entity-<entityId>` where entityId is
  // the stringified daemon index (see extractEntityId above).
  const m = name.match(/^entity-(\d+)$/);
  return m ? parseInt(m[1]!, 10) : 0;
}

function isWakeup(x: unknown): x is Wakeup {
  return !!x && typeof x === 'object' && (x as { t?: string }).t === 'sharded-daemon.wakeup';
}
