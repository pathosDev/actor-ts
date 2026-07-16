import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { Cancellable } from '../../Scheduler.js';
import { Terminated } from '../../SystemMessages.js';
import type { ClusterSingletonManagerOptions, ClusterSingletonManagerOptionsType } from './ClusterSingletonManagerOptions.js';
import { LeaderChanged, MemberRemoved, SelfUp } from '../ClusterEvents.js';

/**
 * Path at which every node hosts its ClusterSingletonManager for a given
 * singleton typeName.  Used by the proxy/envelope layer to address the
 * manager on whichever node is currently the leader.
 */
export function singletonManagerPath(systemName: string, typeName: string): string {
  return `actor-ts://${systemName}/user/singleton-manager-${typeName}`;
}

/** Internal delivery wrapper — body is the user's typed message. */
export interface SingletonDeliver {
  readonly t: 'singleton-deliver';
  readonly body: unknown;
}

/* --------------------- internal mailbox events --------------------- */
/**
 * The lease-aware path uses internal events instead of inline awaits so
 * cluster-event triggers can't interleave their `reconcile` calls with
 * an in-flight `lease.acquire()`.  Every state transition arrives as a
 * single message in this manager's own mailbox.
 */
type ManagerEvent =
  | { t: 'reconcile' }
  | { t: 'lease-acquire-result'; got: boolean; error?: Error }
  | { t: 'lease-lost'; reason: string }
  | { t: 'acquire-retry' };

type Inbox = SingletonDeliver | ManagerEvent | Terminated;

