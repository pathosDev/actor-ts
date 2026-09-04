import type { ActorRef } from '../ActorRef.js';
import type { LogContextData } from '../LogContext.js';
import type { SpanContext } from '../tracing/Tracer.js';
import { RingBuffer } from '../util/RingBuffer.js';

export type Envelope<T = unknown> = {
  readonly message: T;
  readonly sender: ActorRef | null;
  /**
   * Optional MDC snapshot captured at `tell` time.  Propagated
   * through the actor's `onReceive` so log lines emitted while
   * handling this message (and any tells issued from inside it)
   * carry the originating context.  See {@link LogContext}.
   */
  readonly context?: LogContextData;
  /**
   * Optional active-span context captured at `tell` time.  If the
   * tracing extension is enabled and the receiver also has it
   * enabled, the receiver's `actor.receive` span links back to this
   * one as its parent — producing one coherent trace across actor
   * hops and cluster nodes.  See {@link Tracer}.
   */
  readonly trace?: SpanContext;
  /**
   * Wall clock at first enqueue, stamped while the receiving actor has an
   * explain plan enabled **or** the system has metrics enabled — the two
   * consumers of it (`ActorContext.enableExplainPlan` and
   * `actor_mailbox_wait_seconds`).  Absent otherwise, because a stamp is a
   * clock read on the framework's hottest path and #411 removed exactly
   * these when nothing reads them.
   *
   * A stashed message keeps its original stamp when replayed (`prependUser`
   * does not restamp), so the explain plan's mailbox wait measures the whole
   * time from arrival to handling — stash residency included, which is what
   * a per-actor debugging view wants beside the `stashed` outcome that
   * explains it.  The metric deliberately reads it differently; see
   * {@link replayed}.
   *
   * Resolution is one millisecond (`Date.now()`), which is why the wait
   * histogram's finest bucket is 1 ms rather than something sub-millisecond
   * that the clock could never distinguish.
   */
  readonly enqueuedAtMs?: number;
  /**
   * Set when this envelope re-entered the queue from the stash rather than
   * arriving fresh, so {@link enqueuedAtMs} no longer marks the start of its
   * current queue residency.
   *
   * `actor_mailbox_wait_seconds` skips these.  The aggregate has no labels
   * and no outcome column, so one actor stashing for thirty seconds while it
   * waits on a resource would land a thirty-second observation in the top
   * bucket and drown the queueing signal every other actor contributes —
   * where the explain plan shows the same message beside the `stashed`
   * entry that accounts for it.  Stash residency is application semantics;
   * mailbox wait is meant to be backlog.
   *
   * The other replay path, `ActorCell.prependUserMessages`, needs no marker:
   * it builds envelopes with no stamp at all, so it is already excluded.
   * Throttle re-parking is deliberately *not* marked — a throttled message
   * really is waiting in the queue for an actor that cannot keep up, which
   * is precisely what the metric is asking about.
   */
  readonly replayed?: boolean;
  /**
   * This envelope carries something the framework cannot send again, so no
   * load-shedding policy may discard it (#729).
   *
   * Three envelopes take it today, and the test for admitting a fourth is the
   * property they share, not their subject: it is sent once, nothing on the
   * framework's side still holds what it would take to send it again, and what
   * is lost when it is dropped is not a *message* but a piece of state outside
   * the mailbox that no one else will correct.  So the caller who set the
   * bound was not choosing to lose it — it is not the traffic they were
   * shedding, and the loss does not surface where they would look for it.
   *
   * The `Terminated` a death-watch delivers.  The watch was installed through
   * `context.watch`, the framework promised to answer it, and the answer
   * happens once — there is no retry, no sender to back off, and the dying
   * cell has already cleared its watcher set by the time the queue decides.
   * A bounded mailbox that evicted it left the watcher believing a dead actor
   * was alive, with nothing but an `actor_mailbox_dropped_total` increment to
   * say so.
   *
   * The `websocket-accept` a completed HTTP upgrade hands its hub (#717).  The
   * wiring layer closed the only reference to a freshly-upgraded socket into
   * the per-connection actor's factory and returned; there is no timer and no
   * second copy.  A bounded hub that evicted it kept a socket nobody would
   * ever attach listeners to — buffering inbound frames with nothing to drain
   * them and holding its `maxConnections` slot — for the same one increment.
   *
   * The `close` a `WebsocketConnection` sends its own actor (#985).  This one
   * is application-*initiated*, unlike the two above, and admitting it widens
   * the rule on purpose rather than by stretching it: what a dropped close
   * loses is a decision about a socket, not a message.  There is no retry and
   * no sender to back off, nothing else in the process holds that socket, and
   * a `closeAll(1008, 'rate limited')` that returns normally while the peers
   * stay connected is a control that failed open — a security outcome, from a
   * bound the operator set to cap *frames*.
   *
   * Set by {@link ActorCell.postSignalEnvelope}, which is the only door that
   * sets it, and read in four places: {@link Mailbox.removeOldest} and
   * {@link Mailbox.removeNewest}, so an eviction from either end steps over
   * it; `BoundedMailbox.prependUser` **and** `PriorityMailbox.prependUser`, so
   * a bound that now applies to the replay path admits it rather than shedding
   * it (#772); and the cell's throttle gate, so `onExcess: 'drop'` does not
   * silently consume it either.
   *
   * Both replay overrides are named because listing one of them was the last
   * hole (#729).  The two bounds reach the same rule by different routes —
   * `BoundedMailbox` tests the marker per envelope before it consults its
   * capacity, `PriorityMailbox` hands the envelope to `enqueueSignal` — and a
   * reader who took "the replay path" to mean "whichever mailbox the list
   * happened to name" would have re-derived exactly the omission: the priority
   * bound re-entered its own `enqueue`, whose capacity check does not read
   * this field at all.
   *
   * It travels with the envelope rather than being remembered by the mailbox
   * because the envelope outlives any one queue position: `ActorContext.stash()`
   * parks the envelope the cell is holding, so `unstashAll()` hands the queue
   * back the very object the exempt door built, and the `prependUser` replay it
   * takes then meets a bound that would otherwise get a second chance to shed
   * it.
   *
   * **The typed stash is the exception, and it is an open gap (#1319).**
   * `Behaviors.withStash` cannot park an envelope — `StashBuffer.stash(message)`
   * takes an arbitrary value where the cell can only park what it is currently
   * handling — so the buffer keeps bare messages, and its replay half,
   * `ActorCell.prependUserMessages`, rebuilds them as message-plus-null-sender.
   * Nothing envelope-level survives that trip: no `context`, no `trace`, no
   * {@link enqueuedAtMs}, and no marker.  So a typed actor that stashes its own
   * `Terminated` hands a droppable envelope back to its own bound, and the
   * guarantee the paragraph above states does not reach it.  The fix belongs on
   * the typed side rather than here — a buffer that parks envelopes, or a replay
   * door told which of them were exempt — because every reader of this field
   * already does the right thing with an envelope that still carries it.
   */
  readonly undroppable?: boolean;
};

