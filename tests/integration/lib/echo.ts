/**
 * Echo actor used by scenario 09 (external ClusterClient).
 *
 * Spawned at `/user/echo` on every cluster node so an external
 * `ClusterClient` can `ask('/user/echo', { kind: 'ping' })` and
 * receive a `{ kind: 'pong', nodeName }` reply.  The node name is
 * baked into the actor at construction time, so the reply also
 * reveals which cluster node answered the ask — useful for the
 * scenario to verify the request actually crossed the wire.
 *
 * The message shape is intentionally a plain object (no class),
 * because the framework's `ask()` injects `replyTo` via
 * `{ ...message, replyTo: askRef }` — that spread loses class
 * prototypes, so a `P.instanceOf` check on the receiver would
 * always fail.  Plain-object discriminants survive the spread.
 */

import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';

export interface PingMsg {
  readonly kind: 'ping';
  /** Injected by the framework's ask(); ClusterClient sets this from the receiving side. */
  readonly replyTo?: ActorRef<PongMsg>;
}

export interface PongMsg {
  readonly kind: 'pong';
  readonly nodeName: string;
  readonly receivedAt: number;
}

export class EchoActor extends Actor<PingMsg> {
  constructor(private readonly nodeName: string) { super(); }
  override onReceive(msg: PingMsg): void {
    if (msg.kind === 'ping' && msg.replyTo) {
      msg.replyTo.tell({
        kind: 'pong',
        nodeName: this.nodeName,
        receivedAt: Date.now(),
      });
    }
  }
}
