/**
 * Singleton actor used by scenario 05 (Cluster Singleton failover).
 * Defined in its own file so `node-runner.ts` (which spawns it)
 * and `control-routes.ts` (which forwards messages to its proxy)
 * share the same message-type identities.
 *
 * **Plain-object discriminant** (not class instances).  Class
 * instances do NOT survive the JSON-based wire-serialisation
 * the cluster transport uses for cross-node envelope bodies —
 * the prototype is lost on deserialisation, which makes
 * `msg instanceof X` checks on the receiver fail.  Plain objects
 * with a `kind` field round-trip cleanly.  Same hazard EchoActor
 * (scenario 09) hit and uses the same pattern.
 */

import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';

/** Increment the singleton's counter by 1.  Fire-and-forget. */
export interface SingletonInc {
  readonly kind: 'inc';
}

/**
 * "Who are you?" — the singleton replies with its host node name +
 * current counter value.  `replyTo` is a one-shot collector spawned
 * per HTTP request in `control-routes.ts`.
 */
export interface SingletonWho {
  readonly kind: 'who';
  readonly replyTo: ActorRef<SingletonWhoReply>;
}

export interface SingletonWhoReply {
  readonly kind: 'who-reply';
  readonly nodeName: string;
  readonly value: number;
}

export type SingletonMsg = SingletonInc | SingletonWho;

/**
 * `CounterSingleton` instance is spawned by the cluster's
 * `ClusterSingletonManager` on the leader node.  Its identity is
 * the host node's name (passed into the constructor by node-runner
 * when it sets up the singleton).  Counter resets on every failover
 * — verifying state-preservation across leader changes would be a
 * SEPARATE scenario for persistent actors.
 */
export class CounterSingleton extends Actor<SingletonMsg> {
  private value = 0;
  constructor(private readonly nodeName: string) { super(); }
  override onReceive(msg: SingletonMsg): void {
    if (msg.kind === 'inc') {
      this.value++;
    } else if (msg.kind === 'who') {
      msg.replyTo.tell({
        kind: 'who-reply',
        nodeName: this.nodeName,
        value: this.value,
      });
    }
  }
}
