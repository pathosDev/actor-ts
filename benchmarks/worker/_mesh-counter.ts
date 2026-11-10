/**
 * The actor mesh-message-cost.ts measures against, in a module of its own so
 * that the main thread and the worker bootstrap (`_mesh-worker.ts`) spawn the
 * *same class* — the shape #1563's transparent placement relies on, where
 * both sides of a thread boundary import one actor module.
 *
 * Plain-data messages with a `kind` discriminant, because that is what
 * survives a structured clone unchanged; a class instance would arrive on the
 * far side as a bare object with no prototype (#1386).
 *
 * `count` replies through `replyTo` rather than `this.sender`: across the
 * wire the sender is `None` until #1561 lands, and a benchmark that hung on
 * that would measure the bug rather than the boundary.  The counter resets on
 * every `count`, so each measured batch verifies its own delivery — a batch
 * that reports fewer messages than were sent throws instead of printing a
 * number (#1027).
 *
 * Ignored by the benchmark discovery harness — filename starts with "_".
 */
import { Actor, type ActorRef } from '../../src/index.js';

export type IncrementMessage = { readonly kind: 'increment' };
export type CountMessage = { readonly kind: 'count'; readonly replyTo: ActorRef<number> };
export type CounterMessage = IncrementMessage | CountMessage;

/** Where every tier spawns the counter, so a `RemoteActorRef` can name it. */
export const COUNTER_NAME = 'counter';

export class Counter extends Actor<CounterMessage> {
  private n = 0;

  override onReceive(message: CounterMessage): void {
    if (message.kind === 'increment') {
      this.n++;
      return;
    }
    message.replyTo.tell(this.n);
    this.n = 0;
  }
}