/**
 * Why a mailbox discarded a message — the `reason` label on
 * `actor_mailbox_dropped_total`.
 *
 * Deliberately a closed set of two rather than a free-form string, even for a
 * mailbox of your own: `reason` is a metric label, and an open one is a
 * cardinality vector (#745).  That constraint got sharper once #658 removed
 * `path` — `class` and `reason` are now the family's only dimensions, so a
 * free-form `reason` would be the single thing standing between it and
 * unbounded growth.  Pick whichever describes what you did — you dropped the
 * oldest queued message, or you dropped the arriving one.  Refusing a message
 * is not a drop; that throws instead.
 *
 * Lives here rather than in `BoundedMailboxOptions.ts` despite typing an
 * option field there: it is the vocabulary of {@link DropReportingMailbox},
 * which every mailbox may implement, and `BoundedMailbox` is only the
 * built-in one that does.  The layering runs base → subclass, so the shared
 * word belongs at the base.
 */
export type MailboxDropReason = 'drop-head' | 'drop-new';

/**
 * A mailbox that discards messages and is willing to say so.
 *
 * Implement it on a {@link Mailbox} subclass of your own and the cell counts
 * its drops in `actor_mailbox_dropped_total`, with the same `{class, reason}`
 * labels the built-in bound produces.  `BoundedMailbox` implements it; nothing
 * else needs to.
 *
 * Those labels identify a *class*, not an actor — the stock family carries no
 * `path` (#658).  If you need to know which instance is shedding, observe it
 * yourself: registration is additive, so your own observer runs alongside the
 * framework's and you choose that series' cardinality.
 *
 * The cell probes for this method rather than testing
 * `instanceof BoundedMailbox` on purpose.  Since #661 the base `Mailbox` is
 * public and subclassing it is a supported thing to do, so a queue that drops
 * for its own reasons should not be second-class in the telemetry.
 *
 * A report carries the **envelope** as well as the reason since #773, and a
 * mailbox that sets {@link deadLetterDrops} also gets each dropped envelope
 * turned into a {@link DeadLetter} — so overflow stops being the one loss
 * path in the framework with no forensic record.
 */
