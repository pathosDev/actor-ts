/**
 * Singleton actor used by scenario 05 (Cluster Singleton failover).
 * Defined in its own file so `node-runner.ts` (which spawns it)
 * and `control-routes.ts` (which forwards messages to its proxy)
 * share the same message-class identities — `P.instanceOf` checks
 * rely on prototype equality.
 */

import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';

/** Increment the singleton's counter by 1.  Fire-and-forget. */
export class SingletonInc {}

/**
 * "Who are you?" — the singleton replies with its host node name +
 * current counter value.  `replyTo` is a one-shot collector spawned
 * per HTTP request in `control-routes.ts`.
 */
export class SingletonWho {
  constructor(public readonly replyTo: ActorRef<SingletonWhoReply>) {}
}

export class SingletonWhoReply {
  constructor(
    public readonly nodeName: string,
    public readonly value: number,
  ) {}
}

export type SingletonMsg = SingletonInc | SingletonWho;

/**
 * `CounterSingleton` instance is spawned by the cluster's
 * `ClusterSingletonManager` on the leader node.  Its identity is
 * the host node's name (passed into the constructor by node-runner
 * when it sets up the singleton).  Counter resets on every failover
 * — verifying state-preservation across leader changes would be a
 * SEPARATE scenario for #311 persistent actors.
 */
export class CounterSingleton extends Actor<SingletonMsg> {
  private value = 0;
  constructor(private readonly nodeName: string) { super(); }
  override onReceive(msg: SingletonMsg): void {
    if (msg instanceof SingletonInc) {
      this.value++;
    } else if (msg instanceof SingletonWho) {
      msg.replyTo.tell(new SingletonWhoReply(this.nodeName, this.value));
    }
  }
}
