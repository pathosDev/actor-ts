import { match, P } from 'ts-pattern';
import { ActorPath } from '../../ActorPath.js';
import { ActorRef } from '../../ActorRef.js';
import type { Cluster } from '../Cluster.js';
import { LeaderChanged } from '../ClusterEvents.js';
import { NodeAddress } from '../NodeAddress.js';
import { singletonProxyName } from '../../internal/SystemPaths.js';
import { singletonManagerPath, type SingletonDeliver } from './ClusterSingletonManager.js';
import type { SingletonKey } from './SingletonKey.js';

/**
 * Location-transparent handle to a cluster-wide singleton.  Every call to
 * `tell` looks up the current leader and forwards to that node's
 * ClusterSingletonManager (via direct `tell` if local, via envelope if
 * remote).  Messages sent before the cluster has elected a leader are
 * buffered and drained when the first `LeaderChanged` event fires.
 *
 * The proxy extends ActorRef<T> so it can be passed anywhere an ActorRef is
 * expected (e.g. as a sender for ask patterns).  It is not backed by a real
 * actor — it is a thin forwarder.
 */
export class ClusterSingletonProxy<TCommand> extends ActorRef<TCommand> {
  readonly path: ActorPath;
  private buffer: TCommand[] = [];
  private unsubscribe: (() => void) | null = null;
  private forwarding = true;
  private warnedMissingHost = false;

  constructor(
    private readonly cluster: Cluster,
    private readonly key: SingletonKey<TCommand>,
    /**
     * This node's manager, resolved per delivery rather than captured.  A
     * proxy handed out by `ClusterSingleton.ref` predates any local `start()`
     * — and a `start()` may follow on this node later — so a captured ref
     * would either be impossible to obtain or permanently stale.
     */
    private readonly localManager: () => ActorRef | null,
  ) {
    super();
    // Synthetic — no actor is spawned here.  The path exists so logs and dead
    // letters name the proxy somewhere plausible, alongside the manager it
    // fronts.
    this.path = new ActorPath('', null, cluster.system.name)
      .child('system').child('cluster').child('singleton')
      .child(singletonProxyName(key.typeName));
    this.unsubscribe = cluster.subscribe((evt) =>
      match(evt)
        .with(P.instanceOf(LeaderChanged), () => this.onLeaderChanged())
        .otherwise(() => this.onOtherClusterEvent()),
    );
    // Drain in case a leader is already known by the time we start.
    queueMicrotask(() => this.drainBuffer());
  }

  override tell(message: TCommand, _sender: ActorRef | null = null): void {
    if (!this.forwarding) return;
    const leaderOpt = this.cluster.leader();
    if (leaderOpt.isNone()) {
      this.buffer.push(message);
      return;
    }
    this.deliver(message, leaderOpt.value.address);
  }

  /**
   * A singleton is not stopped by poisoning its proxy — the proxy is a
   * forwarder, not the actor.  `ActorRef.stop()` means "send a PoisonPill to
   * the target" everywhere else, and doing that here would kill whatever the
   * current leader happens to be hosting.  Overridden to say so instead.
   */
  override stop(): void {
    this.cluster.system.log.warn(
      `singleton '${this.key.typeName}': stop() on the ref is a no-op — `
      + 'use `cluster.singleton.stop(key)` to take this node out of rotation',
    );
  }

  /** @internal Stop forwarding and unsubscribe from cluster events. */
  _stopForwarding(): void {
    this.forwarding = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** True if at least one message is currently buffered. */
  hasPending(): boolean { return this.buffer.length > 0; }

  private deliver(message: TCommand, leaderAddress: NodeAddress): void {
    if (!leaderAddress.equals(this.cluster.selfAddress)) {
      this.cluster._sendEnvelope(leaderAddress, {
        t: 'envelope',
        to: singletonManagerPath(this.cluster.system.name, this.key.typeName),
        from: null,
        body: message,
        tag: 'Singleton',
      });
      return;
    }
    const manager = this.localManager();
    if (manager) {
      const payload: SingletonDeliver = { t: 'singleton-deliver', body: message };
      manager.tell(payload as never);
      return;
    }
    this.onMissingHost(message);
  }

  /**
   * This node is the leader but runs no manager, so nothing anywhere is hosting
   * the singleton.  Dead-letter rather than buffer: unlike "no leader elected
   * yet" — which the buffer above handles and `LeaderChanged` drains — this
   * state does not heal on its own, it heals when someone changes the
   * deployment, so a buffer would just grow.  The warning is latched so a hot
   * path cannot flood the log.
   */
  private onMissingHost(message: TCommand): void {
    if (!this.warnedMissingHost) {
      this.warnedMissingHost = true;
      this.cluster.system.log.warn(
        `singleton '${this.key.typeName}': this node is the leader but never called `
        + '`cluster.singleton.start(...)`, so no node is hosting the singleton and messages are '
        + 'dead-lettering — a ref() proxy cannot host.  Call start() on every node that may '
        + 'become leader, or restrict the singleton to a role only starting nodes carry.',
      );
    }
    this.cluster.system.deadLetters.tell(message as never);
  }

  private onLeaderChanged(): void {
    this.drainBuffer();
  }

  private onOtherClusterEvent(): void {
    /* leader-change is the only event we react to */
  }

  private drainBuffer(): void {
    const leaderOpt = this.cluster.leader();
    if (leaderOpt.isNone() || this.buffer.length === 0) return;
    const leaderAddress = leaderOpt.value.address;
    const drained = this.buffer.splice(0, this.buffer.length);
    for (const message of drained) this.deliver(message, leaderAddress);
  }
}
