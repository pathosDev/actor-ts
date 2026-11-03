import type { MailboxDropObserver } from '../internal/Mailbox.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { BoundedMailboxOverflow } from './BoundedMailboxOptions.js';

/** Plain options-object shape accepted by a {@link ControlAwareMailbox}. */
export type ControlAwareMailboxOptionsType<T> = {
  /**
   * Which messages are control messages — dequeued before every ordinary
   * message, and never shed by the bound.
   *
   * Only an answer of exactly `true` makes a message control.  A throw, or
   * any other answer, classes it ordinary, which is where it would have been
   * on any other mailbox: the predicate runs synchronously inside the
   * **sender's** `tell`, and a sender is a bystander to the receiver's mailbox
   * configuration.  `PoisonPill` and `Kill` reach the predicate too —
   * `ActorRef.stop()` and `.kill()` post them as user messages, and neither
   * has a field to match on — so a predicate written for the actor's own
   * protocol meets them on the framework's own shutdown path.  A throw is
   * reported all the same: see {@link onControlError}.
   *
   * Keep it to a check of the message's shape.  A message that is control
   * overtakes everything ordinary already queued, its own sender's earlier
   * messages included, so a `Terminated` this predicate answers `true` for
   * arrives ahead of the work that preceded the death.
   */
  readonly isControl: (message: T) => boolean;
  /**
   * Maximum queued **ordinary** messages.  Unset means unbounded, which is the
   * default: a mailbox chosen so that some messages may overtake others has
   * not thereby decided that any may be lost.
   *
   * Control messages are not counted and never shed.  Under a flood the
   * ordinary class is what the bound protects memory from; a control message
   * is the one the flood was delaying, so shedding it would turn the reason
   * the mailbox was chosen into its loss.
   *
   * It lives here rather than on `ActorOptions` because
   * `ActorOptionsValidator` rejects `withMailbox` combined with
   * `withMailboxCapacity`: a supplied mailbox brings its own bound.
   */
  readonly capacity?: number;
  /**
   * What a full ordinary class does with the next ordinary arrival — the
   * three `BoundedMailbox` policies, which mean the same thing here because
   * the ordinary class is a FIFO queue just like that one.  Only meaningful
   * together with {@link capacity}, and rejected without it.  Default
   * `reject`, as on every mailbox you construct yourself: naming a capacity
   * says how much you will hold, not what you are willing to lose.
   */
  readonly overflow?: BoundedMailboxOverflow;
  /**
   * Optional hook fired each time a message is dropped by the overflow
   * policy, with the policy that fired and the envelope that was discarded
   * (#773) — under `drop-head` the ordinary message evicted to make room, not
   * the arrival.  Never fired for a control message, which is never dropped.
   *
   * Yours alone: the cell reports to `actor_mailbox_dropped_total` through
   * `DropReportingMailbox.observeDrops`, which runs alongside this rather
   * than replacing it.  Runs on the sender's stack — record and return.
   */
  readonly onDrop?: MailboxDropObserver<T>;
  /**
   * Route every dropped envelope to `system.deadLetters` rather than only
   * counting it (#773).  Default `false`, for the reason
   * `BoundedMailboxOptionsType.deadLetterDrops` gives: the drop runs on the
   * sender's stack, and a dead letter is a durable capture plus a synchronous
   * publish.
   */
  readonly deadLetterDrops?: boolean;
  /**
   * Optional hook fired each time {@link isControl} throws, after the message
   * has been classed ordinary for it (#1431) — this mailbox's counterpart of
   * `PriorityMailboxOptionsType.onPriorityError` (#733).
   *
   * Worth wiring, because the containment makes the failure quiet: a predicate
   * that throws on every message — a method handed over without its `this` is
   * the usual one — turns this mailbox into a plain FIFO queue, and every
   * message still arrives.  `cause` is what the predicate threw; `message` is
   * the message it threw on, often `PoisonPill` or `Kill`, which `stop()` and
   * `kill()` post as ordinary user messages.
   *
   * Unset, the mailbox logs the first throw, at warn, and none after it: the
   * predicate runs on every enqueue, and a line per message is a log nobody
   * can read.  The line names the error's class and the message's class, never
   * the error's text or the message itself — an exhaustive matcher's error
   * quotes the value it could not match, and a message is application data.
   * It goes to the console, because a mailbox does not know which actor owns
   * it; this hook is how to send it anywhere else.  A hook that is given
   * replaces that line.
   *
   * **Record and return.**  It runs on the sender's stack, and one that throws
   * puts back the escape the containment exists to prevent — the contract
   * {@link onDrop} has too.  An answer that is not `true` is not a failure and
   * does not reach it: it classes the message ordinary, as documented.
   */
  readonly onControlError?: (cause: unknown, message: T) => void;
};

