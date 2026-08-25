import type { MailboxDropObserver } from '../internal/Mailbox.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { PriorityFunction } from './PriorityMailbox.js';

/**
 * What a {@link PriorityMailbox} does when a message arrives on a full one.
 *
 * A deliberate near-miss of {@link BoundedMailboxOverflow} rather than a reuse
 * of it, and the difference is the first member.  On a FIFO queue `drop-head`
 * means "discard the stalest", which is coherent because arrival order is the
 * only order there is.  A priority queue's head is the message the priority
 * function said matters *most* — discarding it would defeat the reason the
 * mailbox was chosen — so the word cannot be carried over with its meaning
 * intact, and carrying it over with a different meaning is worse than a
 * second name.
 *
 * The two policies that mean the same thing on both queues keep their names.
 */
export type PriorityMailboxOverflow =
  /**
   * Discard the message furthest from delivery — the lowest-priority one,
   * and among equals the one that arrived last.  O(1): it is already at the
   * end of the ordered array.
   */
  | 'drop-lowest-priority'
  /** Discard the message being enqueued, whatever priority it was given. */
  | 'drop-new'
  /** Throw `MailboxFullError` at the `tell` site — caller surfaces it. */
  | 'reject';

/** Plain options-object shape accepted by a {@link PriorityMailbox}. */
export type PriorityMailboxOptionsType<T> = {
  readonly priorityFor: PriorityFunction<T>;
  /**
   * Maximum queued user messages.  Unset means unbounded, which is what a
   * priority mailbox was until #647 and is still the default — the framework
   * does not decide on its own that messages may be destroyed.
   *
   * It lives here rather than on `ActorOptions` because
   * `ActorOptionsValidator` rejects `withMailbox` combined with
   * `withMailboxCapacity`: a supplied mailbox brings its own bound, so this
   * is the only door onto one.
   */
  readonly capacity?: number;
  /**
   * What a full mailbox does with the next arrival.  Only meaningful together
   * with {@link capacity}, and rejected without it.  Default `reject`.
   */
  readonly overflow?: PriorityMailboxOverflow;
  /**
   * Optional hook fired each time a message is dropped by the overflow
   * policy.  Receives the policy that triggered the drop so the consumer can
   * label metrics, and the envelope that was discarded (#773) — under
   * `drop-lowest-priority` that is whichever end lost, which is the arrival
   * exactly when the arrival ranked below the whole backlog.
   *
   * Yours alone: the cell reports to `actor_mailbox_dropped_total` through
   * `DropReportingMailbox.observeDrops`, which runs alongside this rather
   * than replacing it.
   */
  readonly onDrop?: MailboxDropObserver<T>;
  /**
   * Route every dropped envelope to `system.deadLetters` rather than only
   * counting it (#773).  Default `false`.
   *
   * Opt-in for the reason `BoundedMailboxOptionsType.deadLetterDrops` gives
   * — the drop runs on the sender's stack and a dead letter is a durable
   * capture plus a synchronous publish — and worth the cost more often here
   * than there: a message shed by *this* mailbox is one the priority
   * function ranked last, which is a claim about importance that only the
   * payload can confirm or refute.
   */
  readonly deadLetterDrops?: boolean;
  /**
   * Optional hook fired each time {@link priorityFor} fails to rank a
   * message — it threw, or it answered with something that is not a usable
   * number — and the message was therefore queued at the lowest priority
   * instead (#733).
   *
   * Worth wiring, because the alternative to the containment is not a
   * clearer failure but a *worse* one: before #733 a throw escaped into the
   * stack of whichever actor called `tell`, and restarted it.  Contained,
   * the message still arrives — just last — so nothing else in the system
   * says that a `priorityFor` is broken.  This hook is what says it.
   *
   * `cause` is what `priorityFor` threw, or a `TypeError` describing the
   * value it returned.  `message` is the message it could not rank, which is
   * usually the interesting half: the framework hands `priorityFor`
   * `PoisonPill` and `Kill` as ordinary user messages, so a callback written
   * only for application traffic sees them here first.
   *
   * **Record and return.**  An observer that throws puts the escape back —
   * this runs on the sender's stack too — and costs the message its place in
   * the queue, which is exactly what the containment was for.  Same contract
   * as {@link onDrop}, which is also called with nothing between it and the
   * sender.
   */
  readonly onPriorityError?: (cause: unknown, message: T) => void;
};

