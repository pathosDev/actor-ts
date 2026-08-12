import { match } from 'ts-pattern';
import {
  Mailbox,
  type DropReportingMailbox,
  type Envelope,
  type MailboxDropReason,
} from '../internal/Mailbox.js';
import { BoundedMailboxOptionsValidator, type BoundedMailboxOptions, type BoundedMailboxOptionsType, type BoundedMailboxOverflow } from './BoundedMailboxOptions.js';

export class MailboxFullError extends Error {
  constructor(capacity: number) {
    super(`bounded mailbox full (capacity=${capacity})`);
    this.name = 'MailboxFullError';
  }
}

/**
 * Mailbox with a fixed upper bound on queued user messages.  Policy for
 * what happens when a message arrives on a full mailbox is configurable.
 */
export class BoundedMailbox<T = unknown> extends Mailbox<T> implements DropReportingMailbox {
  private readonly capacity: number;
  private readonly overflow: BoundedMailboxOverflow;
  private readonly onDrop?: (reason: MailboxDropReason) => void;
  /**
   * Framework-side drop observers — see {@link observeDrops}.  A list rather
   * than one slot so registering is additive: the cell registers one, and a
   * mailbox instance shared between two cells (a documented mistake, but a
   * possible one) reports to both instead of the second silently unhooking
   * the first.
   */
  private readonly dropObservers: Array<(reason: MailboxDropReason) => void> = [];
  /** Number of messages dropped by the overflow policy — useful for metrics. */
  droppedCount = 0;

  constructor(options: BoundedMailboxOptions) {
    super();
    const settings = { ...(options as Partial<BoundedMailboxOptionsType>) };
    new BoundedMailboxOptionsValidator().validate(settings);
    this.capacity = settings.capacity!;
    this.overflow = settings.overflow ?? 'reject';
    this.onDrop = settings.onDrop;
  }

  /** See {@link DropReportingMailbox.observeDrops} — additive. */
  observeDrops(observer: (reason: MailboxDropReason) => void): void {
    this.dropObservers.push(observer);
  }

  /**
   * One place that owns "a message was discarded": the counter, the caller's
   * hook, and the framework's observers, in that order.  Before #1149 the
   * counter and the hook were incremented inline in each `match` arm, which
   * is how the observer came to be missing from the `withMailbox` path — the
   * wiring lived at the construction site rather than at the drop.
   */
  private reportDrop(reason: MailboxDropReason): void {
    this.droppedCount++;
    this.onDrop?.(reason);
    for (const observer of this.dropObservers) observer(reason);
  }

  override enqueue(env: Envelope<T>): void {
    if (this.size >= this.capacity) {
      match(this.overflow)
        .with('drop-head', () => {
          // `removeOldest` rather than `dequeueUser`: the latter returns
          // undefined while the mailbox is suspended, which used to make this
          // whole arm a no-op — the queue grew past capacity and the drop was
          // reported anyway.  Counting is gated on an actual removal so the
          // metric cannot claim a drop that did not happen.
          const dropped = super.removeOldest();
          if (dropped !== undefined) this.reportDrop('drop-head');
          super.enqueue(env);
        })
        .with('drop-new', () => this.reportDrop('drop-new'))
        .with('reject', () => { throw new MailboxFullError(this.capacity); })
        .exhaustive();
      return;
    }
    super.enqueue(env);
  }
}