export interface DropReportingMailbox<T = unknown> {
  /**
   * Register a drop observer.  Called by the cell once, before the mailbox
   * receives anything.
   *
   * **Additive, not a setter.**  Whatever the mailbox already reports —
   * `BoundedMailboxOptions.onDrop`, a previously registered observer — has to
   * keep firing.  A caller who wired their own metric does not lose it
   * because the framework wired the stock one.
   */
  observeDrops(observer: MailboxDropObserver<T>): void;
  /**
   * Should the cell turn each drop this mailbox reports into a
   * {@link DeadLetter} on the system's dead-letter path (#773)?
   *
   * **The mailbox owns the switch, the cell owns the routing**, and the split
   * is why this sits on the interface rather than in `ActorOptions`.  A
   * `withMailbox` mailbox is configured where it is constructed and the cell
   * never sees its options; a cell-side flag would therefore reach exactly
   * the shape that already reports and miss the one that #1149 had to add a
   * structural probe for.
   *
   * **Absent or `false` means no**, and the default is deliberate rather than
   * timid.  `enqueue` runs on the *sender's* stack, and `DeadLetterRef.tell`
   * runs the durable capture sink and a synchronous event-stream publish, so
   * routing every shed envelope converts load shedding into per-message work
   * under exactly the pressure the bound exists to absorb.  Rate-limiting the
   * dead-letter stream itself is #1179 and belongs downstream of the capture,
   * not here.
   *
   * The envelope reaches the observers either way — a drop report has always
   * been free to carry what it lost, and an `onDrop` of your own may want it
   * without wanting the framework's fan-out.
   */
  readonly deadLetterDrops?: boolean;
}

/**
 * What a {@link DropReportingMailbox} hands an observer when it discards a
 * message: the reason, and the envelope that was discarded (#773).
 *
 * A `type` rather than an `interface` because it is one callback's shape and
 * prescribes nothing anyone implements.
 *
 * The envelope is the half that makes the loss *recoverable*: `message` and
 * `sender` are what a {@link DeadLetter} is built from, and `context` /
 * `trace` are what attribute it to the request that produced it.  Before
 * #773 the seam carried the reason alone, so the only mailbox in the
 * framework that discards messages was also the only loss path that could
 * not say what it had lost.
 */
export type MailboxDropObserver<T = unknown> =
  (reason: MailboxDropReason, envelope: Envelope<T>) => void;

/**
 * Does this mailbox report its drops?  The structural check that keeps
 * {@link DropReportingMailbox} open to implementations the framework has
 * never heard of.
 */
export function reportsDrops<T>(
  mailbox: Mailbox<T>,
): mailbox is Mailbox<T> & DropReportingMailbox<T> {
  return typeof (mailbox as Partial<DropReportingMailbox<T>>).observeDrops === 'function';
}

/**
 * Per-actor message queue.  System messages (create, terminate, failure, …)
 * are kept on a separate priority queue and drained before any user message.
 *
 * Both queues are {@link RingBuffer}s rather than plain arrays, which is
 * invisible from the outside and load-bearing underneath: every removal used
 * to be an `Array.prototype.shift()`, and that reindexes the whole backlog.
 * Since #1148 made the unbounded mailbox the default again there is no
 * capacity capping how deep a backlog gets, so an actor that falls behind its
 * producers was paying a memmove of its entire queue for every message it
 * delivered (#408).
 *
 * The fields stay `private`, so a subclass sees only the methods — which is
 * why swapping the backing store is not a breaking change even though
 * `Mailbox` is public and explicitly subclassable since #661 / #1002.  The
 * seams a subclass touches are `protected` {@link removeOldest} and
 * {@link removeNewest}, and their signatures are unchanged.
 */
