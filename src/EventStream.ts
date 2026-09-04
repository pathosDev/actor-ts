import type { ActorRef } from './ActorRef.js';
import { EventKey, type EventChannel, type EventClass } from './EventKey.js';

/**
 * A channel reduced to the three things the bus actually needs from it,
 * computed once when the subscription is made.
 *
 * Resolving at subscribe time is what lets a malformed channel fail on the
 * line that wrote it rather than at some unrelated later `publish` (#1010) —
 * and it keeps the delivery loop free of a "which of the channel forms is
 * this?" branch that would otherwise run per subscription per event on the
 * hottest path in the system: every actor start, every actor stop, every dead
 * letter.
 */
type ResolvedChannel = {
  /**
   * Channel identity for dedup and `unsubscribe`, compared with `===`.
   *
   * A class is its own identity — the constructor object.  Both kind forms
   * reduce to the kind string, so `EventKey.of('x')` and the bare `'x'` name
   * the *same* channel: keys are minted fresh on every `of()`, so an object
   * identity would make `unsubscribe(ref, EventKey.of('x'))` match nothing
   * while looking exactly like the call that would.
   */
  readonly channelId: EventClass<unknown> | string;
  /** Does this event belong to the channel?  Bound once, called per publish. */
  readonly matches: (event: object) => boolean;
  /**
   * How the channel reads in a warning.  Resolved here so the delivery path
   * only ever concatenates a string the bus already owns, and never reads a
   * property off a channel that may be the thing that is wrong.
   */
  readonly label: string;
};

type Subscription = ResolvedChannel & {
  readonly subscriber: ActorRef;
  /** Optional filter — evaluated before delivery; throws → skip. */
  readonly predicate?: (event: unknown) => boolean;
};

/**
 * Optional minimal-logger hook for the bus.  ActorSystem assigns its
 * own logger here after construction; if unset (e.g. ad-hoc test
 * use), predicate failures are silently swallowed.
 *
 * `debug` joined `warn` with the subscription trace (#867), and joined it
 * **optionally**.  `ActorSystem` always assigns a full `Logger`, so a running
 * system always has it; requiring it would only reach the hand-built
 * fixtures, forcing a no-op `debug` into every `{ warn }` object written for
 * a test about predicates.  "Minimal" is what this interface is for, and a
 * hook that does not do debug simply does not trace.
 */