/**
 * Runs on every node.  Watches cluster events and (re)spawns the singleton
 * child when this node is the cluster leader; stops the child when it is not.
 * Remote Envelopes addressed to the singleton land here and are forwarded to
 * the child — if the manager is not on the leader node, the envelope is
 * dropped with a warning (the proxy shouldn't have forwarded there).
 *
 * **Two paths:**
 *
 * - **No lease (default).**  Synchronous reconcile — spawn the moment
 *   cluster gossip says we're leader.  Same behaviour the manager has
 *   shipped since v1.
 * - **With lease.**  Async reconcile that gates child-spawn on
 *   `lease.acquire()`, watches `lease.onLost(...)` for revocation, and
 *   `release()`s on graceful handover.  All state transitions go through
 *   the manager's own mailbox so concurrent cluster events can't race
 *   with an in-flight acquire.
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
  private unsubCluster: (() => void) | null = null;
  private unsubLeaseLost: (() => void) | null = null;
  private retryTimer: Cancellable | null = null;

  /** Lease lifecycle — only used when `options.lease` is set. */
  private leaseState: 'none' | 'acquiring' | 'held' = 'none';

  /** Callback the extension hands us so we can release the envelope path on stop. */
  _envelopeUnsub: (() => void) | null = null;

  readonly options: ClusterSingletonManagerOptionsType<T>;

  constructor(options: ClusterSingletonManagerOptions<T>) {
    super();
    this.options = options as ClusterSingletonManagerOptionsType<T>;
  }

  override preStart(): void {
    const cluster = this.options.cluster;
    // No-lease path stays sync: cluster events drive `reconcileSync()`
    // directly, so a leader-change result is visible the moment the
    // event fires.  This preserves the v1 timing guarantee (proxies
    // can ask the cluster for the leader and immediately route).
    //
    // With a lease, every state transition has to flow through the
    // manager's own mailbox so concurrent cluster events can't race
    // with an in-flight `acquire()` — see `handleReconcile`.
    this.unsubCluster = cluster.subscribe((evt) =>
      match(evt)
        .with(
          P.union(
            P.instanceOf(LeaderChanged),
            P.instanceOf(SelfUp),
            P.instanceOf(MemberRemoved),
          ),
          () => this.onClusterMembershipChanged(),
        )
        .otherwise(() => this.onOtherClusterEvent()),
    );

    if (this.options.lease) {
      this.unsubLeaseLost = this.options.lease.onLost((reason) => {
        this.self.tell({ t: 'lease-lost', reason } satisfies ManagerEvent);
      });
      // Lease path: kick the initial reconcile via the mailbox.
      this.self.tell({ t: 'reconcile' } satisfies ManagerEvent);
    } else {
      this.reconcileSync();
    }
  }

  private onClusterMembershipChanged(): void {
    if (this.options.lease) {
      this.self.tell({ t: 'reconcile' } satisfies ManagerEvent);
    } else {
      this.reconcileSync();
    }
  }

  private onOtherClusterEvent(): void {
    /* other events ignored */
  }

  override async postStop(): Promise<void> {
    this.unsubCluster?.();
    this.unsubLeaseLost?.();
    this._envelopeUnsub?.();
    this.retryTimer?.cancel();
    if (this.child) { this.child.stop(); this.child = null; }
    // Drop any in-flight stop — the parent termination cascade will
    // tear it down regardless, and we no longer need to react to its
    // Terminated message.
    this.pendingStop = null;
    // Release the lease if held — the holder leaving cleanly lets a
    // follower acquire faster than waiting for the TTL to expire.
    if (this.options.lease && this.leaseState === 'held') {
      try { await this.options.lease.release(); } catch { /* best-effort */ }
      this.leaseState = 'none';
    }
  }

  override onReceive(msg: Inbox): void | Promise<void> {
    if (msg instanceof Terminated) {
      this.handleTerminated(msg);
      return;
    }
    return match(msg)
      .with({ t: 'singleton-deliver' }, (m) => this.onSingletonDeliver(m))
      .with({ t: 'reconcile' }, () => this.onReconcile())
      .with({ t: 'lease-acquire-result' }, (m) => this.onLeaseAcquireResult(m))
      .with({ t: 'lease-lost' }, (m) => this.onLeaseLost(m))
      .with({ t: 'acquire-retry' }, () => this.onAcquireRetry())
      .exhaustive();
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
   */
  private handleTerminated(t: Terminated): void {
    if (this.pendingStop && t.actor.equals(this.pendingStop)) {
      this.log.debug(
        `previous child '${this.options.typeName}' fully terminated — re-running reconcile`,
      );
      this.pendingStop = null;
      // Re-trigger the appropriate reconcile path; either branch is
      // safe to call when the singleton state is "no child running".
      if (this.options.lease) {
        this.self.tell({ t: 'reconcile' } satisfies ManagerEvent);
      } else {
        this.reconcileSync();
      }
    }
  }

  /* -------------------------- handlers -------------------------- */

  private onSingletonDeliver(msg: SingletonDeliver): void {
    if (msg.t !== 'singleton-deliver') return;
    if (!this.child) {
      this.log.warn(
        `singleton '${this.options.typeName}' not currently hosted on this node — dropping message`,
      );
      return;
    }
    this.child.tell(msg.body as never);
  }

  /** Sync reconcile — no lease.  Spawn / stop the child to match cluster state. */
  private reconcileSync(): void {
    const want = this.wantHosted();
    this.log.debug(
      `reconcile '${this.options.typeName}': want=${want} child=${this.child !== null} pendingStop=${this.pendingStop !== null}`,
    );
    if (want && !this.child) {
      this.spawn();
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
      if (this.leaseState === 'held') return;          // already running
      if (this.leaseState === 'acquiring') return;     // already in flight
      // Cancel a retry if one is pending — we're starting a fresh attempt now.
      this.retryTimer?.cancel();
      this.retryTimer = null;
      this.leaseState = 'acquiring';
      void this.runAcquire();
    } else {
      if (this.leaseState === 'held') {
        this.stopChild('leader moved away or role lost');
        try { await this.options.lease.release(); }
        catch (e) { this.log.warn(`lease release failed`, e); }
        this.leaseState = 'none';
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
      this.self.tell({ t: 'lease-acquire-result', got } satisfies ManagerEvent);
    } catch (error) {
      this.self.tell({
        t: 'lease-acquire-result', got: false, error: error as Error,
      } satisfies ManagerEvent);
    }
  }

  private onLeaseAcquireResult(msg: { got: boolean; error?: Error }): void {
    if (this.leaseState !== 'acquiring') {
      // Spurious result — manager was reset or stopped while we were
      // awaiting.  If we somehow got the lease, release it best-effort
      // so we don't hold onto a slot we don't want.
      if (msg.got) void this.options.lease!.release().catch(() => {});
      return;
    }
    if (!msg.got) {
      // Acquire failed (another holder, or backend error).  Retry on
      // the configured interval.  We log the error if there was one.
      if (msg.error) this.log.warn(`lease acquire failed`, msg.error);
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
    this.spawn();
  }

  private onLeaseLost(msg: { reason: string }): void {
    if (this.leaseState !== 'held') return;     // stale callback
    this.log.warn(`singleton '${this.options.typeName}': lease lost — ${msg.reason}; stopping child`);
    this.stopChild(`lease lost: ${msg.reason}`);
    this.leaseState = 'none';
    // If we're still the elected leader, kick a fresh reconcile so we
    // try to re-acquire.  Cluster events would eventually do this on
    // their own, but a missed re-acquire here is annoying.
    this.self.tell({ t: 'reconcile' } satisfies ManagerEvent);
  }

  /* -------------------------- helpers -------------------------- */

  private wantHosted(): boolean {
    const cluster = this.options.cluster;
    const iAmLeader = cluster.leader().exists((l) => l.address.equals(cluster.selfAddress));
    const roleOk = !this.options.role || cluster.selfRoles.has(this.options.role);
    return iAmLeader && roleOk;
  }

  private spawn(): void {
    if (this.child) return;
    // The previous child is still terminating.  Don't try to spawn
    // with the same name — its cell is still in the parent's children
    // map — and don't bring up the user actor (e.g. an HTTP server
    // re-binding the same port) until postStop has released its
    // resources.  `handleTerminated` will retrigger the reconcile
    // once `pendingStop` clears.
    if (this.pendingStop) return;
    this.child = this.context.spawn(this.options.singletonProps, this.options.typeName);
    this.context.watch(this.child);
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
    this.retryTimer = this.system.scheduler.scheduleOnceFn(interval, () => {
      this.self.tell({ t: 'acquire-retry' } satisfies ManagerEvent);
    });
  }
}