/**
 * Fluent builder for {@link PriorityMailboxOptionsType}:
 *
 *     const triageOptions = PriorityMailboxOptions.create<Command>()
 *       .withPriorityFor((m) => m.urgent ? 0 : 10)
 *       .withCapacity(10_000)
 *       .withOverflow('drop-lowest-priority');
 *     new PriorityMailbox(triageOptions);
 */
export class PriorityMailboxOptionsBuilder<T> extends OptionsBuilder<PriorityMailboxOptionsType<T>> {
  /** Start a fresh builder.  Equivalent to `new PriorityMailboxOptionsBuilder<T>()`. */
  static create<T>(): PriorityMailboxOptionsBuilder<T> {
    return new PriorityMailboxOptionsBuilder<T>();
  }

  /** Priority function: lower numbers are dequeued first (0 = highest).  Required. */
  withPriorityFor(priorityFor: PriorityFunction<T>): this {
    return this.set('priorityFor', priorityFor);
  }

  /** Maximum queued user messages.  Must be >= 1.  Unset means unbounded. */
  withCapacity(capacity: number): this {
    return this.set('capacity', capacity);
  }

  /** What to do when a message arrives on a full mailbox.  Default `reject`. */
  withOverflow(overflow: PriorityMailboxOverflow): this {
    return this.set('overflow', overflow);
  }

  /** Hook fired on each overflow drop, with the envelope it discarded. */
  withOnDrop(onDrop: MailboxDropObserver<T>): this {
    return this.set('onDrop', onDrop);
  }

  /** Dead-letter each dropped envelope instead of only counting it.  Default `false`. */
  withDeadLetterDrops(deadLetterDrops: boolean): this {
    return this.set('deadLetterDrops', deadLetterDrops);
  }

  /** Hook fired when `priorityFor` could not rank a message (for diagnostics). */
  withOnPriorityError(onPriorityError: (cause: unknown, message: T) => void): this {
    return this.set('onPriorityError', onPriorityError);
  }
}

/**
 * Validates resolved {@link PriorityMailboxOptionsType} settings.
 *
 * `priorityFor` gets a required-and-callable check because the accepted input
 * union includes `Partial<…>` — `new PriorityMailbox({})` type-checks, and
 * before #647 it failed as `this.priorityFor is not a function` on the first
 * enqueue, which is inside the sender's `tell` and a long way from the
 * mistake.  There is no `function` helper on `OptionsValidator` (nothing else
 * in the project needs one), so this is a bespoke `fail` rule.
 *
 * `overflow` without `capacity` is rejected rather than ignored, for the same
 * reason `ActorOptions` rejects the pair: an unbounded mailbox never
 * overflows, so a policy on its own is a no-op that reads like configuration.
 */
export class PriorityMailboxOptionsValidator<T> extends OptionsValidator<PriorityMailboxOptionsType<T>> {
  constructor() {
    super('PriorityMailboxOptions');
  }
  protected rules(s: Partial<PriorityMailboxOptionsType<T>>): void {
    if (s.priorityFor === undefined) this.fail('priorityFor', 'is required');
    if (typeof s.priorityFor !== 'function') this.fail('priorityFor', 'must be a function', s.priorityFor);
    this.positiveInt('capacity');
    this.oneOf('overflow', ['drop-lowest-priority', 'drop-new', 'reject']);
    if (s.overflow !== undefined && s.capacity === undefined) {
      this.fail('overflow', 'requires a capacity — an unbounded mailbox never overflows');
    }
    // Same reasoning one rule up: nothing is ever dropped without a bound, so
    // asking for the drops to be dead-lettered is a no-op that reads like a
    // guarantee — and this one would read like the *strongest* guarantee in
    // the file.
    if (s.deadLetterDrops !== undefined && s.capacity === undefined) {
      this.fail('deadLetterDrops', 'requires a capacity — an unbounded mailbox never drops');
    }
  }
}

/**
 * Accepted input for a {@link PriorityMailbox}: the fluent
 * {@link PriorityMailboxOptionsBuilder} OR a plain
 * {@link PriorityMailboxOptionsType} object.
 */
export type PriorityMailboxOptions<T> =
  | PriorityMailboxOptionsBuilder<T>
  | Partial<PriorityMailboxOptionsType<T>>;
/** Value alias so `PriorityMailboxOptions.create()` / `new PriorityMailboxOptions()` resolve to the builder. */
export const PriorityMailboxOptions = PriorityMailboxOptionsBuilder;
