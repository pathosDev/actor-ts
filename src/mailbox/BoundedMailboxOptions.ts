import type { MailboxDropObserver } from '../internal/Mailbox.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

export type BoundedMailboxOverflow =
  /** Drop the oldest message in the queue to make room for the new one. */
  | 'drop-head'
  /** Drop the message being enqueued. */
  | 'drop-new'
  /** Throw a MailboxFullError — caller can surface it. */
  | 'reject';

/** Plain options-object shape accepted by a {@link BoundedMailbox}. */
export type BoundedMailboxOptionsType = {
  readonly capacity: number;
  readonly overflow?: BoundedMailboxOverflow;
  /**
   * Optional hook fired each time a message is dropped by the overflow
   * policy.  Receives the policy that triggered the drop so the consumer
   * can label metrics, and the envelope that was discarded (#773) — which
   * under `drop-head` is the message evicted to make room, not the arrival.
   *
   * Yours alone: the cell reports to `actor_mailbox_dropped_total` through
   * {@link DropReportingMailbox.observeDrops}, which runs alongside this
   * rather than replacing it.
   *
   * Runs on the **sender's** stack, with nothing between it and the `tell` —
   * so record and return.  A hook that throws puts the throw into a sender
   * that has no idea the receiver was bounded.
   */
  readonly onDrop?: MailboxDropObserver;
  /**
   * Route every dropped envelope to `system.deadLetters`, so an overflow
   * leaves a forensic record and not only a counter (#773).  Default `false`.
   *
   * Opt-in rather than always-on because the cost lands in the worst
   * possible place: the drop happens on the sender's stack, and
   * `DeadLetterRef.tell` runs the durable capture sink and then publishes
   * synchronously to every event-stream subscriber.  A bound exists to
   * absorb a burst cheaply; turning each shed message into a fan-out
   * undoes that.  Turn it on for the actors whose losses you would have to
   * explain afterwards — a command stream, a delivery confirmation — and
   * leave it off for the telemetry firehose the bound was drawn for.
   *
   * What the dead letter carries is what every other loss path in the
   * framework carries: the message, its sender, and this actor as the
   * recipient.  See {@link DropReportingMailbox.deadLetterDrops}.
   */
  readonly deadLetterDrops?: boolean;
};

/**
 * Fluent builder for {@link BoundedMailboxOptionsType}:
 *
 *     new BoundedMailbox(BoundedMailboxOptions.create()
 *       .withCapacity(1000)
 *       .withOverflow('drop-head'));
 */
export class BoundedMailboxOptionsBuilder extends OptionsBuilder<BoundedMailboxOptionsType> {
  /** Start a fresh builder. */
  static create(): BoundedMailboxOptionsBuilder {
    return new BoundedMailboxOptionsBuilder();
  }

  /** Maximum queued user messages.  Must be >= 1. */
  withCapacity(capacity: number): this {
    return this.set('capacity', capacity);
  }

  /** What to do when a message arrives on a full mailbox.  Default `reject`. */
  withOverflow(overflow: BoundedMailboxOverflow): this {
    return this.set('overflow', overflow);
  }

  /** Hook fired on each overflow drop, with the envelope it discarded. */
  withOnDrop(onDrop: MailboxDropObserver): this {
    return this.set('onDrop', onDrop);
  }

  /** Dead-letter each dropped envelope instead of only counting it.  Default `false`. */
  withDeadLetterDrops(deadLetterDrops: boolean): this {
    return this.set('deadLetterDrops', deadLetterDrops);
  }
}

/**
 * Validates resolved {@link BoundedMailboxOptionsType} settings.  `capacity`
 * is required at runtime too — without it the "bounded" mailbox would
 * silently be unbounded.
 */
export class BoundedMailboxOptionsValidator extends OptionsValidator<BoundedMailboxOptionsType> {
  constructor() {
    super('BoundedMailboxOptions');
  }
  protected rules(s: Partial<BoundedMailboxOptionsType>): void {
    if (s.capacity === undefined) this.fail('capacity', 'is required');
    this.positiveInt('capacity');
    this.oneOf('overflow', ['drop-head', 'drop-new', 'reject']);
  }
}

/**
 * Accepted input for a {@link BoundedMailbox}: the fluent
 * {@link BoundedMailboxOptionsBuilder} OR a plain
 * {@link BoundedMailboxOptionsType} object.
 */
export type BoundedMailboxOptions = BoundedMailboxOptionsBuilder | Partial<BoundedMailboxOptionsType>;
/** Value alias so `BoundedMailboxOptions.create()` / `new BoundedMailboxOptions()` resolve to the builder. */
export const BoundedMailboxOptions = BoundedMailboxOptionsBuilder;
