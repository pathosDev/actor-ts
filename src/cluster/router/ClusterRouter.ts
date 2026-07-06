import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import { Props } from '../../Props.js';
import { Broadcast } from '../../Router.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Cluster } from '../Cluster.js';
import { MemberRemoved, MemberUp } from '../ClusterEvents.js';
import { RemoteActorRef } from '../RemoteActorRef.js';
import { pickRendezvous } from './ConsistentHashing.js';

/**
 * Cluster-aware router — routees are derived dynamically from the
 * cluster's up-members (optionally filtered by role) and rebuilt
 * automatically when members come and go.  The standard local
 * `Router` strategies (round-robin / random / broadcast) get a
 * `consistent-hashing` sibling that pins messages with the same
 * extracted key to the same node.
 *
 *   const router = system.spawn(
 *     ClusterRouter.props(
 *       ClusterRouterOptions.create<{ id: string }>()
 *         .withCluster(cluster)
 *         .withRole('compute')                          // optional role filter
 *         .withRouterType('consistent-hashing')
 *         .withRouteePath('/user/worker')
 *         .withExtractKey((msg) => msg.id),
 *     ),
 *     'compute-router',
 *   );
 *   router.tell({ id: 'order-42', op: 'price' });
 *
 * **Routees.**  Every up-member matching `role` (or every up-member
 * if no role is given) is materialised as a `RemoteActorRef` pointing
 * at `routeePath`.  Self-routing goes through the same `RemoteActorRef`
 * — the cluster transport handles loopback, so behaviour is identical
 * to a remote routee.  Order is deterministic (`upMembers()` sorts by
 * address), so round-robin counters stay sane across rebuilds.
 *
 * **Empty set.**  If no member matches the role (or the cluster is
 * empty), messages are dropped with a warn-level log.  The router
 * deliberately doesn't queue while waiting for routees, since that
 * would silently grow unbounded.
 *
 * **Rebuild trigger.**  Subscribes to `cluster.subscribe(...)` and
 * rebuilds on `MemberUp` / `MemberRemoved`.  Other events
 * (`MemberJoined`, `MemberWeaklyUp`, `MemberUnreachable`) are ignored
 * because the router only sends to fully-up members.
 *
 * **Out of scope (v1).**
 *   - `smallest-mailbox` cluster variant — would require pull-based
 *     mailbox-size queries per routee per message.  File a separate
 *     issue if the need arises.
 *   - Routee groups across multiple paths (`/user/a`, `/user/b` mixed)
 *     — current API supports a single `routeePath`.
 */

/** What a `ClusterRouter` does with each incoming message. */
export type ClusterRouterType =
  /** One routee per message, cycling through the pool. */
  | 'round-robin'
  /** One routee per message, picked uniformly at random. */
  | 'random'
  /** One routee per message; same `extractKey` always lands on same routee. */
  | 'consistent-hashing'
  /** Every routee gets every message (equivalent to wrapping in `Broadcast`). */
  | 'broadcast';

export interface ClusterRouterSettings<TMsg> {
  /** The cluster the router lives in.  Used for membership + transport. */
  readonly cluster: Cluster;
  /** Restrict routees to up-members carrying this role.  Omit for "any node". */
  readonly role?: string;
  /** Strategy.  See {@link ClusterRouterType}. */
  readonly routerType: ClusterRouterType;
  /**
   * The path the routee actor lives under on each routee node — usually
   * `/user/<actorName>`.  The same path must exist on every targeted
   * node; the router doesn't probe for liveness beyond the cluster
   * membership state.
   */
  readonly routeePath: string;
  /**
   * Required for `routerType: 'consistent-hashing'`, ignored otherwise.
   * Returns the string key used to pin a message to a routee.  Two
   * messages with the same key always land on the same node (subject
   * to the cluster topology not changing).
   */
  readonly extractKey?: (message: TMsg) => string;
}

/**
 * Fluent builder for {@link ClusterRouterSettings}:
 *
 *     ClusterRouter.props(
 *       ClusterRouterOptions.create<Cmd>()
 *         .withCluster(cluster)
 *         .withRouterType('consistent-hashing')
 *         .withRouteePath('/user/worker')
 *         .withExtractKey((m) => m.id),
 *     );
 */
export class ClusterRouterOptions<TMsg> extends OptionsBuilder<ClusterRouterSettings<TMsg>> {
  /** Start a fresh builder. */
  static create<TMsg>(): ClusterRouterOptions<TMsg> {
    return new ClusterRouterOptions<TMsg>();
  }

  /** The cluster the router lives in — drives membership + transport. */
  withCluster(cluster: Cluster): this {
    return this.set('cluster', cluster);
  }

  /** Restrict routees to up-members carrying this role.  Omit for "any node". */
  withRole(role: string): this {
    return this.set('role', role);
  }

  /** Routing strategy.  See {@link ClusterRouterType}. */
  withRouterType(routerType: ClusterRouterType): this {
    return this.set('routerType', routerType);
  }

