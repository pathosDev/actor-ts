import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import type { ActorClassOrFactory } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { Cancellable } from '../../Scheduler.js';
import { DeadLetter, Terminated } from '../../SystemMessages.js';
import { actorFactoryOf } from '../../internal/ActorBlueprint.js';
import { LocalActorRef } from '../../internal/LocalActorRef.js';
import { SystemGroups, singletonManagerName, systemActorPath } from '../../internal/SystemPaths.js';
import { fromNullable, type Option } from '../../util/Option.js';
import type { Cluster } from '../Cluster.js';
import type { Member } from '../Member.js';
import type { NodeAddress } from '../NodeAddress.js';
import { ClusterSingletonManagerOptionsValidator } from './ClusterSingletonManagerOptions.js';
import type { ClusterSingletonManagerOptions, ClusterSingletonManagerOptionsType } from './ClusterSingletonManagerOptions.js';
import { AuthenticatedSingletonMessage } from './SingletonProtocol.js';
import type {
  SingletonHandOverAcknowledgment,
  SingletonHandOverRequest,
  SingletonMessage,
} from './SingletonProtocol.js';
import type { ClusterEvent } from '../ClusterEvents.js';
import {
  LeaderChanged,
  MemberDown,
  MemberLeft,
  MemberRemoved,
  MemberUp,
  SelfUp,
} from '../ClusterEvents.js';
import { asWarmHandOverActor, handOverStateFitsFrame } from './WarmHandOver.js';
import {
  DEFAULT_SINGLETON_HAND_OVER_TIMEOUT_MS,
  DEFAULT_SINGLETON_MAX_HAND_OVER_STATE_BYTES,
  SINGLETON_HAND_OVER_BUFFER_SIZE,
  SINGLETON_HAND_OVER_RETRY_INTERVAL_MS,
  SINGLETON_HAND_OVER_STATE_RETENTION_MS,
  SINGLETON_HOST_DISAGREEMENT_HOLD_MS,
  SINGLETON_RESTART_BACKOFF_MS,
} from '../Constants.js';

/**
 * Path at which every node hosts its ClusterSingletonManager for a given
 * singleton typeName.  Used by the proxy/envelope layer to address the
 * manager on whichever node is currently the leader.
 */
export function singletonManagerPath(systemName: string, typeName: string): string {
  return systemActorPath(
    systemName,
    SystemGroups.clusterSingleton,
    singletonManagerName(typeName),
  );
}

/**
 * The node that hosts a singleton, given its role restriction — `none` while
 * the cluster has no eligible member.
 *
 * One function rather than two matching conditions, because the manager and the
 * proxy have to agree exactly: the manager decides whether *this* node hosts,
 * the proxy decides where to send, and a manager dead-letters anything
 * addressed to it that it is not hosting.  Any drift between the two is
 * message loss.
 *
 * The rule is shared; the *view* it reads is not.  Each node applies it to its
 * own member list, so the two agree exactly as far as gossip has converged.
 * Unreachability is where that can stay apart indefinitely, which is why it is
 * excluded from {@link changesSingletonHost} rather than reconciled on — the
 * disagreement is bounded loss, and acting on it is a second live singleton.
 *
 * Unrestricted, the host is the cluster leader.  Restricted, it is the first
 * up-member *carrying that role* — deliberately not "the leader, but only if it
 * happens to carry the role", which is what this used to be and which left the
 * singleton hosted nowhere at all whenever the elected leader lacked the role
 * (#524).  Both forms read the same address-ordered member list, so every node
 * independently picks the same one.
 */
export function singletonHost(cluster: Cluster, role?: string): Option<Member> {
  if (role === undefined) return cluster.leader();
  return fromNullable(cluster.upMembersWithRole(role)[0]);
}

/**
 * Whether `event` is one after which {@link singletonHost} may return someone
 * else.  Used by the manager (to reconcile hosting) and by the proxy (to
 * drain its buffer at the new host).
 *
 * One predicate rather than two lists, for the same reason `singletonHost` is
 * one function: the two sides have to agree on *when* to look again, not only
 * on what they see when they do.  A trigger set that drifts leaves one of them
 * acting on a host the other has not noticed — the manager keeping a child it
 * should have stopped, or the proxy sitting on a buffer it should have
 * drained.
 *
 * Both forms of the host are the **first address-ordered `up` member** (the
 * leader; or, under a role, the first carrying that role), so *every*
 * transition into or out of `up` can move it.  Watching `LeaderChanged` alone
 * was the defect (#637): it fires only when the leader's *identity* changes,
 * so a role-carrying member joining below a role-less leader announced nothing
 * at all, and the incumbent host kept its child forever while the new one
 * spawned a second — two live singletons, which is the one thing a singleton
 * exists to prevent.
 *
 * Absent on purpose:
 *
 * - `MemberJoined` / `MemberWeaklyUp` — neither `joining` nor `weakly-up`
 *   members appear in `upMembers()`, so neither status can host.
 * - `ReachabilityChanged` — this node's private opinion about a peer, which
 *   does not itself move member status.
 * - **`MemberUnreachable` / `MemberReachable`** — see below.  These *do* move
 *   `singletonHost`, and they are still excluded.
 *
 * **Why unreachability is not a trigger.**  Every other event here is a
 * membership fact the cluster agrees on: a member that is `up`, `down`,
 * `leaving` or `removed` is that on every node once gossip converges, so every
 * node computes the same host and reconciling is a race at worst.
 * Unreachability is not that fact.  It is one node's failure detector saying
 * *"I cannot reach that member"*, and the member itself — which is alive, and
 * by definition cannot hear the peers that formed the opinion — never learns
 * of it.  Reconciling on it therefore makes a peer promote itself while the
 * incumbent, told nothing, keeps its child.  No leader has moved, so nothing
 * resolves it: the cluster runs **two live singletons** for the length of the
 * outage.  #637 included these two, and that is precisely the state its own
 * headline exists to prevent.
 *
 * The cost of excluding them is real and is the lesser one: while a role host
 * is unreachable to its peers the singleton is hosted *from their point of
 * view* nowhere, and messages routed from that side dead-letter until the
 * member is downed (`downAfterMs`) or comes back.  Availability is recoverable
 * and bounded by downing; a second live singleton is neither.  On the no-lease
 * path the two properties cannot both be had — an unreachable node cannot be
 * asked to stand down, because reaching it is the thing that failed.  Where
 * both are needed, that is what the lease path is for: it is arbitrated by a
 * third party both sides *can* reach, so exactly one of them holds it.
 *
 * `reconcile` being idempotent does not buy the missing property, which is
 * what the earlier version of this note claimed.  It is idempotent *per node*
 * — "at most one cluster-wide" is not a per-node property, and no amount of
 * re-running a local decision establishes it.
 *
 * Neither exclusion loses an edge the set still needs.  The resolution of an
 * unreachability arrives as an event that *is* in the set either way: downing
 * emits `MemberDown`, and recovery emits `MemberUp` alongside
 * `MemberReachable` (an `unreachable → up` member is a status transition, so
 * `statusEventsOf` announces it as `up` before the reachability event).
 */
export function changesSingletonHost(event: ClusterEvent): boolean {
  // A match that computes a value, so its arms stay inline.  A predicate
  // rather than an exported `P.union(...)` because ts-pattern does not export
  // the type of one, and the inferred type names its internals — a shared
  // constant would compile only via a deep import into `ts-pattern/dist`.
  return match(event)
    .with(
      P.union(
        P.instanceOf(LeaderChanged),
        P.instanceOf(SelfUp),
        P.instanceOf(MemberUp),
        P.instanceOf(MemberDown),
        P.instanceOf(MemberLeft),
        P.instanceOf(MemberRemoved),
      ),
      () => true,
    )
    .otherwise(() => false);
}

/** Internal delivery wrapper — body is the user's typed message. */
export type SingletonDeliver = {
  readonly kind: 'singleton-deliver';
  readonly body: unknown;
};

/* --------------------- internal mailbox events --------------------- */
/**
 * The lease-aware path uses internal events instead of inline awaits so
 * cluster-event triggers can't interleave their `reconcile` calls with
 * an in-flight `lease.acquire()`.  Every state transition arrives as a
 * single message in this manager's own mailbox — including the two that
 * originate on a scheduler tick, which fires outside a message turn.
 */
type ReconcileEvent = { readonly kind: 'reconcile' };
type LeaseAcquireResultEvent = {
  readonly kind: 'lease-acquire-result';
  readonly got: boolean;
  readonly error?: Error;
};
type LeaseLostEvent = { readonly kind: 'lease-lost'; readonly reason: string };
type AcquireRetryEvent = { readonly kind: 'acquire-retry' };
type RestartChildEvent = { readonly kind: 'restart-child' };
type HandOverTimeoutEvent = { readonly kind: 'hand-over-timeout' };
type HandOverRetryEvent = { readonly kind: 'hand-over-retry' };
type HostDisagreementHoldExpiredEvent = { readonly kind: 'host-disagreement-hold-expired' };
type HandOverStateExpiredEvent = { readonly kind: 'hand-over-state-expired' };