export interface EventStreamLogger {
  debug?(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

/**
 * A simple system-wide pub/sub bus.  Subscribers register against a channel;
 * publications are matched against it and `tell`'d to everyone interested.
 *
 * **Two ways to name a channel.**  A **class**, matched with `instanceof`, so
 * subclass instances reach base-class subscribers — which is what makes an
 * abstract base the most useful channel there is.  Or an event's **`kind`**,
 * named by an {@link EventKey} or by the bare string, matched on the
 * discriminant: the form the project's own message convention needs, since a
 * `kind`-discriminated plain type has no constructor to hand over and until
 * recently could not be subscribed to at all — even though `publish` has
 * always accepted one.
 *
 * **Predicate-filtered subscriptions (#85).**  Each subscription may carry an
 * optional predicate that runs against the event before delivery — only events
 * the predicate accepts are `tell`'d to the subscriber.  Useful for
 * high-frequency channels (cluster events, metrics) where the consumer only
 * cares about a slice of the traffic and would otherwise have to filter inside
 * its own `onReceive`.  A predicate that throws is treated as "no match" for
 * that delivery; the subscription stays active.
 */
export class EventStream {
  private subs: Subscription[] = [];

  /**
   * A single observer that sees every published event (#553).
   *
   * DevTools' bus viewer needs the events themselves, not a subscription to
   * one channel — and it has to see them even when nothing else is
   * listening, which is why this is checked BEFORE the empty-stream return
   * below.  A system nobody observes pays one null check per publish.
   *
   * One slot rather than a list: this is a debugger seam, and a second
   * observer would be a second DevTools.
   */
  private observer: ((event: object) => void) | null = null;

  /**
   * Optional logger used to surface predicate failures.  Assigned by
   * `ActorSystem` once its main logger has been constructed; tests
   * that instantiate `EventStream` directly can leave it `undefined`
   * — the bus stays functional, errors just stay silent.
   */
  log?: EventStreamLogger;

  /**
   * Trace subscribe and unsubscribe at `debug` —
   * `actor-ts.diagnostics.debug.event-stream` (#867).  Assigned by
   * `ActorSystem` from the resolved settings; a bus a test builds by hand
   * keeps the shipped answer, which is silence.
   *
   * A field on the bus rather than a `Config` read, exactly like {@link log}
   * beside it: the stream is constructed before the settings are resolved and
   * has no way to reach them, and the two switches this file needs are worth
   * two assignments rather than a reference back to the system.
   *
   * **Subscription lifecycle only, never `publish`.**  That path runs on
   * every actor start, every stop and every dead letter, and a config key
   * that can put a log call there is not a diagnostic — it is an outage
   * switch.
   */
  traceSubscriptions = false;

  /**
   * Subscribe an actor ref to a channel.  Returns true if a new subscription
   * was added; false if a duplicate was rejected.
   *
   * **Naming the channel.**  A class, an {@link EventKey}, or the bare `kind`
   * string.  The string is the shorthand and it costs the type: `TEvent` has
   * nothing to be inferred from and falls back to `unknown`, so a predicate
   * written against it sees `unknown` unless the caller spells the argument
   * out — `subscribe<UserLoggedInEvent>(ref, 'user-logged-in')`, which also
   * makes the string itself checkable against the type's `kind`.
   *
   * **A key and its string are the same channel**: subscribing both ways
   * dedups, and either one unsubscribes the other.  A class and a kind are
   * not, even when the class's instances carry that `kind` — those are two
   * channels selecting overlapping events, exactly like a base class and its
   * subclass, and an actor holding both subscriptions receives both
   * deliveries.
   *
   * **Dedup rules.**  Without `predicate`, only one subscription per
   * `(subscriber, channel)` is kept — re-calling `subscribe` is a
   * no-op.  With a `predicate`, every call adds a new subscription:
   * predicates are values without an identity contract, so dedup'ing
   * across them would be unreliable; users wanting "replace this
   * filter" should `unsubscribe` first.
   *
   * @throws TypeError when `channel` is neither a usable `instanceof`
   * right-hand side nor a non-empty kind.  Failing on the line that wrote the
   * subscription is the whole point: the alternative is a subscription that
   * poisons an unrelated `publish` in another actor much later (#1010).  It
   * throws rather than returning `false`, because `false` already means
   * "duplicate rejected" and conflating the two destroys the signal the return
   * value carries.
   */
  subscribe<TEvent>(
    subscriber: ActorRef,
    channel: EventChannel<TEvent>,
    predicate?: (event: TEvent) => boolean,
  ): boolean {
    // Resolved before the dedup check, so an invalid channel is rejected even
    // when a duplicate would have short-circuited the push.
    const resolved = resolveChannel(channel, 'subscribe');
    if (!predicate) {
      const already = this.subs.some(
        (s) => s.subscriber.equals(subscriber)
          && s.channelId === resolved.channelId
          && !s.predicate,
      );
      if (already) {
        // The rejected duplicate is traced too, and it is the more useful of
        // the two records: "I subscribed and receive nothing" has dedup as
        // one of its two causes, and the other — a channel that is not the
        // one the publisher uses — is what the label makes visible.
        if (this.traceSubscriptions) {
          this.log?.debug?.(
            `EventStream: subscribe rejected as a duplicate —`
            + ` ${subscriber.path.toString()} on ${resolved.label}`,
          );
        }
        return false;
      }
    }
    this.subs.push({
      ...resolved,
      subscriber,
      predicate: predicate as ((event: unknown) => boolean) | undefined,
    });
    // Guarded at the call site, not only inside a helper: the message is a
    // concatenation and a path render, and a switch that is off must not cost
    // either.  `subscribe` runs on a path a busy system takes often.
    if (this.traceSubscriptions) {
      this.log?.debug?.(
        `EventStream: subscribed ${subscriber.path.toString()} to ${resolved.label}`
        + (predicate ? ' with a predicate' : ''),
      );
    }
    return true;
  }

  /**
   * Unsubscribe a `(subscriber, channel)` pair, or every subscription
   * the actor holds when `channel` is omitted.  Removes ALL matching
   * entries — including predicate-bearing ones; finer-grained removal
   * (one specific predicate at a time) isn't supported because
   * predicates have no stable identity.
   *
   * The test is `!== undefined`, not truthiness.  Truthiness was correct while
   * a channel could only be a constructor; with kind strings legal, `''` is a
   * *supplied* channel that reads as falsy, and the old shape would have taken
   * the omitted-channel branch and dropped every subscription the actor held.
   *
   * The channel is resolved exactly as `subscribe` resolved it, so it is named
   * by identity rather than by object: `EventKey.of('x')` mints a fresh key on
   * every call and would match nothing under `===`.  An invalid channel throws
   * here too — quietly removing nothing is how a subscription survives a
   * cleanup that believed it had done its job (#645, #763).
   */
  unsubscribe<TEvent>(subscriber: ActorRef, channel?: EventChannel<TEvent>): boolean {
    // Resolved *before* the emptiness check below, not after: an invalid
    // channel has to throw whether or not anything is subscribed.  Otherwise a
    // cleanup with a typo in it reports success against an empty stream and
    // only starts failing once somebody subscribes — which is the shape of
    // #645 and #763, one layer up.
    const scoped = channel !== undefined ? resolveChannel(channel, 'unsubscribe') : null;
    const before = this.subs.length;
    // Nothing subscribed: `filter` would allocate a second empty array to say
    // so, and a `false` return needs no array at all.  Every actor stop calls
    // this to drop the subscriptions it may never have made.
    if (before === 0) {
      this.traceUnsubscribe(subscriber, scoped, 0);
      return false;
    }
    this.subs = scoped !== null
      ? this.subs.filter((s) => !(s.subscriber.equals(subscriber) && s.channelId === scoped.channelId))
      : this.subs.filter((s) => !s.subscriber.equals(subscriber));
    this.traceUnsubscribe(subscriber, scoped, before - this.subs.length);
    return this.subs.length !== before;
  }

  /**
   * Trace one `unsubscribe`, when it is worth tracing.
   *
   * A whole-actor call that removed nothing is not: `ActorCell` makes one on
   * every stop, for every actor, whether or not it ever subscribed, so
   * tracing those would bury the subscription records under a copy of the
   * lifecycle trace — which is a separate switch precisely so it can be
   * turned on separately.  A *scoped* call that removed nothing is the
   * opposite: it is somebody's cleanup naming a channel it never held, the
   * failure #645 and #763 were both filed for.
   */
  private traceUnsubscribe(
    subscriber: ActorRef,
    scoped: ResolvedChannel | null,
    removed: number,
  ): void {
    if (!this.traceSubscriptions) return;
    if (removed === 0 && scoped === null) return;
    const target = scoped === null ? 'every channel it held' : scoped.label;
    this.log?.debug?.(
      `EventStream: unsubscribed ${subscriber.path.toString()} from ${target}`
      + ` — ${removed} subscription(s) removed`,
    );
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
  /**
   * Whether anything is listening at all.
   *
   * Coarse on purpose — any channel, any subscriber.  Callers use it to skip
   * *constructing* an event, which is only sound when the answer covers every
   * channel; a per-channel query would let a caller skip building an event a
   * different channel's subscriber was entitled to.  With DevTools attached the
   * cost comes back, which is the intended trade.
   */
  get hasSubscribers(): boolean { return this.subs.length > 0; }

  /**
   * Install the observer, replacing any previous one.  `null` removes it.
   *
   * @internal  DevTools only — not part of the public bus contract.
   */
  _observe(observer: ((event: object) => void) | null): void {
    this.observer = observer;
  }

  publish(event: object): void {
    if (this.observer !== null) {
      // Guarded like any subscription: a bug in a diagnostic must not reach
      // `ref.tell`, which does not throw by contract.
      try {
        this.observer(event);
      } catch {
        /* an observer is an observer; its failures are its own */
      }
    }
    // The snapshot below exists to fix the recipient set for the duration of
    // the loop.  An empty stream has no set to fix, and this is the ordinary
    // state of a system nobody is observing — yet `publish` runs on every
    // actor start, every actor stop, every restart and every dead letter, so
    // the copy was an allocation per lifecycle event to iterate nothing.
    if (this.subs.length === 0) return;
    for (const subscription of [...this.subs]) {
      try {
        if (!this.accepts(subscription, event)) continue;
        subscription.subscriber.tell(event as never);
      } catch (err) {
        this.log?.warn(
          `EventStream: delivering to ${subscription.label} failed`
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
    if (!subscription.matches(event)) return false;
    const { predicate } = subscription;
    if (!predicate) return true;
    try {
      return predicate(event);
    } catch (err) {
      // A throwing predicate must NOT break the bus for other
      // subscribers — treat as "no match" and keep going.
      this.log?.warn(
        `EventStream: predicate threw on ${subscription.label} delivery`
        + ' — treating as no-match',
        err,
      );
      return false;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Channel resolution                                                  */
/* ------------------------------------------------------------------ */

/**
 * Reduce any channel form to the identity, matcher and label the bus stores.
 *
 * The parameter is `unknown` on purpose.  The whole reason this check exists is
 * that the value may not be what the parameter type claims: a JavaScript
 * consumer, a channel read out of a loosely-typed registry, or — the realistic
 * one for a framework this size — an ESM import cycle in which the class
 * binding is still uninitialised at subscribe time, which hands the bus
 * `undefined` with no type error anywhere (#1010).  Typing it as the union
 * would also narrow it to `never` in the final branch, so the check could not
 * be written at all.
 *
 * The closing `throw` is not defensive padding: it is the only remaining
 * answer once the union has been discriminated, and answering it here is what
 * turns "some publish, somewhere, later, in another actor" into "this line is
 * wrong".
 */
function resolveChannel(channel: unknown, operation: string): ResolvedChannel {
  if (channel instanceof EventKey) return kindChannel(channel.kind, operation);
  if (typeof channel === 'string') return kindChannel(channel, operation);
  if (isInstanceofTarget(channel)) {
    const target = channel;
    return {
      channelId: target,
      matches: (event) => event instanceof target,
      label: classLabel(target),
    };
  }
  throw new TypeError(
    `EventStream.${operation}: channel must be a class, an EventKey or a kind string — got `
    + (channel === null ? 'null' : typeof channel),
  );
}

/**
 * Both kind forms — the key and the bare string — reduce to this one shape,
 * which is what makes them the same channel for dedup and `unsubscribe`.
 *
 * The empty string is rejected here rather than in `EventKey`'s constructor:
 * `ServiceKey`, `ShardKey` and `SingletonKey` are all dumb values that validate
 * nothing, and putting it in the stream covers the bare-string form in the same
 * place.  It matters more than it looks — `''` is falsy, and the caller who
 * writes it means "this one channel", not "every subscription I hold".
 */
function kindChannel(kind: string, operation: string): ResolvedChannel {
  if (kind.length === 0) {
    throw new TypeError(
      `EventStream.${operation}: '' is not a kind — it names no event, and it`
      + ' reads like "everything" to whoever wrote it',
    );
  }
  return {
    channelId: kind,
    matches: (event) => (event as { kind?: unknown }).kind === kind,
    label: `kind '${kind}'`,
  };
}

/**
 * Is `channel` usable as the right-hand side of `instanceof`?
 *
 * Deliberately wider than {@link EventClass}: `{ [Symbol.hasInstance]: … }` is
 * a legal right-hand side that no construct signature can describe, so
 * rejecting it would fail a caller whose code works.
 *
 * It is not a proof of safety, and no check here could be — an arrow function
 * is callable but has no `prototype`, so `instanceof` throws on it regardless,
 * and a throwing `[Symbol.hasInstance]` passes any structural test and fails at
 * delivery.  What it buys is the structural cases: `undefined`, `null`, numbers,
 * plain objects, arrays.  That is where the realistic bug lives.  The guard in
 * `publish` is the complementary half; neither subsumes the other.
 */
function isInstanceofTarget(channel: unknown): channel is EventClass<unknown> {
  if (typeof channel === 'function') return true;
  return typeof channel === 'object' && channel !== null && Symbol.hasInstance in channel;
}

/**
 * How a class channel reads in a warning.  Read once at subscribe time, so the
 * delivery path never touches the channel object — the message that matters
 * most is the one for a channel that turned out to be broken.
 */
function classLabel(channel: EventClass<unknown>): string {
  const name = (channel as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : 'an unnamed channel';
}
