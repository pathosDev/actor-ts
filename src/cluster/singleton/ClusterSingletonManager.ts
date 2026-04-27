import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { Props } from '../../Props.js';
import type { Cluster } from '../Cluster.js';
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

export interface ClusterSingletonManagerSettings<T> {
  readonly cluster: Cluster;
  /** Logical name for this singleton; also used as the child-actor name. */
  readonly typeName: string;
  /** How to construct the singleton actor.  Only instantiated on the leader. */
  readonly singletonProps: Props<T>;
  /** Optional role — only nodes with this role will host the singleton. */
  readonly role?: string;
}

/**
 * Runs on every node.  Watches cluster events and (re)spawns the singleton
 * child when this node is the cluster leader; stops the child when it is not.
 * Remote Envelopes addressed to the singleton land here and are forwarded to
 * the child — if the manager is not on the leader node, the envelope is
 * dropped with a warning (the proxy shouldn't have forwarded there).
 */
export class ClusterSingletonManager<T> extends Actor<SingletonDeliver> {
  private child: ActorRef<T> | null = null;
  private unsubCluster: (() => void) | null = null;
  /** Callback the extension hands us so we can release the envelope path on stop. */
  _envelopeUnsub: (() => void) | null = null;

  constructor(public readonly settings: ClusterSingletonManagerSettings<T>) { super(); }

  override preStart(): void {
    const cluster = this.settings.cluster;
    this.unsubCluster = cluster.subscribe((evt) =>
      match(evt)
        .with(
          P.union(
            P.instanceOf(LeaderChanged),
            P.instanceOf(SelfUp),
            P.instanceOf(MemberRemoved),
          ),
          () => this.reconcile(),
        )
        .otherwise(() => { /* other events ignored */ }),
    );
    this.reconcile();
  }

  override postStop(): void {
    this.unsubCluster?.();
    this._envelopeUnsub?.();
    if (this.child) { this.child.stop(); this.child = null; }
  }

  override onReceive(msg: SingletonDeliver): void {
    if (msg.t !== 'singleton-deliver') return;
    if (!this.child) {
      this.log.warn(
        `singleton '${this.settings.typeName}' not currently hosted on this node — dropping message`,
      );
      return;
    }
    this.child.tell(msg.body as never);
  }

  private reconcile(): void {
    const cluster = this.settings.cluster;
    const iAmLeader = cluster.leader().exists((l) => l.address.equals(cluster.selfAddress));
    const roleOk = !this.settings.role || cluster.selfRoles.has(this.settings.role);

    if (iAmLeader && roleOk && !this.child) {
      this.child = this.context.actorOf(this.settings.singletonProps, this.settings.typeName);
      this.log.info(`singleton '${this.settings.typeName}' started on this node (now leader)`);
    } else if ((!iAmLeader || !roleOk) && this.child) {
      this.log.info(`singleton '${this.settings.typeName}' stopping (leader moved away or role lost)`);
      this.child.stop();
      this.child = null;
    }
  }
}