type ManagerEvent =
  | ReconcileEvent
  | LeaseAcquireResultEvent
  | LeaseLostEvent
  | AcquireRetryEvent
  | RestartChildEvent
  | HandOverTimeoutEvent
  | HandOverRetryEvent
  | HostDisagreementHoldExpiredEvent
  | HandOverStateExpiredEvent;

type Inbox = SingletonDeliver | ManagerEvent | Terminated | AuthenticatedSingletonMessage;

/**
 * The peers a started hand-over is still waiting on, and the deadline that
 * ends the wait whether they answer or not.
 *
 * A set of address strings rather than of `NodeAddress`, because `NodeAddress`
 * has no value identity — the whole cluster keys on `toString()` for exactly
 * this reason.
 */
type PendingHandOver = {
  readonly awaiting: Set<string>;
  readonly timer: Cancellable;
  /** Re-sends the request to whoever is still on {@link awaiting}. */
  readonly retryTimer: Cancellable;
  /** Messages routed here while the wait is on; flushed into the child on spawn. */
  readonly held: unknown[];
  /**
   * A predecessor's warm state, if one arrived on an acknowledgment (#194).
   *
   * Mutable, and on the wait rather than on the manager, so it cannot outlive
   * the hand-over that collected it: state from a wait that was abandoned is
   * state for an instance that will not be spawned, and applying it to a later,
   * unrelated spawn would restore a snapshot the cluster has since moved past.
   */
  state: Uint8Array | null;
};

/**
 * Runs on every node.  Watches cluster events and (re)spawns the singleton
 * child when this node is the cluster leader; stops the child when it is not.
 * Remote Envelopes addressed to the singleton land here and are forwarded to
 * the child — if this node is not hosting, the envelope goes to
 * `system.deadLetters` with a latched warning (see {@link onSingletonDeliver}).
 *
 * **Two paths:**
 *
 * - **No lease (default).**  Reconcile straight from the cluster-event
 *   subscriber, so a change of host is visible the moment the event fires.
 * - **With lease.**  Async reconcile that gates child-spawn on
 *   `lease.acquire()`, watches `lease.onLost(...)` for revocation, and
 *   `release()`s on graceful handover.  All state transitions go through
 *   the manager's own mailbox so concurrent cluster events can't race
 *   with an in-flight acquire.
 *
 * **Both paths ask before they host** (#949).  Deciding locally is what
 * produced two live singletons on a routine scale-up: the incoming host
 * promotes itself off its own `SelfUp` — before gossip has told any peer
 * anything — while the incumbent stops its child with a `PoisonPill` that sits
 * behind that child's whole mailbox.  So `spawn()` is now reached through
 * {@link takeOverHosting}, which first sends a
 * {@link SingletonHandOverRequest} to every eligible peer and waits for each
 * to confirm its instance is gone.
 *
 * The wait is bounded by `handOverTimeoutMs` and **ends in a spawn either
 * way**: a peer that cannot answer is a peer that cannot be asked to stand
 * down, so on the no-lease path "hosted somewhere" and "at most one" cannot
 * both be guaranteed — availability is the one chosen, with a `warn` saying
 * the invariant was not proven.  Where it must be, that is what the lease path
 * is for; and there the invariant does not rest on the timeout at all, because
 * the lease is only released once the outgoing child's `Terminated` has
 * actually been observed.
 */
export class ClusterSingletonManager<T> extends Actor<Inbox> {
  private child: ActorRef<T> | null = null;
  /**
   * The previous child while it is mid-stop.  We watch every child we
   * spawn (see `spawn()`), and when leadership flips we move
   * `this.child` here, send `PoisonPill`, and wait for the
   * `Terminated` system message before allowing another `spawn()`.
   * Without this, a fast leader-flap (or two cluster events back-to-
   * back from `handleLeave`) reaches `spawn` while the previous
   * child cell is still in the parent's `_children` map — the new
   * spawn fails with "Child name 'X' is not unique".  It also avoids
   * spawning a second user actor (e.g. a fresh `HttpIngressActor`
   * trying to bind port 8080) before the previous one has finished
   * `postStop` and released its resources.
   */
  private pendingStop: ActorRef<T> | null = null;
  private unsubscribeCluster: (() => void) | null = null;
  private unsubscribeLeaseLost: (() => void) | null = null;
  private retryTimer: Cancellable | null = null;
  /** Backoff timer between an unexpected child death and its re-spawn (#1175). */
  private restartTimer: Cancellable | null = null;

  /** Lease lifecycle — only used when `options.lease` is set. */
  private leaseState: 'none' | 'acquiring' | 'held' = 'none';

  /**
   * The hand-over this node started, while peers are still answering it —
   * `null` whenever no request is outstanding.  See {@link takeOverHosting}.
   */
  private handOver: PendingHandOver | null = null;

  /**
   * Peers that asked *this* node to hand over while it still had an instance
   * running, keyed by address string.  Each is answered once the child's
   * `Terminated` lands — never when the `PoisonPill` is merely enqueued, which
   * is the difference between a hand-over and a hope.
   */
  private readonly handOverRequesters = new Map<string, NodeAddress>();

  /**
   * Messages routed here while this node does not (yet) consider itself the
   * host — see {@link holdWhileHostingIsUndecided}.  Flushed by {@link spawn},
   * dead-lettered by {@link dropHostDisagreementHold}.
   */
  private readonly hostDisagreementHold: unknown[] = [];

  /** Backstop that ends {@link hostDisagreementHold} if no reconcile does. */
  private hostDisagreementHoldTimer: Cancellable | null = null;

  /**
   * A snapshot this node's stopped instance left for a successor that had not
   * asked yet — see {@link retainHandOverState} (#194).
   */
  private retainedHandOverState: Uint8Array | null = null;

  /** Expiry for {@link retainedHandOverState}. */
  private retainedHandOverStateTimer: Cancellable | null = null;

  /**
   * Whether `lease.release()` still owes the outgoing child a `Terminated`.
   *
   * Releasing is what lets a follower acquire and spawn, so releasing while
   * this node's instance is still draining hands the lease's whole guarantee
   * away — the follower's `acquire()` succeeds against a singleton that is
   * still running (#949).  Set on the step-down path and discharged in
   * {@link handleTerminated}.
   */
  private releaseLeaseWhenChildStops = false;

  /**
   * Latched when the child died unexpectedly while `restartOnTermination` was
   * off — see {@link onChildDiedUnexpectedly}.
   *
   * Without it "do not re-spawn" only holds until the next reconcile, because
   * both reconcile paths decide from `want && no child` and that is
   * indistinguishable from "never spawned at all".  It was survivable while
   * `LeaderChanged` was the only membership trigger — in a stable cluster it
   * may never fire again — and stops being survivable now that every up/down
   * transition of any member reconciles (#637).
   *
   * A latch on *this manager*, deliberately, not on the singleton: the node
   * that opted out goes out of rotation until its manager is restarted
   * (`cluster.singleton.stop()` then `start()`), while every other node stays
   * free to host.  That is what releasing the lease is for, and holding the
   * latch narrower — say, until the host moves away and back — would put this
   * node's own reconcile straight back where the opt-out was meant to stop it.
   */
  private terminallyStopped = false;

  /** Latch for the "routed here but not hosting" warning — see {@link warnNotHostedOnce}. */
  private warnedNotHosted = false;

  /**
   * Callback the extension hands us so it can drop this manager from its
   * registry.  Fired for *every* way a manager dies — an explicit
   * `cluster.singleton.stop`, a supervision decision, or system shutdown — so
   * the registry stays derived from actor liveness instead of being a second
   * set of books that can drift out of sync with it.
   */
  _onStopped: (() => void) | null = null;

  readonly options: ClusterSingletonManagerOptionsType<T>;

  constructor(options: ClusterSingletonManagerOptions<T>) {
    super();
    this.options = options as ClusterSingletonManagerOptionsType<T>;
    new ClusterSingletonManagerOptionsValidator<T>().validate(this.options);
  }

  override preStart(): void {
    const cluster = this.options.cluster;
    // No-lease path stays sync: cluster events drive `reconcileSync()`
    // directly, so a change of host is visible the moment the event
    // fires.  This preserves the v1 timing guarantee (proxies can ask
    // the cluster for the host and immediately route).
    //
    // With a lease, every state transition has to flow through the
    // manager's own mailbox so concurrent cluster events can't race
    // with an in-flight `acquire()` — see `handleReconcile`.
    this.unsubscribeCluster = cluster.subscribe((evt) =>
      match(evt)
        .with(P.when(changesSingletonHost), () => this.onClusterMembershipChanged())
        .otherwise(() => this.onOtherClusterEvent()),
    );

    if (this.options.lease) {
      this.unsubscribeLeaseLost = this.options.lease.onLost((reason) => {
        this.self.tell({ kind: 'lease-lost', reason } satisfies ManagerEvent);
      });
      // Lease path: kick the initial reconcile via the mailbox.
      this.self.tell({ kind: 'reconcile' } satisfies ManagerEvent);
    } else {
      this.reconcileSync();
    }
  }

