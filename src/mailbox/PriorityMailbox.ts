import { match } from 'ts-pattern';
import type { Envelope } from '../internal/Mailbox.js';
import { DroppingMailbox, MailboxFullError } from './DroppingMailbox.js';
import {
  PriorityMailboxOptionsValidator,
  type PriorityMailboxOptions,
  type PriorityMailboxOptionsType,
  type PriorityMailboxOverflow,
} from './PriorityMailboxOptions.js';

/**
 * Priority order for user messages.  Lower numeric priority values are
 * dequeued first — `0` is highest priority.  Ties are broken by FIFO
 * insertion order.
 *
 * Runs synchronously inside the **sender's** `tell`, and is not required to
 * be total: a callback that throws, or that answers with something other
 * than a usable number, costs its message the lowest priority and nothing
 * else — see {@link PriorityMailbox.priorityOf} for why that is contained
 * here rather than surfaced at the call site, and
 * `PriorityMailboxOptionsType.onPriorityError` for how to see it happen.
 */
export type PriorityFunction<T> = (message: T) => number;

/**
 * The priority given to a message `priorityFor` could not rank — the lowest
 * priority there is, so an undeterminable priority sorts behind every ranked
 * message rather than ahead of all of them (#733).
 *
 * `Number.MAX_SAFE_INTEGER` rather than `Infinity`, for two reasons.  A
 * caller who returns `Infinity` deliberately means "absolutely last", and
 * that intent stays distinguishable from "we could not tell".  And it stays
 * arithmetic-safe: `Infinity - Infinity` is `NaN`, which is falsy, so the
 * obvious comparator shape `a.priority - b.priority || a.sequence -
 * b.sequence` would silently fall through to the tie-break for a pair of
 * sentinels — including in the array reference model this class is checked
 * against.
 *
 * Module-level rather than in `PriorityMailboxOptions.ts` because it is
 * neither a default of an option nor a bound a validator checks, and not in
 * a `src/mailbox/Constants.ts` because there is no second such value and no
 * second reader — the two things that would make that file exist.
 */
const UNRANKABLE_PRIORITY = Number.MAX_SAFE_INTEGER;

/** One queued message plus the two keys it is ordered by. */
type PriorityEntry<T> = {
  readonly envelope: Envelope<T>;
  readonly priority: number;
  /** Monotonic arrival number — the FIFO tie-breaker among equal priorities. */
  readonly sequence: number;
};

/**
 * User messages are dequeued in priority order (ascending priority value,
 * then FIFO).  System messages still take strict precedence over any user
 * message.  Internally backed by an ordered array — suitable for moderate
 * mailbox sizes; swap for a heap if throughput becomes a concern.
 *
 * ## Bounding one, and what `drop` means here
 *
 * A capacity is optional and unset by default (#647).  When one is set, the
 * overflow policy decides what a full mailbox does — and the interesting
 * policy is `drop-lowest-priority`, which is where this diverges from
 * `BoundedMailbox`.
 *
 * `drop-head` is not offered, deliberately.  On a FIFO queue it means
 * "discard the stalest", which is coherent because arrival order is the only
 * order there is.  Here the head is the message the priority function said
 * matters *most*; discarding it would defeat the entire reason for choosing
 * this mailbox.  The two other readings were considered and rejected:
 * "oldest by arrival" is an O(n) scan on the enqueue path (the array is
 * ordered by priority, not by arrival) and still destroys a message the
 * caller called important, while dropping the head is indefensible.  So the
 * bound sheds along the axis the queue is ordered by — the tail, which is
 * both the least important message and an O(1) `pop`.
 *
 * A shed message is reported as `drop-head` on the metric, because
 * `MailboxDropReason` is a closed two-value set (a metric label, and an open
 * one is a cardinality vector — #745) whose distinction is "a queued message"
 * versus "the arriving one".  When the arriving message is itself the least
 * important, it is the one shed, and then the reason really is `drop-new` —
 * the eviction compares identities rather than guessing.
 *
 * ## When the priority function cannot answer
 *
 * `priorityFor` is user code on the sender's stack, and the framework itself
 * hands it messages no application wrote: `ActorRef.stop()` and
 * `ActorRef.kill()` send `PoisonPill` / `Kill` as **user** messages, and both
 * serialise as `{}`.  So "it threw" and "it returned something that is not a
 * number" are ordinary states rather than programmer error, and both are
 * contained — the message keeps its place in the queue at
 * {@link UNRANKABLE_PRIORITY} (#733).  {@link priorityOf} carries the
 * reasoning.
 */
export class PriorityMailbox<T = unknown> extends DroppingMailbox<T> {
  private readonly priorityFor: PriorityFunction<T>;
  private readonly capacity: number | undefined;
  private readonly overflow: PriorityMailboxOverflow;
  private readonly onPriorityError: ((cause: unknown, message: T) => void) | undefined;
  /** Monotonic counter — tie-breaker preserving FIFO among equal-priority messages. */
  private sequence = 0;
  private readonly ordered: Array<PriorityEntry<T>> = [];

