import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import { Props } from '../../Props.js';
import { Broadcast } from '../../Router.js';
import type { ClusterRouterOptions, ClusterRouterOptionsType } from './ClusterRouterOptions.js';
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

/**
 * `Props` factory for the cluster router.  See {@link ClusterRouterOptions}
 * for the configuration builder and {@link ClusterRouterOptionsType} for the
 * resolved shape.
 */
export const ClusterRouter = {
  props<TMessage>(
    options: ClusterRouterOptions<TMessage>,
  ): Props<TMessage | Broadcast<TMessage>> {
    const opts = options as ClusterRouterOptionsType<TMessage>;
    if (opts.routerType === 'consistent-hashing' && !opts.extractKey) {
      throw new Error(
        'ClusterRouter: routerType=\'consistent-hashing\' requires extractKey',
      );
    }
    return Props.create(
      () => new ClusterRouterActor<TMessage>(opts) as unknown as Actor<TMessage | Broadcast<TMessage>>,
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

class ClusterRouterActor<TMessage> extends Actor<TMessage | Broadcast<TMessage>> {
  private routees: RemoteActorRef<TMessage>[] = [];
  private counter = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly opts: ClusterRouterOptionsType<TMessage>) {
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

  override onReceive(message: TMessage | Broadcast<TMessage>): void {
    const sender = this.sender.toNullable();
    if (message instanceof Broadcast) {
      for (const routee of this.routees) routee.tell(message.message, sender);
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
      for (const routee of this.routees) routee.tell(message as TMessage, sender);
      return;
    }
    const target = this.pickRoutee(message as TMessage);
    target.tell(message as TMessage, sender);
  }

  /** Visible to subclasses / tests for inspecting the live routee list. */
  protected get currentRoutees(): ReadonlyArray<ActorRef<TMessage>> {
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
      (m) => new RemoteActorRef<TMessage>(
        m.address, fullPath(m.address.systemName, this.opts.routeePath), this.opts.cluster,
      ),
    );
  }

  private pickRoutee(message: TMessage): RemoteActorRef<TMessage> {
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
