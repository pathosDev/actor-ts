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
/**
 * A channel token.  `abstract` is deliberate: matching is by
 * `instanceof`, so an abstract base is a perfectly good channel — and
 * the most useful one, since subscribing to it takes a whole family of
 * events (e.g. every `ActorLifecycleEvent`) with a single call.
 */
type Class<T> = abstract new (...args: any[]) => T;

type Subscription = {
  readonly subscriber: ActorRef;
  readonly channel: Class<unknown>;
  /** Optional filter — evaluated before delivery; throws → skip. */
  readonly predicate?: (event: unknown) => boolean;
};

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
   *
   * @throws TypeError when `channel` cannot be used as the right-hand side of
   * `instanceof`.  Failing on the line that wrote the subscription is the
   * whole point: the alternative is a subscription that poisons an unrelated
   * `publish` in another actor much later (#1010).  It throws rather than
   * returning `false`, because `false` already means "duplicate rejected" and
   * conflating the two destroys the signal the return value carries.
   */
  subscribe<T>(
    subscriber: ActorRef,
    channel: Class<T>,
    predicate?: (event: T) => boolean,
  ): boolean {
    if (!isInstanceofTarget(channel)) {
      throw new TypeError(
        'EventStream.subscribe: channel must be a class — got '
        + (channel === null ? 'null' : typeof channel),
      );
    }
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

  /**
   * Publish an event to all matching subscribers.
   *
   * **The recipient set is fixed when the publish starts.**  `subscriber.tell`
   * can run synchronously — a `PromiseActorRef`, a test probe, an actor on an
   * inline dispatcher — so a handler may subscribe or unsubscribe while the
   * event is still being delivered.
   *
   * The two operations used to disagree about what that meant, because of how
   * they happened to be written rather than by decision: `unsubscribe`
   * *reassigns* `subs`, so the loop kept walking the array it started with and
   * a removed subscriber still got the event, while `subscribe` *pushes* into
   * that same array, so a subscriber added mid-delivery received an event
   * published before it existed (#645).
   *
   * Iterating a snapshot settles it in the direction that was already true for
   * unsubscribe: everyone subscribed when `publish` was called receives the
   * event, and nobody else.  Delivering to a subscriber that did not exist at
   * publish time is the indefensible half; delivering one last event to a
   * subscriber on its way out is harmless — it lands in dead letters like any
   * other message to a stopped actor.
   *
   * **One bad subscription cannot take the others down (#1010).**  Everything
   * done on a subscription's behalf runs under a guard, because all three
   * steps can throw: `instanceof` on a channel that turned out not to be one,
   * the predicate, and `subscriber.tell`.  Only the predicate used to be
   * guarded, so a single faulty entry raised a `TypeError` into whoever called
   * `publish` — and since the throw escaped the loop, every subscription
   * registered *after* it silently stopped receiving anything, in an order no
   * caller controls.  That reached far: `publish` runs on every actor start,
   * every actor stop and every dead-lettered `tell`, so it turned `ref.tell`,
   * an API that does not throw by contract, into one that did.
   */
  publish(event: object): void {
    for (const subscription of [...this.subs]) {
      try {
        if (!this.accepts(subscription, event)) continue;
        subscription.subscriber.tell(event as never);
      } catch (err) {
        this.log?.warn(
          `EventStream: delivering to ${channelLabel(subscription.channel)} failed`
          + ' — skipping this subscriber',
          err,
        );
      }
    }
  }

  /**
   * Does this subscription want this event?
   *
   * The predicate keeps its own guard rather than leaning on the one in
   * `publish`, because its failure has a specific documented meaning — "no
   * match for this delivery, the subscription stays active" (#85) — that a
   * generic delivery guard would flatten into an unexplained skip.
   */
  private accepts(subscription: Subscription, event: object): boolean {
    if (!(event instanceof subscription.channel)) return false;
    const { predicate } = subscription;
    if (!predicate) return true;
    try {
      return predicate(event);
    } catch (err) {
      // A throwing predicate must NOT break the bus for other
      // subscribers — treat as "no match" and keep going.
      this.log?.warn(
        `EventStream: predicate threw on ${channelLabel(subscription.channel)} delivery`
        + ' — treating as no-match',
        err,
      );
      return false;
    }
  }
}

/**
 * Is `channel` usable as the right-hand side of `instanceof`?
 *
 * Deliberately wider than {@link Class}: `{ [Symbol.hasInstance]: … }` is a
 * legal right-hand side that no construct signature can describe, so rejecting
 * it would fail a caller whose code works.
 *
 * It is not a proof of safety, and no check here could be — an arrow function
 * is callable but has no `prototype`, so `instanceof` throws on it regardless,
 * and a throwing `[Symbol.hasInstance]` passes any structural test and fails at
 * delivery.  What it buys is the structural cases: `undefined`, `null`, numbers,
 * plain objects, arrays.  That is where the realistic bug lives — a JavaScript
 * consumer, a channel read out of a loosely-typed registry, or an ESM import
 * cycle in which the class binding is still uninitialised at subscribe time,
 * which hands the bus `undefined` with no type error anywhere.  The guard in
 * `publish` is the complementary half; neither subsumes the other.
 */
function isInstanceofTarget(channel: unknown): channel is Class<unknown> {
  if (typeof channel === 'function') return true;
  return typeof channel === 'object' && channel !== null && Symbol.hasInstance in channel;
}

/**
 * How a channel reads in a warning.
 *
 * Never a bare `channel.name`: the delivery that most needs a legible message
 * is the one where the channel itself is what is wrong, and there `.name` is a
 * read on `undefined`.
 */
function channelLabel(channel: unknown): string {
  const name = (channel as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' && name.length > 0 ? name : 'an unnamed channel';
}
