import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { ActorFactory } from '../../Actor.js';
import { Broadcast } from '../../Router.js';
import {
  ClusterRouterOptionsValidator,
  DEFAULT_MAILBOX_DEPTH_REFRESH_MS,
  DEFAULT_MAILBOX_DEPTH_STALE_AFTER_MS,
} from './ClusterRouterOptions.js';
import type { ClusterRouterOptions, ClusterRouterOptionsType } from './ClusterRouterOptions.js';
import { MemberRemoved, MemberUp } from '../ClusterEvents.js';
import type { NodeAddress } from '../NodeAddress.js';
import { RemoteActorRef } from '../RemoteActorRef.js';
import { pickRendezvous } from './ConsistentHashing.js';
import { MailboxDepthProbe } from './MailboxDepthProbe.js';
import { isMailboxDepthReport, routeeFullPath, type MailboxDepthReportMessage } from './MailboxDepthProtocol.js';

/**
 * Cluster-aware router — routees are derived dynamically from the
 * cluster's up-members (optionally filtered by role) and rebuilt
 * automatically when members come and go.  The local `Router`'s four
 * strategies (round-robin / random / broadcast / smallest-mailbox) all
 * have a counterpart here, plus a `consistent-hashing` sibling the
 * local router has no use for: it pins messages with the same extracted
 * key to the same node.
 *
 *   const routerOptions = ClusterRouterOptions.create<{ id: string }>()
 *     .withCluster(cluster)
 *     .withRole('compute')                          // optional role filter
 *     .withRouterType('consistent-hashing')
 *     .withRouteePath('/user/worker')
 *     .withExtractKey((message) => message.id);
 *   const router = system.spawn(
 *     ClusterRouter.factory(routerOptions),
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
 * **Load-aware routing.**  `smallest-mailbox` picks the routee whose node
 * last reported the shallowest mailbox.  The reading is *cached* and
 * refreshed on a background tick — never asked for on the routing path, which
 * stays as synchronous as round-robin's modulo.  See
 * {@link MailboxDepthProbe} for why the obvious ask-then-route design is not
 * available here, and what a stale reading can and cannot cost.
 *
 * **Out of scope (v1).**
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
  /** One routee per message, the one whose node last reported the shortest queue. */
  | 'smallest-mailbox'
  /** Every routee gets every message (equivalent to wrapping in `Broadcast`). */
  | 'broadcast';

/**
 * Actor factory for the cluster router.  See {@link ClusterRouterOptions}
 * for the configuration builder and {@link ClusterRouterOptionsType} for the
 * resolved shape.
 */
export const ClusterRouter = {
  factory<TMessage>(
    options: ClusterRouterOptions<TMessage>,
  ): ActorFactory<TMessage | Broadcast<TMessage>> {
    const resolvedOptions = options as ClusterRouterOptionsType<TMessage>;
    new ClusterRouterOptionsValidator<TMessage>().validate(resolvedOptions);
    return () =>
      new ClusterRouterActor<TMessage>(resolvedOptions) as unknown as Actor<TMessage | Broadcast<TMessage>>;
  },
};

/**
 * The class contract stays the caller-facing union — nobody sends a router a
 * mailbox-depth report, a routee node's agent does — while `onReceive` widens
 * to accept it, the way `RouterActor` widens for the `Terminated` the system
 * delivers.  Reports arrive through the router's own mailbox rather than
 * through an envelope handler of their own, which is what keeps the refresh
 * off the routing path: a report is just another message in the queue.
 */
class ClusterRouterActor<TMessage> extends Actor<TMessage | Broadcast<TMessage>> {
  private routees: RemoteActorRef<TMessage>[] = [];
  private counter = 0;
  private unsubscribe: (() => void) | null = null;
  /** Only built for `smallest-mailbox`; `null` for every other strategy. */
  private depthProbe: MailboxDepthProbe | null = null;

  constructor(private readonly options: ClusterRouterOptionsType<TMessage>) {
    super();
  }