  /** The path the routee actor lives under on each node — usually `/user/<name>`. */
  withRouteePath(routeePath: string): this {
    return this.set('routeePath', routeePath);
  }

  /** Key extractor — required for `consistent-hashing`, ignored otherwise. */
  withExtractKey(extractKey: (message: TMsg) => string): this {
    return this.set('extractKey', extractKey);
  }
}

/**
 * `Props` factory for the cluster router.  See {@link ClusterRouterOptions}
 * for the configuration builder and {@link ClusterRouterSettings} for the
 * resolved shape.
 */
export const ClusterRouter = {
  props<TMsg>(options: ClusterRouterOptions<TMsg>): Props<TMsg | Broadcast<TMsg>> {
    const opts = options.build() as ClusterRouterSettings<TMsg>;
    if (opts.routerType === 'consistent-hashing' && !opts.extractKey) {
      throw new Error(
        'ClusterRouter: routerType=\'consistent-hashing\' requires extractKey',
      );
    }
    return Props.create(
      () => new ClusterRouterActor<TMsg>(opts) as unknown as Actor<TMsg | Broadcast<TMsg>>,
    );
  },
};

/**
 * Materialise the full wire-path for a routee.  `routeePath` is given
 * as the user-friendly relative form (`'/user/worker'`); the cluster
 * envelope dispatcher (`Cluster.handleEnvelope`) parses paths via
 * `parsePathSegments`, which requires the full `actor-ts://system/...`
 * shape.  We build it per-member because the system name lives on the
 * target node — although in practice every node in a cluster shares
 * the same `systemName`, doing it this way removes the assumption.
 */
function fullPath(systemName: string, routeePath: string): string {
  const trimmed = routeePath.replace(/^\/+/, '');
  return `actor-ts://${systemName}/${trimmed}`;
}

class ClusterRouterActor<TMsg> extends Actor<TMsg | Broadcast<TMsg>> {
  private routees: RemoteActorRef<TMsg>[] = [];
  private counter = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly opts: ClusterRouterSettings<TMsg>) {
    super();
  }

  override preStart(): void {
    this.rebuildRoutees();
    this.unsubscribe = this.opts.cluster.subscribe((evt) => {
      // Only `up` and `removed` change the routee set.  `joined`,
      // `weakly-up`, `unreachable` are intermediate states we don't
      // route to.  Replay-on-subscribe (Cluster fires every current
      // member as a series of MemberJoined/MemberUp on subscribe) is
      // already handled by the initial rebuild — but firing here too
      // is harmless (rebuild is idempotent).
      if (evt instanceof MemberUp || evt instanceof MemberRemoved) {
        this.rebuildRoutees();
      }
    });
  }

  override postStop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.routees = [];
  }

  override onReceive(message: TMsg | Broadcast<TMsg>): void {
    const sender = this.sender.toNullable();
    if (message instanceof Broadcast) {
      for (const r of this.routees) r.tell(message.message, sender);
      return;
    }
    if (this.routees.length === 0) {
      this.log.warn('ClusterRouter: no routees match — dropping message', {
        role: this.opts.role,
        routeePath: this.opts.routeePath,
      });
      return;
    }
    if (this.opts.routerType === 'broadcast') {
      for (const r of this.routees) r.tell(message as TMsg, sender);
      return;
    }
    const target = this.pickRoutee(message as TMsg);
    target.tell(message as TMsg, sender);
  }

  /** Visible to subclasses / tests for inspecting the live routee list. */
  protected get currentRoutees(): ReadonlyArray<ActorRef<TMsg>> {
    return this.routees;
  }

  /* ----------------------------- internals ------------------------------ */

  private rebuildRoutees(): void {
    const members = this.opts.role
      ? this.opts.cluster.upMembersWithRole(this.opts.role)
      : this.opts.cluster.upMembers();
    // upMembers() already sorts by address, but spell it out for clarity
    // — round-robin across rebuilds depends on a stable order.
    const sorted = [...members].sort((a, b) => a.address.compareTo(b.address));
    this.routees = sorted.map(
      (m) => new RemoteActorRef<TMsg>(
        m.address, fullPath(m.address.systemName, this.opts.routeePath), this.opts.cluster,
      ),
    );
  }

  private pickRoutee(message: TMsg): RemoteActorRef<TMsg> {
    switch (this.opts.routerType) {
      case 'round-robin': {
        const idx = this.counter++ % this.routees.length;
        return this.routees[idx]!;
      }
      case 'random': {
        return this.routees[Math.floor(Math.random() * this.routees.length)]!;
      }
      case 'consistent-hashing': {
        const key = this.opts.extractKey!(message);
        return pickRendezvous(key, this.routees, (r) => r.targetNode.toString());
      }
      case 'broadcast': {
        // Unreachable here — `onReceive` short-circuits broadcast.
        return this.routees[0]!;
      }
    }
  }
}
