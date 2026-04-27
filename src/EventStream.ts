import type { ActorRef } from './ActorRef.js';

/**
 * A simple system-wide pub/sub bus.  Subscribers register against a
 * channel (a class constructor); publications are matched using
 * `instanceof`, so subclasses are delivered to base-class subscribers.
 */
type Class<T> = new (...args: any[]) => T;

interface Subscription {
  subscriber: ActorRef;
  channel: Class<unknown>;
}

export class EventStream {
  private subs: Subscription[] = [];

  /** Subscribe an actor ref to a channel (class). Returns true if added. */
  subscribe<T>(subscriber: ActorRef, channel: Class<T>): boolean {
    const already = this.subs.some(
      (s) => s.subscriber.equals(subscriber) && s.channel === channel,
    );
    if (already) return false;
    this.subs.push({ subscriber, channel: channel as Class<unknown> });
    return true;
  }

  /** Unsubscribe from a single channel. Returns true if removed. */
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
    for (const { subscriber, channel } of this.subs) {
      if (event instanceof channel) {
        subscriber.tell(event as never);
      }
    }
  }
}