export class Mailbox<T = unknown> {
  private readonly userQueue = new RingBuffer<Envelope<T>>();
  private readonly systemQueue = new RingBuffer<Envelope<unknown>>();
  private _suspended = false;

  get suspended(): boolean { return this._suspended; }

  enqueue(env: Envelope<T>): void {
    this.userQueue.push(env);
  }

  /**
   * Queue a framework lifecycle notification — see {@link Envelope.undroppable}
   * — at the tail of the user lane, **exempt from whatever bound this mailbox
   * enforces**.
   *
   * Override this whenever you override {@link enqueue} to shed load.  The
   * default here delegates, which is right for a queue that never discards
   * anything and wrong for one that does: a subclass that drops on a full
   * queue would drop this too, and the framework has no second copy to send.
   * Delegating rather than pushing straight onto the base queue is deliberate
   * — a subclass may keep its messages somewhere else entirely (`PriorityMailbox`
   * keeps a priority-ordered array), and an envelope smuggled into a store that
   * subclass never reads is worse than one it dropped: invisible to its
   * `dequeueUser`, its `size` and its `drainUser`, so not even a dead letter
   * comes out of it.
   *
   * The envelope still arrives at the **tail**, which is what keeps the
   * documented death-watch ordering intact: every `tell` already queued is
   * handled first, then the notification.  It is not a priority lane and must
   * not become one — the system queue is where the framework puts messages
   * that overtake user traffic, and a `Terminated` deliberately is not one of
   * those.
   */
  enqueueSignal(env: Envelope<T>): void {
    this.enqueue(env);
  }

  /**
   * Put envelopes at the FRONT of the user queue, preserving their order.
   *
   * One bulk move, not a spread: `unstashAll` replays up to
   * `DEFAULT_STASH_CAPACITY` envelopes in a single call, and
   * `unshift(...envs)` would both reindex the backlog once per envelope and
   * push the whole batch onto the call stack as arguments.
   *
   * **Override this whenever you override {@link enqueue} to shed load**, for
   * the same reason {@link enqueueSignal} says so and the opposite conclusion:
   * a signal is exempt from a bound, a replay is not.  Leaving the default in
   * place is what made a bounded mailbox unbounded on the stash path — a
   * batch the size of the stash arrived past the capacity check, the overflow
   * policy and the drop accounting, so the ceiling an operator tuned against
   * measured heap was not one (#772).  `BoundedMailbox` and `PriorityMailbox`
   * both override it, by different routes: the former sheds at the tail to
   * make room at the head, the latter re-enters `enqueue` so priorities are
   * recomputed.
   *
   * The base is right to be unconditional here — it never discards anything,
   * so there is nothing to consult.
   */
  prependUser(envs: Array<Envelope<T>>): void {
    this.userQueue.unshiftAll(envs);
  }