  private onClusterMembershipChanged(): void {
    if (this.options.lease) {
      this.self.tell({ kind: 'reconcile' } satisfies ManagerEvent);
    } else {
      this.reconcileSync();
    }
  }

  private onOtherClusterEvent(): void {
    /* other events ignored */
  }

  override async postStop(): Promise<void> {
    this.unsubscribeCluster?.();
    this.unsubscribeLeaseLost?.();
    this._onStopped?.();
    this.retryTimer?.cancel();
    this.restartTimer?.cancel();
    if (this.child) { this.child.stop(); this.child = null; }
    // Drop any in-flight stop — the parent termination cascade will
    // tear it down regardless, and we no longer need to react to its
    // Terminated message.
    this.pendingStop = null;
    // A hand-over this node was waiting on can no longer end in a spawn, and
    // whatever it was holding for that spawn has nowhere to go.  Peers that
    // asked *us* to stand down are answered: a manager going away is the
    // strongest form of "not hosting" there is, and leaving them to time out
    // would make an orderly `cluster.singleton.stop()` slower than a crash.
    this.abandonHandOver('the manager is stopping');
    this.dropHostDisagreementHold('the manager is stopping');
    // The requesters are answered without state: `child.stop()` above has only
    // *enqueued* the PoisonPill, so the instance's `postStop` has not run and
    // anything read from it would be a snapshot from before it finished (#194).
    // A retained one from an earlier stand-down is equally unusable — this
    // manager is going away, so the answer it owes is "not hosting", not a
    // generation of state whose age it can no longer bound.
    this.dropRetainedHandOverState();
    this.answerHandOverRequesters();
    // Release the lease if held — the holder leaving cleanly lets a
    // follower acquire faster than waiting for the TTL to expire.
    if (this.options.lease && this.leaseState === 'held') {
      try { await this.options.lease.release(); } catch { /* best-effort */ }
      this.leaseState = 'none';
    }
  }

  override onReceive(message: Inbox): void | Promise<void> {
    if (message instanceof Terminated) {
      return this.handleTerminated(message);
    }
    // Not a `match` arm: a class instance is what proves the frame came
    // through the authenticated per-path handler, and `ts-pattern`'s
    // `P.instanceOf` beside object patterns would make that provenance check
    // read like one more shape test among equals.  See
    // {@link AuthenticatedSingletonMessage}.
    if (message instanceof AuthenticatedSingletonMessage) {
      return this.onAuthenticatedSingletonMessage(message);
    }
    return match(message)
      .with({ kind: 'singleton-deliver' }, (m) => this.onSingletonDeliver(m))
      .with({ kind: 'reconcile' }, () => this.onReconcile())
      .with({ kind: 'lease-acquire-result' }, (m) => this.onLeaseAcquireResult(m))
      .with({ kind: 'lease-lost' }, (m) => this.onLeaseLost(m))
      .with({ kind: 'acquire-retry' }, () => this.onAcquireRetry())
      .with({ kind: 'restart-child' }, () => this.onRestartChild())
      .with({ kind: 'hand-over-timeout' }, () => this.onHandOverTimeout())
      .with({ kind: 'hand-over-retry' }, () => this.onHandOverRetry())
      .with({ kind: 'host-disagreement-hold-expired' }, () =>
        this.onHostDisagreementHoldExpired())
      .with({ kind: 'hand-over-state-expired' }, () => this.onHandOverStateExpired())
      .otherwise((m) => this.onUnhandled(m));
  }

  /** One of {@link SingletonMessage}, stamped with the peer it arrived from. */
  private onAuthenticatedSingletonMessage(envelope: AuthenticatedSingletonMessage): void {
    match(envelope.message)
      .with({ kind: 'singleton.HandOverRequest' }, (m) => this.onHandOverRequest(m, envelope.peer))
      .with({ kind: 'singleton.HandOverAcknowledgment' }, (m) =>
        this.onHandOverAcknowledgment(m, envelope.peer))
      .otherwise((m) => this.onUnhandled(m));
  }

  /**
   * The manager sits at a resolvable path, so anything a peer addresses to it
   * lands here — and `.exhaustive()` turned an unrecognised body into an actor
   * failure, taking the singleton's supervision with it (#713).  A message we
   * do not understand is not a reason to fall over.
   *
   * It is a reason to leave a trace, though: `this.unhandled` puts the
   * message on the dead-letter path and counts it (#1178), so a rolling
   * upgrade that starts speaking a frame this manager predates is visible as
   * a rate rather than as one warn line scrolling past.
   */
  private onUnhandled(message: unknown): Promise<void> | void {
    this.log.warn(
      `singleton manager: dropping an unrecognised message `
      + `(${(message as { kind?: string })?.kind ?? typeof message})`,
    );
    this.unhandled(message);
  }

  private onReconcile(): Promise<void> {
    return this.handleReconcile();
  }

  private onAcquireRetry(): Promise<void> {
    return this.handleReconcile();
  }

  /**
   * Death-watch callback for the previous singleton child.  Fires once
   * `pendingStop` has fully terminated (postStop run, cell removed
   * from the parent's children map).  At that point it's safe to
   * spawn a fresh child, so we re-run the reconcile logic — if we're
   * still the leader, a new child will be created here.
   *
   * It is also the **only** honest moment for the two things a hand-over turns
   * on: answering a peer that asked us to stand down, and releasing a lease we
   * were holding.  Both used to happen as soon as the `PoisonPill` was
   * enqueued, which says nothing at all about whether the instance is gone
   * (#949).
   *
   * `async` so the reconcile that follows cannot start before the release has
   * settled — a mailbox turn is awaited, so nothing else interleaves.
   */
  private async handleTerminated(t: Terminated): Promise<void> {
    if (this.pendingStop && t.actor.equals(this.pendingStop)) {
      this.log.debug(
        `previous child '${this.options.typeName}' fully terminated — re-running reconcile`,
      );
      // Before `pendingStop` is cleared, and before the answer goes out: this
      // is the one instant at which the instance's state is both final and
      // still readable (#194).  `postStop` has completed, so nothing more will
      // be processed; the cell still holds the instance, so it can still be
      // asked.
      const warmState = this.captureWarmState(this.pendingStop);
      this.pendingStop = null;
      // Now, and not when `stopChild` returned: this is the instant at which
      // this node has genuinely stopped hosting.
      const answered = this.answerHandOverRequesters(warmState);
      // Nobody had asked yet, which is the common order rather than an edge —
      // both nodes reconcile from their own gossip, so the outgoing host often
      // stops first and is asked a moment later.  Keep the snapshot for that
      // request; see {@link retainHandOverState} for why briefly and once.
      if (!answered && warmState !== null) this.retainHandOverState(warmState);
      if (this.releaseLeaseWhenChildStops) {
        this.releaseLeaseWhenChildStops = false;
        await this.releaseLease();
      }
      // Re-trigger the appropriate reconcile path; either branch is
      // safe to call when the singleton state is "no child running".
      if (this.options.lease) {
        this.self.tell({ kind: 'reconcile' } satisfies ManagerEvent);
      } else {
        this.reconcileSync();
      }
      return;
    }
    if (this.child && t.actor.equals(this.child)) {
      this.onChildDiedUnexpectedly();
      // After, not before: `onChildDiedUnexpectedly` is what clears
      // `this.child`, and the answer is only true once it has.  A death nobody
      // asked for still ends the hosting, so a peer waiting on our hand-over
      // must not be left to time out over it.
      this.answerHandOverRequesters();
    }
  }

