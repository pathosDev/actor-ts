import type { MailboxDropReason } from '../internal/Mailbox.js';
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
   * label metrics.  Never fires for `reject` — that throws instead.
   *
   * Yours alone: the cell reports to `actor_mailbox_dropped_total` through
   * `DropReportingMailbox.observeDrops`, which runs alongside this rather
   * than replacing it.
   */
  readonly onDrop?: (reason: MailboxDropReason) => void;
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

  /** Hook fired on each overflow drop (for metrics). */
  withOnDrop(onDrop: (reason: MailboxDropReason) => void): this {
    return this.set('onDrop', onDrop);
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
