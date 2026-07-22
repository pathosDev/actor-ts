import { match, P } from 'ts-pattern';
import { ActorPath } from '../../ActorPath.js';
import { ActorRef } from '../../ActorRef.js';
import type { Cluster } from '../Cluster.js';
import { LeaderChanged } from '../ClusterEvents.js';
import { NodeAddress } from '../NodeAddress.js';
import { singletonManagerPath, type SingletonDeliver } from './ClusterSingletonManager.js';

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
export class ClusterSingletonProxy<T> extends ActorRef<T> {
  readonly path: ActorPath;
  private buffer: T[] = [];
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(
    private readonly cluster: Cluster,
    private readonly typeName: string,
    private readonly localManagerRef: ActorRef,
  ) {
    super();
    this.path = new ActorPath('', null, cluster.system.name)
      .child('user').child(`singleton-proxy-${typeName}`);
    this.unsubscribe = cluster.subscribe((evt) =>
      match(evt)
        .with(P.instanceOf(LeaderChanged), () => this.onLeaderChanged())
        .otherwise(() => this.onOtherClusterEvent()),
    );
    // Drain in case a leader is already known by the time we start.
    queueMicrotask(() => this.drainBuffer());
  }

  override tell(message: T, _sender: ActorRef | null = null): void {
    if (this.stopped) return;
    const leaderOpt = this.cluster.leader();
    if (leaderOpt.isNone()) {
      this.buffer.push(message);
      return;
    }
    this.deliver(message, leaderOpt.value.address);
  }

  /** Stop forwarding; unsubscribes from cluster events. */
  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** True if at least one message is currently buffered. */
  hasPending(): boolean { return this.buffer.length > 0; }

  private deliver(message: T, leaderAddr: NodeAddress): void {
    if (leaderAddr.equals(this.cluster.selfAddress)) {
      const payload: SingletonDeliver = { t: 'singleton-deliver', body: message };
      this.localManagerRef.tell(payload as never);
    } else {
      this.cluster._sendEnvelope(leaderAddr, {
        t: 'envelope',
        to: singletonManagerPath(this.cluster.system.name, this.typeName),
        from: null,
        body: message,
        tag: 'Singleton',
      });
    }
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
    const leaderAddr = leaderOpt.value.address;
    const drained = this.buffer.splice(0, this.buffer.length);
    for (const message of drained) this.deliver(message, leaderAddr);
  }
}