  /**
   * The child died without us asking — `context.stopSelf()`, or a supervision
   * budget exhausted and the supervisor stopping it.
   *
   * This used to be no branch at all, and the consequence was severe out of
   * proportion to the omission (#1175).  `this.child` kept pointing at the
   * dead ref, so every routed message was forwarded into a dead letter; and
   * cluster-wide the singleton simply no longer existed, with nothing to
   * revive it until the next `LeaderChanged` — which in a stable cluster may
   * be never.  With a lease it was worse still: the manager stayed alive
   * holding and renewing a lease over a dead child, so no other node could
   * take over either.  The one mechanism meant to guarantee "exactly one"
   * guaranteed zero, indefinitely.
   */
  private onChildDiedUnexpectedly(): void {
    this.child = null;
    if (this.options.restartOnTermination ?? true) {
      this.log.warn(
        `singleton '${this.options.typeName}' terminated unexpectedly — `
        + `re-spawning in ${SINGLETON_RESTART_BACKOFF_MS} ms`,
      );
      this.restartTimer?.cancel();
      this.restartTimer = this.system.scheduler.scheduleOnceFunction(
        SINGLETON_RESTART_BACKOFF_MS,
        () => {
          this.restartTimer = null;
          // Through the mailbox rather than acting here: the timer fires
          // outside a message turn, and every other state transition in this
          // manager arrives as a message for exactly that reason.
          this.self.tell({ kind: 'restart-child' } satisfies ManagerEvent);
        },
      );
      return;
    }
    // Opt-out: the actor treats stopping as a terminal state.  Do not respawn
    // — but do let go of the lease, or this node keeps renewing a claim on a
    // singleton nobody is running and no other node can host it either.
    this.log.warn(
      `singleton '${this.options.typeName}' terminated unexpectedly and `
      + `restartOnTermination is off — not re-spawning`,
    );
    this.terminallyStopped = true;
    // Nothing held for a spawn that is never coming: from here `wantHosted()`
    // is permanently false, so the hold has no view left to catch up to (#637).
    this.dropHostDisagreementHold('this node has opted out of hosting the singleton');
    void this.releaseLease();
  }

  /**
   * Give the lease up, best-effort — never throws, and a no-op unless one is
   * held.
   *
   * `leaseState` goes to `'none'` **ahead of the await**, not after it: a
   * reconcile landing in the await window would otherwise still read `'held'`
   * and issue a second release.
   */
  private async releaseLease(): Promise<void> {
    if (!this.options.lease || this.leaseState !== 'held') return;
    this.leaseState = 'none';
    try { await this.options.lease.release(); }
    catch (e) { this.log.warn(`lease release failed`, e); }
  }

  /**
   * Re-spawn after the backoff.  Re-checks the world rather than trusting the
   * state it was scheduled in: leadership can move, and the lease can be lost,
   * during the wait.
   */
  private onRestartChild(): void {
    if (!this.wantHosted()) return;              // leadership moved meanwhile
    if (this.child || this.pendingStop) return;  // something already took over
    if (this.options.lease && this.leaseState !== 'held') {
      // The lease went away while we waited — the acquire path owns the
      // respawn from here, and `spawn()` must not run without the lease.
      this.self.tell({ kind: 'reconcile' } satisfies ManagerEvent);
      return;
    }
    // Deliberately `spawn()` and not `handleReconcile()`: with a lease still
    // held, reconcile reads `leaseState === 'held'` as "already running" and
    // returns without spawning anything.
    this.spawn();
  }

  /* -------------------------- handlers -------------------------- */

  /**
   * A message a proxy routed here.  When this node is not hosting, it goes to
   * `system.deadLetters` rather than being dropped on the floor.
   *
   * The proxy already dead-letters on both of *its* undeliverable paths
   * (`bufferUntilHosted` past the cap, `onMissingHost`), and this one is the
   * same event seen from the other end of the wire — a message the singleton
   * will never receive.  Dropping it here left that fact in a log line only:
   * nothing on the dead-letter stream, so no metric, no DevTools entry, and
   * nothing a test could assert.
   *
   * It is not a rare path.  The proxy and the manager compute the host from
   * the same `singletonHost`, but they do it from *different nodes' views*,
   * and a one-sided unreachability makes those views disagree by construction:
   * the peers of an unreachable role host route to the next role member, which
   * is not hosting and — deliberately, see {@link changesSingletonHost} — will
   * not promote itself.  Every message sent from that side lands here.
   */
  private onSingletonDeliver(message: SingletonDeliver): void {
    if (message.kind !== 'singleton-deliver') return;
    if (!this.child) {
      // This node *is* the elected host and the child is merely not spawned
      // yet, because a peer has not finished standing down.  Holding is not a
      // nicety here: the hand-over wait is a window this manager opened
      // itself, so dead-lettering through it would pay for "at most one
      // instance" with message loss on every host move (#949).
      if (this.handOver !== null && this.holdUntilHandOverCompletes(message.body)) return;
      // The same window one step earlier, and the half #949 left open (#637):
      // this node has not concluded it is the host *yet*, so there is no
      // hand-over to hold against — but a peer routed here, which is that peer
      // saying it is.  Hold rather than dead-letter while the two views
      // disagree; see {@link holdWhileHostingIsUndecided}.
      if (this.holdWhileHostingIsUndecided(message.body)) return;
      this.warnNotHostedOnce();
      // The manager, not `/deadLetters`, is the recipient: this node was
      // addressed as the singleton's host and could not deliver, and the
      // manager's path is what identifies *which* singleton and *which*
      // node that was.  The body is unwrapped so the letter carries what
      // the application sent, not the transport frame around it.
      this.system.deadLetters.tell(
        new DeadLetter(message.body, this.sender.toNullable(), this.self),
      );
      return;
    }
    this.child.tell(message.body as never);
  }

  /**
   * Latched like the proxy's own two warnings, and for the same reason: the
   * condition lasts as long as the outage does while the sender keeps sending,
   * so one line per message is a log flood, not a diagnostic.  `spawn()`
   * unlatches it, so a second, later episode is reported too.
   */
  private warnNotHostedOnce(): void {
    if (this.warnedNotHosted) return;
    this.warnedNotHosted = true;
    this.log.warn(
      `singleton '${this.options.typeName}' not currently hosted on this node — `
      + 'messages addressed to it are going to dead letters.  A proxy routed here, so '
      + 'this node is the elected host in the view of whoever sent, and not in its own; '
      + 'check for an unreachable member the two sides disagree about.',
    );
  }

  /** Sync reconcile — no lease.  Spawn / stop the child to match cluster state. */
  private reconcileSync(): void {
    const want = this.wantHosted();
    this.log.debug(
      `reconcile '${this.options.typeName}': want=${want} child=${this.child !== null} pendingStop=${this.pendingStop !== null}`,
    );
    if (want && !this.child) {
      this.takeOverHosting();
    } else if (!want && this.child) {
      this.stopChild('leader moved away or role lost');
    }
  }

  private async handleReconcile(): Promise<void> {
    // Lease-gated path only — the no-lease path goes through
    // `reconcileSync` directly from the cluster-event subscriber.
    if (!this.options.lease) { this.reconcileSync(); return; }
    const want = this.wantHosted();
    if (want) {
      if (this.leaseState === 'held') {
        // `'held'` is **not** `'running'`, and reading it as "already running"
        // was a live dead end (#949).  `onLeaseLost` and an unexpected child
        // death both leave the lease held with no child; a `spawn()` racing a
        // still-set `pendingStop` early-returns; and every reconcile after that
        // returned here — so the manager renewed a lease over nothing,
        // permanently, and no other node could host either.  That is the
        // #1175 shape reached by a path #1175 did not close.  `onRestartChild`
        // already had to sidestep this branch for the same reason.
        this.takeOverHosting();
        return;
      }
      if (this.leaseState === 'acquiring') return;     // already in flight
      // Cancel a retry if one is pending — we're starting a fresh attempt now.
      this.retryTimer?.cancel();
      this.retryTimer = null;
      this.leaseState = 'acquiring';
      void this.runAcquire();
    } else {
      if (this.leaseState === 'held') {
        this.stopChild('leader moved away or role lost');
        // The release is deferred until the child's `Terminated` arrives —
        // releasing now is handing a follower permission to spawn against an
        // instance that is still draining, which is the whole failure the
        // lease exists to prevent (#949).  `handleTerminated` discharges it.
        //
        // `pendingStop` and not "did `stopChild` have a child": six events
        // reconcile, so a *second* one lands while the first one's instance is
        // still draining, finds `child` already null, and would read that as
        // "nothing to wait for" — releasing exactly as early as the code this
        // replaced.
        if (this.pendingStop) { this.releaseLeaseWhenChildStops = true; return; }
        await this.releaseLease();
      } else if (this.leaseState === 'acquiring') {
        // Let the in-flight acquire finish — `onLeaseAcquireResult` will
        // re-check `wantHosted` and immediately release if it succeeded
        // while we were no longer interested.
      } else {
        this.retryTimer?.cancel();
        this.retryTimer = null;
      }
    }
  }

  private async runAcquire(): Promise<void> {
    try {
      const got = await this.options.lease!.acquire();
      this.self.tell({ kind: 'lease-acquire-result', got } satisfies ManagerEvent);
    } catch (error) {
      this.self.tell({
        kind: 'lease-acquire-result', got: false, error: error as Error,
      } satisfies ManagerEvent);
    }
  }