  override preStart(): void {
    this.rebuildRoutees();
    this.unsubscribe = this.options.cluster.subscribe((evt) => {
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
    if (this.options.routerType === 'smallest-mailbox') this.startDepthProbe();
  }

  override postStop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.depthProbe?.stop();
    this.depthProbe = null;
    this.routees = [];
  }

  override onReceive(message: TMessage | Broadcast<TMessage> | MailboxDepthReportMessage): void {
    // Gated on the probe so every other strategy pays nothing for a check that
    // can only ever be true for this one.
    if (this.depthProbe !== null && isMailboxDepthReport(message)) {
      this.onMailboxDepthReport(message);
      return;
    }
    if (message instanceof Broadcast) {
      this.onBroadcast(message);
      return;
    }
    this.onRoutedMessage(message as TMessage);
  }

  /** Visible to subclasses / tests for inspecting the live routee list. */
  protected get currentRoutees(): ReadonlyArray<ActorRef<TMessage>> {
    return this.routees;
  }

  /* ----------------------------- internals ------------------------------ */

  private onMailboxDepthReport(report: MailboxDepthReportMessage): void {
    this.depthProbe?.record(report);
  }

  private onBroadcast(message: Broadcast<TMessage>): void {
    const sender = this.sender.toNullable();
    for (const routee of this.routees) routee.tell(message.message, sender);
  }

  private onRoutedMessage(message: TMessage): void {
    const sender = this.sender.toNullable();
    if (this.routees.length === 0) {
      this.log.warn('ClusterRouter: no routees match — dropping message', {
        role: this.options.role,
        routeePath: this.options.routeePath,
      });
      return;
    }
    if (this.options.routerType === 'broadcast') {
      for (const routee of this.routees) routee.tell(message, sender);
      return;
    }
    this.pickRoutee(message).tell(message, sender);
  }

  private startDepthProbe(): void {
    this.depthProbe = new MailboxDepthProbe(
      this.options.cluster,
      // Reports come back addressed to this router, not to a well-known
      // collector path: two routers on one node would otherwise fight over the
      // same handler, and each would see the other's readings.
      this.self.path.toString(),
      this.options.routeePath,
      this.options.mailboxDepthStaleAfterMs ?? DEFAULT_MAILBOX_DEPTH_STALE_AFTER_MS,
    );
    const refreshMs = this.options.mailboxDepthRefreshMs ?? DEFAULT_MAILBOX_DEPTH_REFRESH_MS;
    this.depthProbe.start(refreshMs, () => this.routeeNodes());
  }

  private routeeNodes(): ReadonlyArray<NodeAddress> {
    return this.routees.map((routee) => routee.targetNode);
  }

  private rebuildRoutees(): void {
    const members = this.options.role
      ? this.options.cluster.upMembersWithRole(this.options.role)
      : this.options.cluster.upMembers();
    // upMembers() already sorts by address, but spell it out for clarity
    // — round-robin across rebuilds depends on a stable order.
    const sorted = [...members].sort((a, b) => a.address.compareTo(b.address));
    this.routees = sorted.map(
      (m) => new RemoteActorRef<TMessage>(
        m.address, routeeFullPath(m.address.systemName, this.options.routeePath), this.options.cluster,
      ),
    );
    // A node that just came up would otherwise wait a whole refresh interval
    // before it could be chosen on merit rather than on the rotation fallback.
    this.depthProbe?.refreshNow();
  }

  private pickRoutee(message: TMessage): RemoteActorRef<TMessage> {
    switch (this.options.routerType) {
      case 'round-robin': {
        const index = this.counter++ % this.routees.length;
        return this.routees[index]!;
      }
      case 'random': {
        return this.routees[Math.floor(Math.random() * this.routees.length)]!;
      }
      case 'consistent-hashing': {
        const key = this.options.extractKey!(message);
        return pickRendezvous(key, this.routees, (r) => r.targetNode.toString());
      }
      case 'smallest-mailbox': {
        // `preStart` always builds the probe for this strategy; the fallback
        // keeps the router routing rather than throwing if it ever is absent.
        const index = this.counter++;
        return this.depthProbe?.pickShallowest(this.routees, index)
          ?? this.routees[index % this.routees.length]!;
      }
      case 'broadcast': {
        // Unreachable here — `onRoutedMessage` short-circuits broadcast.
        return this.routees[0]!;
      }
    }
  }
}