  /**
   * Queue a framework `SystemCommand` on the lane that overtakes all user
   * traffic.
   *
   * **This lane is deliberately uncapped, and no bound reaches it — including
   * a subclass's own.**  It writes straight to the private system ring rather
   * than delegating, which is the deliberate opposite of {@link enqueueSignal}
   * two methods up: a signal rides the *user* lane and therefore has to go
   * through whatever store a subclass keeps, while a system command has no
   * business in that store at all.  So overriding {@link enqueue} to shed load
   * bounds the user queue and leaves this one alone, and neither
   * `BoundedMailbox` nor `PriorityMailbox` overrides this method.  A capacity
   * an operator tunes against measured heap is a user-queue capacity; say so
   * when you document one.
   *
   * The reason is the one {@link Envelope.undroppable} gives one layer up, at
   * full strength: supervision and lifecycle must never be dropped.  A
   * discarded `failure` leaves an actor suspended with nobody coming to decide
   * about it, a discarded `childTerminated` leaks a child registration
   * forever, and a discarded `terminate` strands the cell — none of which the
   * framework has a second copy to re-send, and all of which fail *silently*
   * in the direction of a wedged actor rather than a lost message.  Nor does
   * the drain loop in `ActorCell.run` carry a per-turn budget, for the
   * matching reason: a budget would interleave a supervision decision with
   * user traffic that decision exists to gate, and reordering supervision is a
   * worse trade than the user-message starvation an unbounded drain admits.
   *
   * **What bounds it instead is the producer, and that is the property to
   * re-check before adding a system-message source.**  Every caller today is
   * one envelope per event that already costs the node an actor: one `create`
   * per cell and one `terminate` per stop, one `childTerminated` per child that
   * finishes stopping, and per supervision decision one `failure` to the parent
   * plus whatever it fans out over the failing subtree — `suspend`, then
   * `resume`, `recreate` or `terminate` once the directive is known.  One
   * `receiveTimeout` per armed timer that expires completes the list.
   *
   * `watchNotify` is the declared variant that is deliberately **not** on it,
   * and putting it there — as "one per watched death" — was this JSDoc's own
   * first mistake.  Nothing in `src/` emits one; `ActorCell.onWatchNotify` says
   * so at the arm that would handle it.  Nor does a watched death reach this
   * queue by another name: `ActorCell._notifyWatcher` hands a local watcher its
   * `Terminated` through `postSignalEnvelope`, which is the **user** lane —
   * exempt from the bound (see {@link Envelope.undroppable}) and still behind
   * everything already told to that watcher, because that ordering is what
   * death watch documents.  Watching a thousand actors therefore adds nothing
   * to the depth here.  The arm stays wired and stays exempt so that giving it
   * a producer later cannot reintroduce the loss by taking the ordinary door
   * (#729) — at which point it joins the list above, and the ratio below is
   * what has to be re-checked for it.
   *
   * That test is about *volume*, not about who can reach the method, which is
   * why the sharding path does not change the answer even though it looks like
   * it should.  A remote peer addressing entities in a shard really does drive
   * this queue: `dispatchEnvelope` only ever reaches a `tell` on the user lane,
   * but the `Shard` actor handling that user message spawns and watches an
   * entity, and every entity it spawns eventually lands a `childTerminated`
   * here at passivation or handoff.  "A cluster peer cannot invoke it" is
   * therefore true of the call site and beside the point for a queue depth.
   *
   * It needs no bound anyway because there is **no amplification**: each
   * envelope is paid for by one entity cell — its own mailbox, watch
   * registration and registry entry — that had to exist first and was admitted
   * through the region's routing bound on the way in.  A peer that can queue N
   * of these has already made the node hold N actor cells, so the lane is a
   * strictly smaller copy of a cost accepted upstream; and the envelope is
   * enqueued *as* the cell goes away, replacing something larger than itself,
   * so the peak falls rather than rises at the moment the traffic appears.
   *
   * A source that broke that ratio — one cheap remote action queueing many
   * envelopes, or envelopes tied to no resource the node already gates — is
   * what would need an answer, and the answer would be per-kind coalescing
   * (collapse duplicate `suspend` / `resume` for the same child) rather than a
   * cap.  Dropping is the one thing this lane may not do.
   */
  enqueueSystem(env: Envelope<unknown>): void {
    this.systemQueue.push(env);
  }

  dequeueUser(): Envelope<T> | undefined {
    if (this._suspended) return undefined;
    return this.userQueue.shift();
  }