  private onLeaseAcquireResult(message: LeaseAcquireResultEvent): void {
    if (this.leaseState !== 'acquiring') {
      // Spurious result — manager was reset or stopped while we were
      // awaiting.  If we somehow got the lease, release it best-effort
      // so we don't hold onto a slot we don't want.
      if (message.got) void this.options.lease!.release().catch(() => {});
      return;
    }
    if (!message.got) {
      // Acquire failed (another holder, or backend error).  Retry on
      // the configured interval.  We log the error if there was one.
      if (message.error) this.log.warn(`lease acquire failed`, message.error);
      this.leaseState = 'none';
      this.scheduleAcquireRetry();
      return;
    }
    // Got the lease.  Re-check whether we still want to be hosted —
    // membership may have flipped while we were awaiting.
    if (!this.wantHosted()) {
      void this.options.lease!.release().catch((e) =>
        this.log.warn(`lease release after stale acquire failed`, e));
      this.leaseState = 'none';
      return;
    }
    this.leaseState = 'held';
    // Through the hand-over rather than straight to `spawn()`, even though the
    // lease already serialises: a previous holder that *lost* the lease rather
    // than releasing it never observed its own child's `Terminated`, so
    // holding the lease is not by itself proof that no instance is left
    // running.  In the ordinary case every peer answers at once, because the
    // release the acquire waited on already implied a completed `postStop`.
    this.takeOverHosting();
  }

  private onLeaseLost(message: LeaseLostEvent): void {
    if (this.leaseState !== 'held') return;     // stale callback
    this.log.warn(`singleton '${this.options.typeName}': lease lost — ${message.reason}; stopping child`);
    this.stopChild(`lease lost: ${message.reason}`);
    this.leaseState = 'none';
    // If we're still the elected leader, kick a fresh reconcile so we try to
    // re-acquire — but **not before the child is gone**.  Re-entering
    // `acquiring` here is how the manager used to end up holding a fresh lease
    // over no child at all: the acquire can resolve while the old instance is
    // still in `postStop`, and the `spawn()` that followed early-returned on
    // `pendingStop` (#949).  `handleTerminated` posts the reconcile once
    // `Terminated` lands, so only the nothing-to-wait-for case needs one here —
    // and that is `pendingStop`, not "did `stopChild` have a child": an instance
    // already mid-stop when the lease went is still an instance to wait for.
    if (!this.pendingStop) this.self.tell({ kind: 'reconcile' } satisfies ManagerEvent);
  }

  /* ------------------------ the hand-over ------------------------ */

  /**
   * The one door to `spawn()` on a change of host: ask every eligible peer to
   * stand down, and host once each has confirmed it has (#949).
   *
   * Idempotent, and deliberately re-entered rather than queued — a second
   * cluster event landing while a request is outstanding must not start a
   * second one, because the peers would then answer a wait that is no longer
   * being counted.
   *
   * `onRestartChild` keeps going straight to `spawn()`, and that is not an
   * oversight: a backoff respawn after this node's *own* instance died is not a
   * change of host, so no other node has anything to stand down from.
   */
  private takeOverHosting(): void {
    // `spawn()`'s own two guards, checked before spending a round trip: with a
    // child there is nothing to take over, and with a `pendingStop` the spawn
    // would early-return and `handleTerminated` reconciles again anyway.
    if (this.child || this.pendingStop) return;
    if (this.handOver !== null) return;
    const peers = this.handOverPeers();
    if (peers.length === 0) {
      // Single eligible node — nobody to ask, so the v1 timing guarantee is
      // untouched: the child exists the moment gossip says this node hosts.
      this.spawn();
      return;
    }
    const timeoutMs = this.options.handOverTimeoutMs ?? DEFAULT_SINGLETON_HAND_OVER_TIMEOUT_MS;
    // Never longer than the deadline it lives inside — a caller that configures
    // a 100 ms timeout must still get at least one attempt.
    const retryIntervalMs = Math.min(SINGLETON_HAND_OVER_RETRY_INTERVAL_MS, timeoutMs);
    this.handOver = {
      awaiting: new Set(peers.map((peer) => peer.toString())),
      // Through the mailbox, not acted on in the callback: a scheduler tick
      // fires outside a message turn, and every other transition in this
      // manager arrives as a message for that reason.
      timer: this.system.scheduler.scheduleOnceFunction(timeoutMs, () => {
        this.self.tell({ kind: 'hand-over-timeout' } satisfies ManagerEvent);
      }),
      retryTimer: this.system.scheduler.scheduleAtFixedRateFunction(
        retryIntervalMs, retryIntervalMs,
        () => this.self.tell({ kind: 'hand-over-retry' } satisfies ManagerEvent),
      ),
      held: [],
      state: null,
    };
    this.log.debug(
      `singleton '${this.options.typeName}': asking ${peers.length} peer(s) to hand over `
      + `— [${peers.map((peer) => peer.toString()).join(', ')}]`,
    );
    this.sendHandOverRequestTo(peers);
  }

  /**
   * Re-ask whoever has not answered yet — and stop waiting on anyone who has
   * meanwhile left the set that could be hosting.
   *
   * The re-send is load-bearing rather than belt-and-braces; see
   * {@link SINGLETON_HAND_OVER_RETRY_INTERVAL_MS}.  The pruning is the other
   * half of the same problem: a peer that goes `down` or `leaving` mid-hand-over
   * will never answer, and by this node's own view it can no longer be hosting
   * — so continuing to wait on it would spend the whole `handOverTimeoutMs` on a
   * question that has already been settled, and end in the warning that says the
   * invariant could not be proven when in fact it was.
   */
  private onHandOverRetry(): void {
    const pending = this.handOver;
    if (pending === null) return;
    const eligible = this.handOverPeers();
    const stillEligible = new Set(eligible.map((address) => address.toString()));
    for (const awaited of [...pending.awaiting]) {
      if (!stillEligible.has(awaited)) {
        this.log.debug(
          `singleton '${this.options.typeName}': ${awaited} left the eligible set — `
          + 'no longer waiting on its hand-over',
        );
        pending.awaiting.delete(awaited);
      }
    }
    if (pending.awaiting.size === 0) { this.completeHandOver(); return; }
    this.sendHandOverRequestTo(
      eligible.filter((address) => pending.awaiting.has(address.toString())),
    );
  }

  private sendHandOverRequestTo(peers: readonly NodeAddress[]): void {
    const request: SingletonHandOverRequest = {
      kind: 'singleton.HandOverRequest',
      typeName: this.options.typeName,
    };
    for (const peer of peers) this.sendToPeer(peer, request);
  }

  /**
   * Every node other than this one that could currently be running the
   * singleton, from this node's own view.
   *
   * The eligible set — up members, or up members carrying the role — rather
   * than a remembered predecessor, for two reasons the issue's own sketch does
   * not cover.  A node that has just *joined* has no remembered predecessor at
   * all, and joining is the common case (a node promotes itself off its own
   * `SelfUp`).  And a remembered one is stale exactly when it matters, which is
   * the failure this protocol exists to close.  The eligible set is by contract
   * the set of nodes running a manager — the docs require `start()` on every
   * node that may become the host, and a host that never called it hosts
   * nothing — and the outgoing host is by definition its first member, so
   * asking all of them cannot miss it.
   *
   * Unreachable members are absent, because `upMembers()` drops them.  That is
   * the honest shape of the guarantee: a node this one cannot reach cannot be
   * asked to stand down, and pretending otherwise is what
   * {@link changesSingletonHost} refuses to do for the same reason.
   */
  private handOverPeers(): NodeAddress[] {
    const cluster = this.options.cluster;
    const eligible = this.options.role === undefined
      ? cluster.upMembers()
      : cluster.upMembersWithRole(this.options.role);
    return eligible
      .map((member) => member.address)
      .filter((address) => !address.equals(cluster.selfAddress));
  }

  /**
   * A peer confirmed it is not running the singleton.  Hosting begins once the
   * last outstanding one has answered.
   */
  private onHandOverAcknowledgment(
    message: SingletonHandOverAcknowledgment,
    peer: NodeAddress,
  ): void {
    const pending = this.handOver;
    if (pending === null) return;                                // timed out, or never asked
    if (message.typeName !== this.options.typeName) return;
    // An answer from someone we did not ask is not evidence about anyone we
    // did, so it must not shrink the wait.
    if (!pending.awaiting.delete(peer.toString())) return;
    this.acceptWarmState(pending, message.state, peer);
    if (pending.awaiting.size > 0) return;
    this.log.debug(`singleton '${this.options.typeName}': hand-over acknowledged by every peer`);
    this.completeHandOver();
  }