  constructor(options: PriorityMailboxOptions<T>) {
    super();
    const settings = { ...(options as Partial<PriorityMailboxOptionsType<T>>) };
    new PriorityMailboxOptionsValidator<T>().validate(settings);
    this.priorityFor = settings.priorityFor!;
    this.capacity = settings.capacity;
    // `reject` for the same reason `BoundedMailbox` defaults to it: naming a
    // capacity says how much you will hold, not what you are willing to lose.
    this.overflow = settings.overflow ?? 'reject';
    this.onPriorityError = settings.onPriorityError;
    // The caller's hook is just the first observer — see `DroppingMailbox`.
    if (settings.onDrop !== undefined) this.observeDrops(settings.onDrop);
  }

  override enqueue(envelope: Envelope<T>): void {
    // Read into a local so the arrow bodies below narrow it — a `readonly`
    // field does not stay narrowed across a closure.
    const capacity = this.capacity;
    if (capacity !== undefined && this.ordered.length >= capacity) {
      match(this.overflow)
        .with('drop-lowest-priority', () => this.shedLeastImportant(envelope))
        .with('drop-new', () => this.reportDrop('drop-new'))
        .with('reject', () => { throw new MailboxFullError(capacity); })
        .exhaustive();
      return;
    }
    this.insert(envelope);
  }

  /**
   * A death notification is queued whatever the capacity says — see
   * {@link Mailbox.enqueueSignal}.
   *
   * Straight to {@link insert}, past the capacity check.  Overriding here is
   * not optional for this class: its messages live in {@link ordered} rather
   * than in the base user queue, so the inherited default — which delegates to
   * `enqueue` — would hand the notification to the very overflow logic that
   * sheds it (#729).  The notification takes its place in priority order like
   * any other message, which means a `priorityFor` that ranks a `Terminated`
   * last still delivers it last; what it can no longer do is delete it.
   */
  override enqueueSignal(envelope: Envelope<T>): void {
    this.insert(envelope);
  }

  /**
   * Insert the arrival, then evict whatever now sits at the tail.
   *
   * Insert-then-evict rather than evict-then-insert so the arrival competes
   * on the same terms as everything already queued: a message the priority
   * function ranked below the whole backlog is the one that goes, and the
   * identity check then reports it honestly as `drop-new` instead of claiming
   * a queued message was destroyed.  Ties resolve the same way, because the
   * arrival takes the highest sequence number and therefore sorts last among
   * its equals — the older message of an equal-priority pair survives.
   */
  private shedLeastImportant(envelope: Envelope<T>): void {
    this.insert(envelope);
    const shed = this.removeOldest();
    // Undefined only when every entry — the arrival included — is a lifecycle
    // notification that may not be dropped, which `prependUser` can produce by
    // replaying a stashed one (#729).  The guard was already here for the
    // discipline #407 established: count removals, not intentions.
    if (shed !== undefined) this.reportDrop(shed === envelope ? 'drop-new' : 'drop-head');
  }

  /**
   * The number to sort this message by: `priorityFor`'s answer when it gave a
   * usable one, {@link UNRANKABLE_PRIORITY} when it could not (#733).
   *
   * Two failures are contained here rather than surfaced, and the reason is
   * the same for both: this runs synchronously on the **sender's** stack,
   * inside its `tell`, and a sender is a bystander to the receiver's mailbox
   * configuration.  It has nothing to do about a broken `priorityFor` and no
   * way to tell that from a failure of its own.  A throw from here landed in
   * the sender's `onReceive` and got the *sender* restarted — the same shape
   * that ruled `reject` out as the framework's default overflow policy
   * (#919).
   *
   * - **A throw.**  `priorityFor` may see a message it was never written for,
   *   and not because anyone sent one: `ActorRef.stop()` and `.kill()` post
   *   `PoisonPill` / `Kill` as *user* messages, both of which serialise as
   *   `{}`, so a `match(message)…​.exhaustive()` — the shape this project's
   *   own example used — throws on the framework's own shutdown path.
   * - **A value that is not a usable number.**  `undefined`, `NaN` and a
   *   string all compare `false` against every queued priority under both `<`
   *   and `===`, so the search in {@link insert} would drive `low` to `0` and
   *   splice the arrival in at the **head** — the *highest*-priority slot,
   *   inverting the order this class documents.  No cast is needed to get
   *   there: `(message) => Number(message.priority)` is type-correct and
   *   yields `NaN` for an absent field.
   *
   * The message is **kept**, at the lowest priority, rather than dropped: it
   * is the priority that could not be determined, not the message that was
   * unwanted.  The `sequence` tie-break then holds unrankable messages in
   * FIFO order among themselves, which is the other half of the old
   * behaviour — `NaN` broke the tie-break for the same reason it broke the
   * comparison, so two unrankable arrivals came out reversed.
   *
   * `Number.isFinite` would be the wrong predicate: it also rejects
   * `-Infinity`, which the comparison orders correctly and which a caller may
   * well have meant as "ahead of everything".  The `typeof` test is needed
   * either way, because a string return head-inserts exactly like `NaN`.
   */
  private priorityOf(message: T): number {
    let raw: number;
    try {
      raw = this.priorityFor(message);
    } catch (cause) {
      this.onPriorityError?.(cause, message);
      return UNRANKABLE_PRIORITY;
    }
    if (typeof raw === 'number' && !Number.isNaN(raw)) return raw;
    // Describing the value costs an allocation, so it happens only for an
    // observer that will read it.  This is a broken path, but it is still on
    // the enqueue path.
    if (this.onPriorityError !== undefined) {
      const described = typeof raw === 'number' ? 'NaN' : `a value of type ${typeof raw}`;
      this.onPriorityError(new TypeError(`priorityFor returned ${described}, which cannot be ranked`), message);
    }
    return UNRANKABLE_PRIORITY;
  }