/**
 * Fluent builder for {@link ControlAwareMailboxOptionsType}:
 *
 *     const hubMailboxOptions = ControlAwareMailboxOptions.create<HubMessage>()
 *       .withIsControl((message) => message.kind === 'admin')
 *       .withCapacity(10_000)
 *       .withOverflow('drop-head');
 *     new ControlAwareMailbox(hubMailboxOptions);
 */
export class ControlAwareMailboxOptionsBuilder<T> extends OptionsBuilder<ControlAwareMailboxOptionsType<T>> {
  /** Start a fresh builder.  Equivalent to `new ControlAwareMailboxOptionsBuilder<T>()`. */
  static create<T>(): ControlAwareMailboxOptionsBuilder<T> {
    return new ControlAwareMailboxOptionsBuilder<T>();
  }

  /** Which messages overtake the ordinary ones — only an answer of `true` counts.  Required. */
  withIsControl(isControl: (message: T) => boolean): this {
    return this.set('isControl', isControl);
  }

  /** Maximum queued ordinary messages.  Must be >= 1.  Unset means unbounded. */
  withCapacity(capacity: number): this {
    return this.set('capacity', capacity);
  }

  /** What to do when an ordinary message arrives on a full mailbox.  Default `reject`. */
  withOverflow(overflow: BoundedMailboxOverflow): this {
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

  /** Hook fired each time `isControl` throws (for diagnostics).  Unset, the first throw is logged once. */
  withOnControlError(onControlError: (cause: unknown, message: T) => void): this {
    return this.set('onControlError', onControlError);
  }
}

/**
 * Validates resolved {@link ControlAwareMailboxOptionsType} settings.
 *
 * `isControl` gets a required-and-callable check for the reason
 * `PriorityMailboxOptionsValidator` gives `priorityFor` one: the accepted input
 * union includes `Partial<…>`, so `new ControlAwareMailbox({})` type-checks,
 * and without the check it would fail on the first enqueue — inside a
 * sender's `tell`, where the containment would then class every message
 * ordinary and the mistake would surface as a mailbox that never lets
 * anything overtake.
 *
 * `overflow` and `deadLetterDrops` without `capacity` are rejected rather than
 * ignored: an unbounded mailbox never overflows and never drops, so either
 * one on its own is a no-op that reads like configuration.
 */
export class ControlAwareMailboxOptionsValidator<T> extends OptionsValidator<ControlAwareMailboxOptionsType<T>> {
  constructor() {
    super('ControlAwareMailboxOptions');
  }
  protected rules(s: Partial<ControlAwareMailboxOptionsType<T>>): void {
    if (s.isControl === undefined) this.fail('isControl', 'is required');
    if (typeof s.isControl !== 'function') this.fail('isControl', 'must be a function', s.isControl);
    this.positiveInt('capacity');
    this.oneOf('overflow', ['drop-head', 'drop-new', 'reject']);
    if (s.overflow !== undefined && s.capacity === undefined) {
      this.fail('overflow', 'requires a capacity — an unbounded mailbox never overflows');
    }
    if (s.deadLetterDrops !== undefined && s.capacity === undefined) {
      this.fail('deadLetterDrops', 'requires a capacity — an unbounded mailbox never drops');
    }
  }
}

/**
 * Accepted input for a {@link ControlAwareMailbox}: the fluent
 * {@link ControlAwareMailboxOptionsBuilder} OR a plain
 * {@link ControlAwareMailboxOptionsType} object.
 */
export type ControlAwareMailboxOptions<T> =
  | ControlAwareMailboxOptionsBuilder<T>
  | Partial<ControlAwareMailboxOptionsType<T>>;
/** Value alias so `ControlAwareMailboxOptions.create()` / `new ControlAwareMailboxOptions()` resolve to the builder. */
export const ControlAwareMailboxOptions = ControlAwareMailboxOptionsBuilder;
