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
 */
export type PriorityFunction<T> = (message: T) => number;

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
 */
export class PriorityMailbox<T = unknown> extends DroppingMailbox<T> {
  private readonly priorityFor: PriorityFunction<T>;
  private readonly capacity: number | undefined;
  private readonly overflow: PriorityMailboxOverflow;
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

  /** Binary-search insertion by (priority, sequence): O(log n) locate + O(n) splice. */
  private insert(envelope: Envelope<T>): void {
    const priority = this.priorityFor(envelope.message);
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
   * unstash path, unlike `BoundedMailbox`, where `prependUser` bypasses the
   * bound (#772).  The consequence is worth knowing: on a bounded priority
   * mailbox, `unstashAll()` can drop messages.
   */
  override prependUser(envelopes: Array<Envelope<T>>): void {
    for (const envelope of envelopes) this.enqueue(envelope);
  }

  override hasMessages(): boolean {
    return this.hasSystemMessages() || (!this.suspended && this.ordered.length > 0);
  }
}