  /** Binary-search insertion by (priority, sequence): O(log n) locate + O(n) splice. */
  private insert(envelope: Envelope<T>): void {
    const priority = this.priorityOf(envelope.message);
    const entry: PriorityEntry<T> = { envelope, priority, sequence: this.sequence++ };
    let low = 0, high = this.ordered.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const item = this.ordered[middle]!;
      if (item.priority < priority || (item.priority === priority && item.sequence < entry.sequence)) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    this.ordered.splice(low, 0, entry);
  }

  override dequeueUser(): Envelope<T> | undefined {
    if (this.suspended) return undefined;
    return this.ordered.shift()?.envelope;
  }

  /**
   * Remove the message furthest from delivery, regardless of suspension.
   *
   * The base declares this as "the oldest user message" because on a FIFO
   * queue the two are the same thing.  Here they are not, and the override
   * exists so the seam does not silently break: the base implementation
   * operates on the user queue, which this class does not use, so an
   * un-overridden `removeOldest` would return `undefined` forever and any
   * bound built on it would quietly stop enforcing — exactly #407, one class
   * over.
   *
   * Ignoring suspension is inherited on purpose: making room in a full queue
   * is not delivery, and a bound that lapses while the actor is suspended is
   * unbounded exactly when it matters most.
   *
   * Stepping over an {@link Envelope.undroppable} entry is inherited in intent
   * but not in code — the base scans the user queue this class does not use, so
   * the skip has to be written again here or a lifecycle notification that
   * ranked low would be shed like anything else (#729).  Undefined means
   * nothing queued may be dropped.
   */
  protected override removeOldest(): Envelope<T> | undefined {
    // From the tail, because that is the least important end; the first entry
    // that may be dropped is the one to drop.
    for (let index = this.ordered.length - 1; index >= 0; index--) {
      if (this.ordered[index]!.envelope.undroppable !== true) {
        return this.ordered.splice(index, 1)[0]!.envelope;
      }
    }
    return undefined;
  }

  override get size(): number { return this.ordered.length; }

  override hasUserMessages(): boolean { return this.ordered.length > 0; }

  override drainUser(): Envelope<T>[] {
    const drained = this.ordered.map((entry) => entry.envelope);
    this.ordered.length = 0;
    return drained;
  }

  /**
   * Reinsert via `enqueue` — priority is re-computed, which is the correct
   * behaviour (unstashed messages rejoin their priority tier).
   *
   * Going back through `enqueue` also means the capacity applies to the
   * unstash path.  Since #772 `BoundedMailbox` bounds its replay too, by the
   * route its own geometry calls for — it sheds at the tail to make room at
   * the head, where this class has only one shedding axis and re-ranking is
   * the answer to both questions at once.  The consequence is the same on
   * either mailbox and is worth knowing: on a bounded one, `unstashAll()` can
   * drop messages, or throw under `reject`.
   */
  override prependUser(envelopes: Array<Envelope<T>>): void {
    for (const envelope of envelopes) this.enqueue(envelope);
  }

  /**
   * The same entry {@link removeOldest} answers with, deliberately.
   *
   * The base distinguishes the two ends because a FIFO queue has two; this
   * one is ordered by priority, and there is exactly one end it may shed from
   * — the least important, which is what `drop-head` is not offered here for.
   * Answering "the newest" with anything else would mean the class had two
   * shedding axes, and the one it does not have is arrival order.
   *
   * Overridden rather than inherited for the reason {@link removeOldest}
   * gives: the base scans the user queue this class does not use, so an
   * inherited version would return `undefined` forever and any bound built on
   * it would quietly stop enforcing — #407, one class over.  Nothing here
   * calls it today, and that is exactly when a silent no-op gets written.
   */
  protected override removeNewest(): Envelope<T> | undefined {
    return this.removeOldest();
  }

  override hasMessages(): boolean {
    return this.hasSystemMessages() || (!this.suspended && this.ordered.length > 0);
  }
}