  /**
   * Nobody answered in time.  **Host anyway**, and say so.
   *
   * This is the deliberate choice between the two properties that cannot both
   * be had here.  A peer that does not answer is either unreachable — in which
   * case asking it to stand down is precisely what failed — or it believes it
   * is still the host and declined.  Waiting forever would leave the singleton
   * hosted nowhere for the length of the outage; hosting means the uniqueness
   * invariant was *not proven*, which is a different thing from being upheld.
   *
   * Where the invariant has to survive that, the answer is a `lease`: a third
   * party both sides can reach is the only arbiter available when the two
   * cannot reach each other.
   */
  private onHandOverTimeout(): void {
    const pending = this.handOver;
    if (pending === null) return;                                // already settled
    const timeoutMs = this.options.handOverTimeoutMs ?? DEFAULT_SINGLETON_HAND_OVER_TIMEOUT_MS;
    this.log.warn(
      `singleton '${this.options.typeName}': [${[...pending.awaiting].join(', ')}] did not `
      + `acknowledge the hand-over within ${timeoutMs}ms — hosting anyway.  Availability was `
      + 'chosen over uniqueness: those peers are unreachable from here, or still believe they '
      + 'host, so a second live instance is possible until membership converges.  Configure a '
      + 'lease if "at most one" has to hold through this.',
    );
    this.completeHandOver();
  }

  /** Discharge the wait — flush what it held, then host. */
  private completeHandOver(): void {
    const pending = this.handOver;
    if (pending === null) return;
    pending.timer.cancel();
    pending.retryTimer.cancel();
    this.handOver = null;
    // Re-checked rather than trusted: membership can move, and a lease can be
    // lost, while the request is outstanding.
    if (!this.wantHosted()) { this.dropHeld(pending.held, 'the host moved away again'); return; }
    if (this.options.lease && this.leaseState !== 'held') {
      this.dropHeld(pending.held, 'the lease was lost while the hand-over was outstanding');
      return;
    }
    // The predecessor's snapshot, if one came, goes in *with* the spawn — it has
    // to reach the instance before `preStart`, so it cannot be applied after
    // (#194).  See {@link warmedActorFactory}.
    this.spawn(pending.state);
    if (this.child === null) {
      // `spawn()` refused — a `pendingStop` appeared during the wait.  Its
      // `Terminated` reconciles again, but this buffer cannot survive to that
      // spawn without becoming an unbounded second queue.
      this.dropHeld(pending.held, "this node's own previous instance is still stopping");
      return;
    }
    for (const body of pending.held) this.child.tell(body as never);
  }

  /**
   * Abandon a wait that can no longer end in a spawn.  Only the manager
   * stopping gets here — every other exit goes through
   * {@link completeHandOver}, which is what keeps "the wait always ends" true.
   */
  private abandonHandOver(reason: string): void {
    const pending = this.handOver;
    if (pending === null) return;
    pending.timer.cancel();
    pending.retryTimer.cancel();
    this.handOver = null;
    this.dropHeld(pending.held, reason);
  }

  /**
   * Hold a routed message for the duration of the wait, up to
   * {@link SINGLETON_HAND_OVER_BUFFER_SIZE}.  `false` means the cap is reached
   * and the caller should dead-letter instead.
   *
   * Drops the *newest* past the cap, like the proxy's own buffer and for the
   * same reason: the buffer exists to preserve the order the caller sent in,
   * and dropping from the front hands the singleton a torn prefix of it.
   */
  private holdUntilHandOverCompletes(body: unknown): boolean {
    const pending = this.handOver;
    if (pending === null) return false;
    if (pending.held.length >= SINGLETON_HAND_OVER_BUFFER_SIZE) return false;
    pending.held.push(body);
    return true;
  }

  /**
   * Hold a routed message while this node and the sender disagree about who
   * hosts, up to {@link SINGLETON_HAND_OVER_BUFFER_SIZE}.  `false` means the
   * caller should dead-letter instead.
   *
   * **Why a message can arrive before this node thinks it hosts at all.**  The
   * election rule is the first address-ordered `up` member (carrying the role,
   * if there is one), and every node applies it to its *own* member list.  A
   * node that has just joined is `up` in its peers' lists a gossip round before
   * it is `up` in its own — so a proxy elsewhere already routes here while
   * `wantHosted()` here still answers `false`.  There is no child and no
   * hand-over to hold against, and #949's buffer therefore does not cover it:
   * the message was dead-lettered, which is #637's *"zero dropped messages"*
   * failing on precisely the transition #637 is about.  Measured on the
   * three-node role-restricted fixture: seven of seventeen messages sent across
   * a take-over went to dead letters with no failure of any kind in play.
   *
   * Holding is the same trade #949 already made one step later, for the same
   * reason — a window the framework opens itself must not be paid for in
   * message loss.  It ends either in {@link spawn}, which flushes it into the
   * new instance, or in {@link SINGLETON_HOST_DISAGREEMENT_HOLD_MS}, after
   * which the messages dead-letter exactly as they used to.
   *
   * **The discharge is deliberately *not* driven by a reconcile that concludes
   * "not the host".**  That was the first shape of this fix and it dropped the
   * very messages it was added to save: while a joining node's view is still
   * filling in, it reconciles several times *before* it can see that it is the
   * host, and each of those intermediate answers is `false` for the same reason
   * the hold exists — the view is incomplete.  Measured on the fixture below:
   * two of the held messages were dead-lettered by such a reconcile a
   * heartbeat before the node took over.  An incomplete view is not evidence.
   *
   * **`terminallyStopped` is refused rather than held**, and it is the one piece
   * of positive evidence available.  A manager that opted out of re-spawning
   * will never host again (see {@link terminallyStopped}), so there is no view
   * for ours to catch up *to* — holding would turn an immediate, correct dead
   * letter into a delayed one and make the misconfiguration harder to see.  It
   * is also what keeps the neighbouring "routed here but not hosting"
   * assertion honest rather than merely slower.
   */
  private holdWhileHostingIsUndecided(body: unknown): boolean {
    if (this.terminallyStopped) return false;
    if (this.hostDisagreementHold.length >= SINGLETON_HAND_OVER_BUFFER_SIZE) return false;
    this.hostDisagreementHold.push(body);
    // Armed once, on the transition out of empty: re-arming per message would
    // let a steady sender extend the hold indefinitely, which is the unbounded
    // buffer the cap exists to prevent wearing a different hat.
    if (this.hostDisagreementHoldTimer === null) {
      this.hostDisagreementHoldTimer = this.system.scheduler.scheduleOnceFunction(
        SINGLETON_HOST_DISAGREEMENT_HOLD_MS,
        () => {
          // Through the mailbox: a scheduler tick fires outside a message turn,
          // and every other transition in this manager arrives as a message.
          this.self.tell({ kind: 'host-disagreement-hold-expired' } satisfies ManagerEvent);
        },
      );
    }
    return true;
  }

  /**
   * The backstop fired: no reconcile has taken over hosting and none has
   * concluded this node is not the host either.  Two gossip intervals is long
   * enough that our view is not merely lagging.
   */
  private onHostDisagreementHoldExpired(): void {
    this.dropHostDisagreementHold(
      'this node was routed to as the host but its own view never agreed',
    );
  }

  /**
   * Flush what {@link holdWhileHostingIsUndecided} held into the freshly
   * spawned child.  Called from {@link spawn}, so it runs *before*
   * {@link completeHandOver} flushes the hand-over's own buffer — which is the
   * order the two were received in.
   */
  private flushHostDisagreementHold(): void {
    this.hostDisagreementHoldTimer?.cancel();
    this.hostDisagreementHoldTimer = null;
    if (this.hostDisagreementHold.length === 0) return;
    const held = this.hostDisagreementHold.splice(0, this.hostDisagreementHold.length);
    for (const body of held) this.child?.tell(body as never);
  }

  /** Give up on the hold and dead-letter it, with the reason in the log. */
  private dropHostDisagreementHold(reason: string): void {
    this.hostDisagreementHoldTimer?.cancel();
    this.hostDisagreementHoldTimer = null;
    if (this.hostDisagreementHold.length === 0) return;
    const held = this.hostDisagreementHold.splice(0, this.hostDisagreementHold.length);
    this.warnNotHostedOnce();
    this.dropHeld(held, reason);
  }

  /** Everything a wait was holding, to dead letters, with the reason in the log. */
  private dropHeld(held: readonly unknown[], reason: string): void {
    if (held.length === 0) return;
    this.log.warn(
      `singleton '${this.options.typeName}': ${held.length} message(s) held for the hand-over `
      + `are going to dead letters — ${reason}`,
    );
    for (const body of held) {
      this.system.deadLetters.tell(new DeadLetter(body, null, this.self));
    }
  }