  /**
   * Remove the oldest **droppable** user message, regardless of suspension.
   *
   * `dequeueUser` refuses while suspended, and rightly so — a suspended actor
   * must not be handed work.  Making room in a full queue is a different
   * question: it is not delivery, and a bounded mailbox that quietly stops
   * enforcing its bound while the actor is suspended is unbounded exactly when
   * the bound matters most, since suspension means the actor has failed and is
   * awaiting its parent's supervision decision while messages keep arriving.
   *
   * Envelopes marked {@link Envelope.undroppable} are stepped over rather than
   * evicted, and put back in the order they were queued (#729).  Queueing the
   * notification exempt from the bound is only half the guarantee: `drop-head`
   * evicts the *oldest* message, so a `Terminated` that reached the tail
   * safely becomes the head again after enough newer arrivals and would be
   * destroyed then instead.  Both halves are needed, and this is the one that
   * every bound built on this seam — including a caller's own — inherits
   * without knowing about it.
   *
   * Returns `undefined` when the queue holds nothing that may be dropped,
   * which lets the caller distinguish a real drop from a no-op.  A queue made
   * entirely of undroppable notifications therefore *exceeds* its capacity
   * rather than losing one, by however many of them there are — bounded by the
   * watcher's watch set, and the alternative is trading a bounded overshoot
   * for an unbounded ability to lose exactly the messages a bound must keep.
   *
   * Cost is one shift on the ordinary path (nothing is marked) and O(k) when k
   * notifications sit at the front, on the overflow path, which is already the
   * slow one.
   */
  protected removeOldest(): Envelope<T> | undefined {
    // Allocated only once something is actually stepped over, so the common
    // case — an empty `held` — costs no array at all.
    let held: Array<Envelope<T>> | null = null;
    for (;;) {
      const candidate = this.userQueue.shift();
      if (candidate === undefined) break;
      if (candidate.undroppable !== true) {
        if (held !== null) this.userQueue.unshiftAll(held);
        return candidate;
      }
      (held ??= []).push(candidate);
    }
    if (held !== null) this.userQueue.unshiftAll(held);
    return undefined;
  }

  /**
   * Remove the newest **droppable** user message, regardless of suspension.
   *
   * The mirror of {@link removeOldest}, and it exists because a bound has two
   * doors, not one.  An arrival enqueued at the tail is made room for by
   * evicting the head; a batch *prepended* at the head is made room for by
   * evicting the tail (#772).  Both are the same rule — the arrival is
   * admitted and a queued message goes, from whichever end is furthest from
   * the arrival — and picking the near end instead would mean a replay
   * destroying the very messages it just put back.
   *
   * Everything {@link removeOldest} documents about suspension and about
   * {@link Envelope.undroppable} applies here unchanged, and for the same
   * reasons: a bound that lapses while the actor is suspended is unbounded
   * exactly when it matters most, and a lifecycle notification the framework
   * cannot send twice is stepped over rather than evicted.  `undefined` means
   * the queue holds nothing that may be dropped, which is how the caller tells
   * a real eviction from a no-op.
   *
   * Cost is one pop on the ordinary path and O(k) when k notifications sit at
   * the back, on the overflow path, which is already the slow one.
   */
  protected removeNewest(): Envelope<T> | undefined {
    // Allocated only once something is actually stepped over, so the common
    // case — an empty `held` — costs no array at all.
    let held: Array<Envelope<T>> | null = null;
    let removed: Envelope<T> | undefined;
    for (;;) {
      const candidate = this.userQueue.pop();
      if (candidate === undefined) break;
      if (candidate.undroppable !== true) {
        removed = candidate;
        break;
      }
      (held ??= []).push(candidate);
    }
    // `held` came off the back newest-first, so putting it back means pushing
    // it in reverse — anything else reorders the notifications among
    // themselves.
    if (held !== null) for (let i = held.length - 1; i >= 0; i--) this.userQueue.push(held[i]!);
    return removed;
  }

  dequeueSystem(): Envelope<unknown> | undefined {
    return this.systemQueue.shift();
  }

  hasMessages(): boolean {
    return this.systemQueue.length > 0 || (!this._suspended && this.userQueue.length > 0);
  }
  hasUserMessages(): boolean { return this.userQueue.length > 0; }
  hasSystemMessages(): boolean { return this.systemQueue.length > 0; }

  /** Number of pending user messages. */
  get size(): number { return this.userQueue.length; }

  suspend(): void { this._suspended = true; }
  resume(): void { this._suspended = false; }

  /**
   * Drain all user messages; returns them so the caller can forward to dead
   * letters.
   *
   * Materialises a fresh array rather than handing out the backing store —
   * a ring is not a dense array, so there is nothing to hand out.  The
   * allocation is real but it is on the termination path, where the caller
   * (`ActorCell`) only iterates the result once.
   */
  drainUser(): Envelope<T>[] {
    return this.userQueue.drain();
  }

  drainSystem(): Envelope<unknown>[] {
    return this.systemQueue.drain();
  }
}
