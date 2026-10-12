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
 * One {@link EventStream.subscribeFunction} call.
 *
 * A record per call rather than the bare function, the shape `Cluster.subscribe`
 * keeps for the same two reasons (#1294): each returned handle removes its own
 * subscription, not merely the first one holding the same function, and the
 * flag is what lets `publish` walk a copy of the list without calling a
 * callback whose handle has already run.
 *
 * Kept apart from the actor subscriptions rather than stored among them behind
 * some stand-in subscriber: nothing that compares, dedups or unsubscribes refs
 * ever has to ask which kind of entry it is holding, and the `unsubscribe`
 * every actor stop makes cannot reach a callback at all.
 */
type CallbackSubscription = ResolvedChannel & {
  /** Typed for the bus, which reads a returned promise; the caller's is `(event: TEvent) => void`. */
  readonly callback: (event: unknown) => unknown;
  /** How the callback reads in a trace or a warning — resolved once, like the channel's label. */
  readonly callbackLabel: string;
  /** Cleared by the handle; nothing else ends a callback subscription. */
  subscribed: boolean;
};

/**
 * How deeply callback deliveries may nest on one stack before the bus stops
 * calling callbacks for the nested event (#1433).
 *
 * A callback runs inside `publish`, on the publisher's stack, so a callback
 * that publishes runs the nested `publish` — and every callback that one
 * reaches — before its own call returns.  A chain of callbacks across channels
 * nests one level per hop and is legal.  A callback whose publish leads back to
 * its own channel nests without end, calling itself once per level until the
 * stack overflows; an actor subscriber cannot do that, because its mailbox
 * takes the delivery off the stack.  Past this depth the nested `publish` still
 * reaches the observer and every actor subscriber, which add no depth, and
 * calls no callback; the bus says so once, at warn.
 *
 * Sixteen is far past any chain of channels a design builds on purpose, and it
 * stops a loop after sixteen redundant calls — long before the stack is at
 * risk.
 */
export const MAX_EVENT_STREAM_CALLBACK_DEPTH = 16;

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
 * publications are matched against it and `tell`'d to every actor interested,
 * or handed to every callback interested.
 *
 * **Two kinds of subscriber.**  An actor, by its ref ({@link subscribe}),
 * receives an event through its mailbox.  A plain callback
 * ({@link subscribeFunction}) is called inside `publish`, with no actor to
 * spawn, name or stop (#1433).  The actor is the default — its mailbox orders,
 * buffers and isolates what it receives — and the callback is for code with
 * nothing to spawn: a counter, a test, a bridge to code outside the actor
 * tree.
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

  /** {@link subscribeFunction}'s subscriptions, in subscription order. */
  private callbacks: CallbackSubscription[] = [];

  /**
   * How many callback deliveries are on the stack right now — the number
   * {@link MAX_EVENT_STREAM_CALLBACK_DEPTH} bounds.  Per bus, not per channel:
   * a loop can run through any number of channels before it comes back.
   */
  private callbackDepth = 0;

  /**
   * A single observer that sees every published event (#553).
   *
   * DevTools' bus viewer needs the events themselves, not a subscription to
   * one channel — and it has to see them even when nothing else is
   * listening, which is why `publish` calls it BEFORE it looks at either
   * subscription list, and why {@link hasSubscribers} counts it: the events
   * a quiet system is spared from building are the actor starts and stops a
   * debugger is opened to watch.  A system nobody observes pays one null
   * check per publish.
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
   * @throws TypeError when `subscriber` is not an ActorRef, or when `channel`
   * is neither a usable `instanceof` right-hand side nor a non-empty kind.
   * Failing on the line that wrote the subscription is the whole point: the
   * alternative is a subscription that poisons an unrelated `publish` in
   * another actor much later (#1010) — or, for a subscriber, every actor stop
   * after it (see {@link assertSubscriber}).  It throws rather than returning
   * `false`, because `false` already means "duplicate rejected" and conflating
   * the two destroys the signal the return value carries.
   */
  subscribe<TEvent>(
    subscriber: ActorRef,
    channel: EventChannel<TEvent>,
    predicate?: (event: TEvent) => boolean,
  ): boolean {
    // Both checked before the dedup check, so an invalid argument is rejected
    // even when a duplicate would have short-circuited the push.
    assertSubscriber(subscriber, 'subscribe');
    const resolved = resolveChannel(channel, 'subscribe');
    if (!predicate) {
      // The channel first: a duplicate is one channel's question, and asking
      // every stored subscriber instead costs two path renders per entry.
      const already = this.subs.some(
        (s) => s.channelId === resolved.channelId
          && !s.predicate
          && this.sameSubscriber(s, subscriber, 'subscribe'),
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
   * cleanup that believed it had done its job (#645, #763).  So does a
   * subscriber that is not an ActorRef, which on an empty stream used to
   * return `false` like a cleanup that simply had nothing to remove.
   */
  unsubscribe<TEvent>(subscriber: ActorRef, channel?: EventChannel<TEvent>): boolean {
    // Both checked *before* the emptiness check below, not after: an invalid
    // argument has to throw whether or not anything is subscribed.  Otherwise
    // a cleanup with a typo in it reports success against an empty stream and
    // only starts failing once somebody subscribes — which is the shape of
    // #645 and #763, one layer up.
    assertSubscriber(subscriber, 'unsubscribe');
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
      ? this.subs.filter((s) => !(s.channelId === scoped.channelId
        && this.sameSubscriber(s, subscriber, 'unsubscribe')))
      : this.subs.filter((s) => !this.sameSubscriber(s, subscriber, 'unsubscribe'));
    this.traceUnsubscribe(subscriber, scoped, before - this.subs.length);
    return this.subs.length !== before;
  }

  /**
   * Is the subscriber stored in `subscription` the one `candidate` names?
   *
   * The comparison runs under a guard because it runs a subscriber's own code:
   * `equals`, and through `ActorRef.equals` the `path` rendering of *both*
   * sides.  The structural check in {@link assertSubscriber} can only ask
   * whether those members exist, so a ref whose `equals` throws passes it and
   * is stored — and unguarded, every later `unsubscribe` threw out of the
   * comparison with it.  `ActorCell` makes that call on every actor stop, so a
   * single such entry stalled every stop after it and `terminate()` with them,
   * and on a bus holding anything else the dedup check made every later
   * predicate-free `subscribe` throw, failing an unrelated actor's `preStart`.
   * That is #1010's "a faulty subscription cannot reach spawn or shutdown", by
   * the one route a structural check cannot close.
   *
   * A comparison that throws answers "a different subscriber", with a warning.
   * The throw may come from either side — the stored entry's `equals`, or the
   * candidate's `path` that a well-behaved `equals` reads — so neither is
   * evicted for it; the entry stays on the bus, and keeps receiving what it
   * subscribed to.  Identity is checked first and decides on its own, which is
   * what keeps the faulty entry removable at all: its `equals` throws even
   * against itself, and a subscription its owner cannot remove is a leak.
   */
  private sameSubscriber(subscription: Subscription, candidate: ActorRef, operation: string): boolean {
    if (subscription.subscriber === candidate) return true;
    try {
      return subscription.subscriber.equals(candidate);
    } catch (error) {
      this.log?.warn(
        `EventStream.${operation}: comparing against a subscriber of ${subscription.label} threw`
        + ' — treating the two as different subscribers',
        error,
      );
      return false;
    }
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
   * Subscribe a plain callback to a channel — no actor to spawn, name or stop
   * (#1433).  Returns the handle that ends this subscription.
   *
   * The channel is named exactly as for {@link subscribe} — a class, an
   * {@link EventKey} or the bare `kind` string — and a class or a key types
   * the callback's parameter.
   *
   * **Delivery is synchronous.**  The callback runs inside `publish`, on the
   * publisher's stack, after every actor subscriber has been told, so an event
   * a callback causes still reaches the actors after the event that caused it.
   * That is the price of having no mailbox: a slow callback slows every publish
   * of its channel, which for the framework's own events means every actor
   * start, stop or dead letter.  Work that takes time belongs in an actor.
   *
   * **The handle.**  Every call is a subscription of its own — no dedup, so the
   * same function subscribed twice is called twice — and its handle ends
   * exactly that one; calling it again does nothing.  Once it has returned the
   * callback is not called again, not even with an event already being
   * delivered: a ref's one late event lands in dead letters, but a callback has
   * no mailbox, and a late call would run code its owner has already torn down.
   * A callback subscribed while an event is being delivered starts with the
   * next one.  No actor stop reaches it — the `unsubscribe` every stop makes
   * concerns refs only — so the handle is the way to end it.
   *
   * **A failing callback stays its own problem.**  A throw is reported at warn
   * and skips that callback for that event; it stays subscribed, and everyone
   * else still receives the event.  A returned promise is not awaited, only kept
   * from rejecting unhandled — which Node answers with a process exit — and its
   * rejection is reported the same way.
   *
   * **A callback must not publish on its own channel**, directly or through
   * another callback: the nested `publish` calls it again before its first call
   * has returned, and so on down the stack.  Publishing on another channel is
   * fine.  Past {@link MAX_EVENT_STREAM_CALLBACK_DEPTH} nested levels the bus
   * calls no callback for the nested event and warns once.
   *
   * @throws TypeError when `channel` is unusable, as {@link subscribe} does,
   * or when `callback` is not a function.  Refused on the line that wrote it,
   * rather than stored to fail at every delivery after it.
   */
  subscribeFunction<TEvent>(
    channel: EventChannel<TEvent>,
    callback: (event: TEvent) => void,
  ): () => void {
    const resolved = resolveChannel(channel, 'subscribeFunction');
    assertCallback(callback);
    const subscription: CallbackSubscription = {
      ...resolved,
      callback: callback as (event: unknown) => unknown,
      callbackLabel: callbackLabel(callback),
      subscribed: true,
    };
    this.callbacks.push(subscription);
    if (this.traceSubscriptions) {
      this.log?.debug?.(
        `EventStream: subscribed ${subscription.callbackLabel} to ${resolved.label}`,
      );
    }
    return () => { this.removeCallback(subscription); };
  }

  /** What a {@link subscribeFunction} handle does: end that one subscription, once. */
  private removeCallback(subscription: CallbackSubscription): void {
    if (!subscription.subscribed) return;
    // The flag first: it is what a delivery already walking its copy of the
    // list reads, and it has to read "gone" from this line on.
    subscription.subscribed = false;
    const index = this.callbacks.indexOf(subscription);
    if (index >= 0) this.callbacks.splice(index, 1);
    if (this.traceSubscriptions) {
      this.log?.debug?.(
        `EventStream: unsubscribed ${subscription.callbackLabel} from ${subscription.label}`,
      );
    }
  }

  /**
   * Whether anything is listening at all — a subscription of either kind, or
   * the observer.
   *
   * Coarse on purpose — any channel, any subscriber.  Callers use it to skip
   * *constructing* an event, which is only sound when the answer covers every
   * channel; a per-channel query would let a caller skip building an event a
   * different channel's subscriber was entitled to.  The observer is entitled
   * to every event, so it counts for the same reason: left out, an observer on
   * an otherwise quiet system never saw an actor start or stop.  So does a
   * callback, for which it would have been the same silence.  With DevTools
   * attached the cost comes back, which is the intended trade.
   */
  get hasSubscribers(): boolean {
    return this.subs.length > 0 || this.callbacks.length > 0 || this.observer !== null;
  }

  /**
   * Install the observer, replacing any previous one.  `null` removes it.
   *
   * @internal  DevTools only — not part of the public bus contract.
   */
  _observe(observer: ((event: object) => void) | null): void {
    this.observer = observer;
  }

  /**
   * Publish an event to all matching subscribers: the observer first, then
   * every actor subscriber, then every callback.
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
   *
   * **Callbacks come last (#1433)**, under a guard of their own — see
   * {@link callCallbacks} for their order, their recipient rule and the depth
   * bound a callback that publishes runs into.
   */
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
    if (this.subs.length > 0) {
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
    if (this.callbacks.length > 0) this.callCallbacks(event);
  }

  /**
   * Call every callback whose channel matches the event.
   *
   * **After the actor subscribers**, because a callback runs on this stack and
   * may publish.  Its nested event is told to the actors from inside this
   * call, so had the callbacks gone first, every actor's mailbox would hold the
   * nested event ahead of the one that caused it.  Callbacks themselves cannot
   * be spared that: a callback later in the list sees a nested event before the
   * one in flight, which is one more reason for the rule against publishing on
   * one's own channel.
   *
   * **Over a copy, skipping whatever left since** — `Cluster.subscribe`'s rule
   * (#1294).  The copy keeps a callback subscribed mid-delivery from receiving
   * an event published before it existed (#645); the `subscribed` flag keeps a
   * callback whose handle has run from being called with the event in flight,
   * which for a ref is a harmless dead letter and for a callback is a call into
   * code its owner has already torn down.
   *
   * **The depth bound** counts callback deliveries on the stack, and is checked
   * against the first callback that actually wants the event: a nested publish
   * no callback wants costs nothing and says nothing.  The `finally` is not
   * ceremony — the warning a throwing callback produces runs outside any guard,
   * so a logger that throws leaves through here, and a depth left raised would
   * have every later publish find the bound already reached.
   */
  private callCallbacks(event: object): void {
    const tooDeep = this.callbackDepth >= MAX_EVENT_STREAM_CALLBACK_DEPTH;
    const recipients = [...this.callbacks];
    this.callbackDepth++;
    try {
      for (const subscription of recipients) {
        if (!subscription.subscribed || !this.wants(subscription, event)) continue;
        if (tooDeep) {
          this.log?.warn(
            `EventStream: callback deliveries are nested ${MAX_EVENT_STREAM_CALLBACK_DEPTH} deep`
            + ` — calling no callback for this event on ${subscription.label};`
            + ' a callback that publishes on its own channel calls itself',
          );
          return;
        }
        this.callCallback(subscription, event);
      }
    } finally {
      this.callbackDepth--;
    }
  }

  /**
   * Does the callback's channel match the event?  Guarded like the same test in
   * the actor loop, because `instanceof` runs the channel's own code and a
   * channel can pass every check at subscribe time and still throw here (#1010).
   */
  private wants(subscription: CallbackSubscription, event: object): boolean {
    try {
      return subscription.matches(event);
    } catch (error) {
      this.log?.warn(
        `EventStream: matching an event against ${subscription.label} threw`
        + ` — skipping ${subscription.callbackLabel} for it`,
        error,
      );
      return false;
    }
  }

  /** One call, with its throw — or its returned promise's rejection — reported, never propagated. */
  private callCallback(subscription: CallbackSubscription, event: object): void {
    try {
      const returned = subscription.callback(event);
      if (isThenable(returned)) {
        returned.then(undefined, (error: unknown) => {
          this.log?.warn(
            `EventStream: ${subscription.callbackLabel} on ${subscription.label}`
            + ' returned a promise that rejected',
            error,
          );
        });
      }
    } catch (error) {
      this.log?.warn(
        `EventStream: ${subscription.callbackLabel} on ${subscription.label} threw`
        + ' — skipping it for this event',
        error,
      );
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

/* ------------------------------------------------------------------ */
/* Subscriber validation                                               */
/* ------------------------------------------------------------------ */

/**
 * Refuse a subscriber that is not an ActorRef, on the line that passed it.
 *
 * The bus touches three members of a subscriber and asks for exactly those:
 * `tell` to deliver, `equals` for dedup and `unsubscribe`, and `path`, which
 * every ref's `equals` reads off the other side and the subscription trace
 * renders.  `equals` is the one that made this necessary.  `unsubscribe` calls
 * it on every stored subscriber, and `ActorCell` calls `unsubscribe` on every
 * actor stop, so a single stored entry without it threw out of every
 * `finalizeTermination` that followed: the stopped actor's watchers were never
 * told, its name stayed taken, and `terminate()` never settled — the shutdown
 * #1010 promised a faulty subscription could not reach.  The likeliest such
 * entry is a plain function, which is what a JavaScript caller writes when it
 * guesses that the bus takes a callback.
 *
 * Structural rather than `instanceof ActorRef`, like the channel check: a ref
 * minted by another copy of this module — a second install of the package, or
 * one file loaded under two specifiers — fails `instanceof` and works
 * everywhere else.  Nor is it a proof of good behaviour: a `tell` that throws
 * is still the delivery guard's business in `publish`, and an `equals` that
 * throws the comparison guard's in `sameSubscriber`.
 *
 * The parameter is `unknown` for the reason {@link resolveChannel}'s is: the
 * value is checked precisely because it may not be what its type claims.
 */
function assertSubscriber(subscriber: unknown, operation: string): asserts subscriber is ActorRef {
  const disqualification = subscriberDisqualification(subscriber);
  if (disqualification === null) return;
  throw new TypeError(
    `EventStream.${operation}: subscriber must be an ActorRef — got ${disqualification}`,
  );
}

/** What keeps `subscriber` off the bus, phrased for the error; `null` when nothing does. */
function subscriberDisqualification(subscriber: unknown): string | null {
  if (subscriber === null || subscriber === undefined) return String(subscriber);
  const candidate = subscriber as { tell?: unknown; equals?: unknown; path?: unknown };
  if (typeof candidate.tell !== 'function') {
    // The function case gets the hint, because it is the one with a reason
    // behind it: the caller wanted the callback form, which is a different
    // method with the channel first.
    if (typeof subscriber === 'function') {
      return 'a function (subscribe takes the ref of an actor; subscribeFunction(channel,'
        + ' callback) is the form that takes a callback)';
    }
    return typeof subscriber === 'object'
      ? 'an object without a callable tell'
      : `a ${typeof subscriber}`;
  }
  if (typeof candidate.equals !== 'function') return 'an object without a callable equals';
  if (candidate.path === null || candidate.path === undefined) return 'an object without a path';
  return null;
}

/* ------------------------------------------------------------------ */
/* Callbacks                                                           */
/* ------------------------------------------------------------------ */

/**
 * Refuse a callback that is not a function, on the line that passed it.
 *
 * Stored, it would fail at every delivery instead — contained by the guard in
 * `publish` and reported at warn, but once per event and far from the call
 * that was wrong.  The parameter is `unknown` for the reason
 * {@link resolveChannel}'s is.
 */
function assertCallback(callback: unknown): void {
  if (typeof callback === 'function') return;
  throw new TypeError(
    `EventStream.subscribeFunction: callback must be a function — got ${callbackDisqualification(callback)}`,
  );
}

/** What the value in the callback slot is, phrased for the error. */
function callbackDisqualification(callback: unknown): string {
  if (callback === null || callback === undefined) return String(callback);
  if (typeof callback !== 'object') return `a ${typeof callback}`;
  // The likeliest object here is a ref, from a call written in the other form.
  return typeof (callback as { tell?: unknown }).tell === 'function'
    ? 'an ActorRef (subscribe(ref, channel) is the form that takes one)'
    : 'an object';
}

/**
 * How a callback reads in a trace or a warning.  Its name when it has one — a
 * function declaration, or an arrow assigned to a variable before it was passed
 * — because a callback has no path, and "a callback on EventA threw" does not
 * say which.
 */
function callbackLabel(callback: (event: never) => unknown): string {
  const { name } = callback;
  return typeof name === 'string' && name.length > 0 ? `callback ${name}` : 'an anonymous callback';
}

/** A returned promise, or anything else `await` would treat as one. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && typeof (value as { then?: unknown }).then === 'function';
}