  /**
   * A peer says it is taking over.  Stop hosting, and answer only once the
   * instance is genuinely gone.
   */
  private onHandOverRequest(message: SingletonHandOverRequest, peer: NodeAddress): void {
    if (message.typeName !== this.options.typeName) {
      this.log.warn(
        `singleton '${this.options.typeName}': ignoring a hand-over request for `
        + `'${message.typeName}' from ${peer} — the envelope path and its body disagree`,
      );
      return;
    }
    if (!this.admitsHandOverFrom(peer)) return;
    if (this.child) {
      if (this.wantHosted()) {
        // Worth a line: this node's own view still names it the host, so the
        // two views disagree.  Standing down is right — the requester outranks
        // this node under the shared election rule, so this view is the stale
        // one — but a cluster where this recurs has a gossip problem.
        this.log.warn(
          `singleton '${this.options.typeName}': ${peer} claims the hand-over while this node's `
          + 'own view still names it the host — standing down, since that peer sorts first',
        );
      }
      this.handOverRequesters.set(peer.toString(), peer);
      this.stopChild(`hand-over requested by ${peer}`);
      return;
    }
    if (this.pendingStop) {
      // Already on the way out; the answer is owed, just not yet true.
      this.handOverRequesters.set(peer.toString(), peer);
      return;
    }
    this.answerHandOver(peer);
  }

  /**
   * Whether `peer` may tell this node to stop hosting.
   *
   * The socket-verified `NodeAddress` is the only sender identity the cluster
   * wire offers today — it carries no credential at all (#964) — so this is
   * the whole of the check, and it has to be enough to keep a hand-over from
   * becoming a remote kill switch for the singleton.  `ShardRegion.onHandOff`
   * acting on the word of any peer is the same shape, unfixed (#584).
   *
   * Two conditions, and both fall out of the election rule the managers already
   * share:
   *
   * - **`peer` is a member of this cluster.**  Not merely someone who
   *   completed a handshake.
   * - **`peer` could plausibly be the host.**  A node that believes it hosts
   *   only stands down for a peer that sorts *before* it, because the host is
   *   the first address-ordered member of the eligible set — so a legitimate
   *   incoming host always sorts before the outgoing one, role restriction or
   *   not.  A node that does *not* believe it hosts has no claim to defend and
   *   stands down for anyone: that is the case where the previous host left and
   *   the new one sorts after it.
   *
   * What this cannot stop is a peer that already sorts first, and it does not
   * need to: such a node can become the host by being a member at all.  What it
   * does stop is any *other* member forcing a restart of the singleton at will.
   */
  private admitsHandOverFrom(peer: NodeAddress): boolean {
    const cluster = this.options.cluster;
    const known = cluster.getMembers().some((member) => member.address.equals(peer));
    if (!known) {
      this.log.warn(
        `singleton '${this.options.typeName}': refusing a hand-over request from ${peer} — `
        + 'not a member of this cluster',
      );
      return false;
    }
    if (this.wantHosted() && peer.compareTo(cluster.selfAddress) > 0) {
      this.log.warn(
        `singleton '${this.options.typeName}': refusing a hand-over request from ${peer} — `
        + `this node hosts and sorts before it, so ${peer} cannot be the elected host`,
      );
      return false;
    }
    return true;
  }

  /**
   * Answer every peer whose hand-over this node now genuinely satisfies,
   * carrying `state` when the stand-down produced one (#194).
   *
   * `state` is only ever non-null on the planned path — a `Terminated` for a
   * child this manager itself stopped.  The two other callers pass nothing on
   * purpose:
   *
   * - **an unexpected death.**  The state that survives a crash or an exhausted
   *   supervision budget is the state that caused it, and handing it to the
   *   successor propagates the failure to the node that was supposed to
   *   recover from it.
   * - **the manager stopping.**  `postStop` calls `child.stop()` and answers
   *   immediately; the child's own `postStop` has not run, so anything read
   *   there would be a snapshot from before the instance finished.
   *
   * Both are ordinary cold starts, which is what a singleton did before warm
   * hand-over existed.
   */
  private answerHandOverRequesters(state: Uint8Array | null = null): boolean {
    if (this.handOverRequesters.size === 0) return false;
    if (this.child || this.pendingStop) return false;
    const requesters = [...this.handOverRequesters.values()];
    this.handOverRequesters.clear();
    // Only the first gets the state — see {@link retainHandOverState}.  In
    // practice there is one: a peer only asks when it believes it is taking
    // over, and two peers believing that at once is the state the hand-over
    // exists to resolve.
    let offer = state;
    for (const peer of requesters) {
      this.answerHandOver(peer, offer);
      offer = null;
    }
    return true;
  }

  private answerHandOver(peer: NodeAddress, state: Uint8Array | null = null): void {
    const warmState = state ?? this.takeRetainedHandOverState();
    const acknowledgment: SingletonHandOverAcknowledgment = {
      kind: 'singleton.HandOverAcknowledgment',
      typeName: this.options.typeName,
      ...(warmState === null ? {} : { state: warmState }),
    };
    this.sendToPeer(peer, acknowledgment);
  }

  /* --------------------- warm hand-over (#194) --------------------- */

  /**
   * Keep a snapshot for a successor that has not asked yet.
   *
   * The case this exists for is the ordinary one, not an edge.  Both nodes
   * reconcile from their own gossip, so a host that loses the election
   * frequently stops its instance *before* the incoming host's
   * {@link SingletonHandOverRequest} arrives — the outgoing side reacts to the
   * same membership change, and does not need to be asked.  Without retention
   * the snapshot taken at that `Terminated` had nobody to hand to and was
   * dropped, and the request that arrived a moment later was answered with
   * nothing.  Warm hand-over then worked or not depending on which of two
   * independent gossip deliveries won, which is the same as not working.
   *
   * **Single use, and short-lived.**  Both bounds guard the one failure mode
   * that is worse than a cold start — restoring a snapshot the cluster has
   * moved past:
   *
   * - Handed to the *first* peer that asks and cleared, because there is one
   *   successor.  A second asker gets nothing rather than a snapshot that has
   *   already been superseded by the instance the first asker started.
   * - Expired after {@link SINGLETON_HAND_OVER_STATE_RETENTION_MS}.  A peer
   *   asking later than that was not part of this transition.
   *
   * Also cleared whenever this node spawns again ({@link spawn}), because from
   * then on its own live instance is the state that matters and the saved one is
   * a strictly older generation of it.
   */
  private retainHandOverState(state: Uint8Array): void {
    this.retainedHandOverState = state;
    this.retainedHandOverStateTimer?.cancel();
    this.retainedHandOverStateTimer = this.system.scheduler.scheduleOnceFunction(
      SINGLETON_HAND_OVER_STATE_RETENTION_MS,
      () => {
        // Through the mailbox, like every other timer in this manager.
        this.self.tell({ kind: 'hand-over-state-expired' } satisfies ManagerEvent);
      },
    );
  }

  /** The retained snapshot, if any — consuming it. */
  private takeRetainedHandOverState(): Uint8Array | null {
    const state = this.retainedHandOverState;
    if (state === null) return null;
    this.dropRetainedHandOverState();
    return state;
  }

  private dropRetainedHandOverState(): void {
    this.retainedHandOverStateTimer?.cancel();
    this.retainedHandOverStateTimer = null;
    this.retainedHandOverState = null;
  }

  /**
   * Nobody asked in time.  The snapshot describes a singleton that has been
   * running somewhere else since, so it is now the wrong answer rather than a
   * late one.
   */
  private onHandOverStateExpired(): void {
    if (this.retainedHandOverState === null) return;
    this.log.debug(
      `singleton '${this.options.typeName}': no peer asked for the hand-over state within `
      + `${SINGLETON_HAND_OVER_STATE_RETENTION_MS}ms — discarding it`,
    );
    this.dropRetainedHandOverState();
  }

  /**
   * The stopped instance's state, ready to travel — or `null` for every reason
   * that falls back to a cold start.
   *
   * Read from the instance *after* its `postStop` has completed, which is what
   * makes the snapshot final: nothing further will be processed, and whatever
   * was still in the mailbox has already gone to dead letters rather than into
   * this.  Taking it at `stopChild` time instead would ship a snapshot from
   * before the remaining mailbox was drained — state that silently disagrees
   * with what the outgoing instance actually did.
   *
   * The instance is reached the way the DevTools replay panel reaches a live
   * `PersistentActor` (`ReplayRegistry.actorAt`): a singleton child is always
   * spawned locally, so its ref is a `LocalActorRef` and its cell still holds
   * the instance at this point.  Nothing is retained — the value read out is a
   * byte array, and the reference is dropped with this stack frame.
   */
  private captureWarmState(stopped: ActorRef<T>): Uint8Array | null {
    if (!(stopped instanceof LocalActorRef)) return null;
    const warm = asWarmHandOverActor(stopped.getCell()._actorForInspection());
    if (warm === null) return null;
    let state: Uint8Array | null;
    try {
      state = warm.serializeForHandOver();
    } catch (error) {
      // A cold start, not a failed hand-over: the successor is spawning either
      // way, and a serializer that throws must not be able to keep the
      // singleton from moving.
      this.log.warn(
        `singleton '${this.options.typeName}': serializeForHandOver threw — `
        + 'the successor will start cold',
        error,
      );
      return null;
    }
    if (state === null || state.byteLength === 0) return null;
    return this.withinHandOverStateBudget(state) ? state : null;
  }

