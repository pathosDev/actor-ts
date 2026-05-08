import type { ActorRef } from './ActorRef.js';

/**
 * A simple system-wide pub/sub bus.  Subscribers register against a
 * channel (a class constructor); publications are matched using
 * `instanceof`, so subclasses are delivered to base-class subscribers.
 *
 * **Predicate-filtered subscriptions (#85).**  Each subscription
 * may carry an optional predicate that runs against the event before
 * delivery — only events the predicate accepts are `tell`'d to the
 * subscriber.  Useful for high-frequency channels (cluster events,
 * metrics) where the consumer only cares about a slice of the
 * traffic and would otherwise have to filter inside its own
 * `onReceive`.  A predicate that throws is treated as "no match"
 * for that delivery; the subscription stays active.
 */
type Class<T> = new (...args: any[]) => T;

interface Subscription {
  readonly subscriber: ActorRef;
  readonly channel: Class<unknown>;
  /** Optional filter — evaluated before delivery; throws → skip. */
  readonly predicate?: (event: unknown) => boolean;
}

/**
 * Optional minimal-logger hook for the bus.  ActorSystem assigns its
 * own logger here after construction; if unset (e.g. ad-hoc test
 * use), predicate failures are silently swallowed.
 */
export interface EventStreamLogger {
  warn(message: string, ...args: unknown[]): void;
}

export class EventStream {
  private subs: Subscription[] = [];

  /**
   * Optional logger used to surface predicate failures.  Assigned by
   * `ActorSystem` once its main logger has been constructed; tests
   * that instantiate `EventStream` directly can leave it `undefined`
   * — the bus stays functional, errors just stay silent.
   */
  log?: EventStreamLogger;

  /**
   * Subscribe an actor ref to a channel (class).  Returns true if a
   * new subscription was added; false if a duplicate was rejected.
   *
   * **Dedup rules.**  Without `predicate`, only one subscription per
   * `(subscriber, channel)` is kept — re-calling `subscribe` is a
   * no-op.  With a `predicate`, every call adds a new subscription:
   * predicates are values without an identity contract, so dedup'ing
   * across them would be unreliable; users wanting "replace this
   * filter" should `unsubscribe` first.
   */
  subscribe<T>(
    subscriber: ActorRef,
    channel: Class<T>,
    predicate?: (event: T) => boolean,
  ): boolean {
    if (!predicate) {
      const already = this.subs.some(
        (s) => s.subscriber.equals(subscriber) && s.channel === channel && !s.predicate,
      );
      if (already) return false;
    }
    this.subs.push({
      subscriber,
      channel: channel as Class<unknown>,
      predicate: predicate as ((event: unknown) => boolean) | undefined,
    });
    return true;
  }

  /**
   * Unsubscribe a `(subscriber, channel)` pair, or every subscription
   * the actor holds when `channel` is omitted.  Removes ALL matching
   * entries — including predicate-bearing ones; finer-grained removal
   * (one specific predicate at a time) isn't supported because
   * predicates have no stable identity.
   */
  unsubscribe<T>(subscriber: ActorRef, channel?: Class<T>): boolean {
    const before = this.subs.length;
    if (channel) {
      this.subs = this.subs.filter(
        (s) => !(s.subscriber.equals(subscriber) && s.channel === channel),
      );
    } else {
      this.subs = this.subs.filter((s) => !s.subscriber.equals(subscriber));
    }
    return this.subs.length !== before;
  }

  /** Publish an event to all matching subscribers. */
  publish(event: object): void {
    for (const { subscriber, channel, predicate } of this.subs) {
      if (!(event instanceof channel)) continue;
      if (predicate) {
        let accepted: boolean;
        try {
          accepted = predicate(event);
        } catch (err) {
          // A throwing predicate must NOT break the bus for other
          // subscribers — treat as "no match" and keep going.
          this.log?.warn(
            `EventStream: predicate threw on ${channel.name} delivery — treating as no-match`,
            err,
          );
          continue;
        }
        if (!accepted) continue;
      }
      subscriber.tell(event as never);
    }
  }
}