  /**
   * Whether `state` may go on the wire, against both bounds — and `warn` naming
   * the one it failed, because a warm hand-over that silently stops being warm
   * is a latency regression with no symptom.
   *
   * Two separate checks, deliberately.  `maxHandOverStateBytes` is a *policy*:
   * how much this deployment is willing to move on the critical path of a host
   * change.  The frame budget is a *safety* bound and is not configurable here
   * at all: a frame over the receiver's cap does not lose the message, it makes
   * the receiver drop the whole inter-node connection — heartbeats and gossip
   * with it — and nothing on the send side would otherwise notice.  So a caller
   * who raises the policy bound past what the transport can carry still cannot
   * produce that frame.
   */
  private withinHandOverStateBudget(state: Uint8Array): boolean {
    const configured = this.options.maxHandOverStateBytes
      ?? DEFAULT_SINGLETON_MAX_HAND_OVER_STATE_BYTES;
    if (state.byteLength > configured) {
      this.log.warn(
        `singleton '${this.options.typeName}': the hand-over state is `
        + `${state.byteLength} bytes, over the ${configured}-byte `
        + 'maxHandOverStateBytes — not shipping it, so the successor starts cold.  '
        + 'Raise the cap, or hand over a smaller summary and let the successor '
        + 'rebuild the rest.',
      );
      return false;
    }
    const maxFrameBytes = this.options.cluster.transport.maxFrameBytes;
    if (!handOverStateFitsFrame(state.byteLength, maxFrameBytes)) {
      this.log.warn(
        `singleton '${this.options.typeName}': the hand-over state is `
        + `${state.byteLength} bytes, which does not fit this transport's `
        + `${maxFrameBytes}-byte frame cap once base64-encoded — not shipping it, `
        + 'so the successor starts cold.  A snapshot costs about a third more on '
        + 'the wire than in memory; raise `ClusterOptions.maxFrameBytes` on every '
        + 'node, or hand over less.',
      );
      return false;
    }
    return true;
  }

  /**
   * Take a predecessor's snapshot off an acknowledgment.
   *
   * At most one peer can have been hosting, so at most one answer carries
   * state; a second is a cluster that was running two instances, and the note
   * says so rather than silently preferring one of them.  The **first** is
   * kept, because it is the one whose sender was asked first.
   */
  private acceptWarmState(
    pending: PendingHandOver,
    state: Uint8Array | undefined,
    peer: NodeAddress,
  ): void {
    if (state === undefined || state.byteLength === 0) return;
    if (pending.state !== null) {
      this.log.warn(
        `singleton '${this.options.typeName}': ${peer} also offered hand-over state, `
        + 'and another peer already had — keeping the first.  Two peers holding state '
        + 'for one singleton means two instances were running.',
      );
      return;
    }
    pending.state = state;
  }

  /**
   * The actor to spawn, wrapped so a predecessor's snapshot is applied between
   * the constructor and `preStart`.
   *
   * That position is the entire feature.  The instance is created inside the
   * child's own `onCreate`, which is a mailbox turn on the child's dispatcher —
   * so there is no moment after `context.spawn` returns at which the manager
   * could reach the instance and still be ahead of `preStart`.  Handing the
   * state to the *factory* puts it in the only frame that is: the actor exists,
   * and the recovery `preStart` would otherwise perform has not started.  Push
   * it in any later and the expensive replay this exists to skip has already
   * been paid for, and then overwritten.
   *
   * A factory rather than the class, which is the exception the house rule
   * names — the class form cannot express a constructor-time side effect, and
   * this is not per-call-site configuration dressed up as a closure.
   */
  private warmedActorFactory(state: Uint8Array): ActorClassOrFactory<T> {
    const construct = actorFactoryOf(this.options.singletonActor);
    const typeName = this.options.typeName;
    return () => {
      const actor = construct();
      const warm = asWarmHandOverActor(actor);
      if (warm === null) {
        // The predecessor could serialize and this one cannot restore, so the
        // two ends are running different code — a rolling upgrade past the
        // release that added the hooks, most likely.  Cold start, and say so.
        this.log.warn(
          `singleton '${typeName}': a predecessor handed over ${state.byteLength} bytes of `
          + 'state, but this node\'s actor does not implement restoreFromHandOver — '
          + 'starting cold.  The two nodes are running different versions of it.',
        );
        return actor;
      }
      try {
        warm.restoreFromHandOver(state);
        this.log.info(
          `singleton '${typeName}' restored ${state.byteLength} bytes of hand-over state`,
        );
      } catch (error) {
        this.log.warn(
          `singleton '${typeName}': restoreFromHandOver threw — continuing as a cold `
          + 'start.  The instance is not re-constructed, so an implementation that '
          + 'mutates while parsing may be half-populated.',
          error,
        );
      }
      return actor;
    };
  }

  /**
   * One hand-over frame to one peer's manager.
   *
   * `peer.systemName` and **not** `this.system.name`: the manager path embeds
   * the *hosting* system's name, and a cluster's members do not have to share
   * one.  `MultiNodeSpec` gives every node a system named after its role
   * precisely so a test can tell them apart, and there the two spellings differ
   * — a frame addressed with the sender's name misses the recipient's per-path
   * handler entirely, falls through to `Cluster.dispatchEnvelope`'s generic path
   * resolution, and arrives at the manager as a bare body with no authenticated
   * peer attached.  Which the manager then, correctly, refuses to act on.
   *
   * `from: null` like the proxy's own sends, and for a sharper reason than
   * symmetry: `EnvelopeMessage.from` is an actor *path*, and the only path this
   * exchange knows is the recipient's — so filling it in would name the wrong
   * end.  The sender that matters is the socket-verified `NodeAddress` the
   * receiving `Cluster` supplies to the per-path handler, which no payload can
   * forge.
   */
  private sendToPeer(peer: NodeAddress, message: SingletonMessage): void {
    this.options.cluster._sendEnvelope(peer, {
      kind: 'envelope',
      to: singletonManagerPath(peer.systemName, this.options.typeName),
      from: null,
      body: message,
      tag: 'Singleton',
    });
  }

  /* -------------------------- helpers -------------------------- */

  private wantHosted(): boolean {
    // Checked ahead of the membership question so it also gates the lease:
    // re-acquiring for a child this manager will never spawn again rebuilds
    // exactly the "lease held over nothing" state the opt-out avoids.
    if (this.terminallyStopped) return false;
    const cluster = this.options.cluster;
    return singletonHost(cluster, this.options.role)
      .exists((host) => host.address.equals(cluster.selfAddress));
  }

  /**
   * @param warmState A predecessor's snapshot to start from, or `null` for the
   * cold start every other caller wants.  Only {@link completeHandOver} ever
   * has one: it is the only path that asked a peer to stand down, so it is the
   * only path a snapshot can have arrived on.
   */
  private spawn(warmState: Uint8Array | null = null): void {
    if (this.child) return;
    // The previous child is still terminating.  Don't try to spawn
    // with the same name — its cell is still in the parent's children
    // map — and don't bring up the user actor (e.g. an HTTP server
    // re-binding the same port) until postStop has released its
    // resources.  `handleTerminated` will retrigger the reconcile
    // once `pendingStop` clears.
    if (this.pendingStop) return;
    this.child = this.context.spawn(
      warmState === null
        ? this.options.singletonActor
        : this.warmedActorFactory(warmState),
      this.options.typeName,
      this.options.singletonActorOptions,
    );
    this.context.watch(this.child);
    // This node is hosting again, so a snapshot it left for a successor is a
    // strictly older generation of the state its own live instance now holds
    // (#194).
    this.dropRetainedHandOverState();
    // Before the log line and before `completeHandOver` flushes its own buffer:
    // these were routed here first, so they enter the mailbox first (#637).
    this.flushHostDisagreementHold();
    // The "routed here but not hosting" condition has just cleared; unlatch so
    // a later episode is reported rather than passing silently.
    this.warnedNotHosted = false;
    this.log.info(`singleton '${this.options.typeName}' started on this node (now leader)`);
  }

  private stopChild(reason: string): void {
    if (!this.child) return;
    this.log.info(`singleton '${this.options.typeName}' stopping (${reason})`);
    // Move into pendingStop instead of nulling immediately — the cell
    // remains in the parent's children map until `Terminated` arrives,
    // and any reconcile that fires in the meantime must wait.
    this.pendingStop = this.child;
    this.child.stop();
    this.child = null;
  }

  private scheduleAcquireRetry(): void {
    const interval = this.options.acquireRetryIntervalMs ?? 5_000;
    this.retryTimer?.cancel();
    this.retryTimer = this.system.scheduler.scheduleOnceFunction(interval, () => {
      this.self.tell({ kind: 'acquire-retry' } satisfies ManagerEvent);
    });
  }
}
