import { match } from 'ts-pattern';
import { Mailbox, type Envelope } from '../internal/Mailbox.js';
import { BoundedMailboxOptionsValidator, type BoundedMailboxOptions, type BoundedMailboxOptionsType } from './BoundedMailboxOptions.js';

export type BoundedMailboxOverflow =
  /** Drop the oldest message in the queue to make room for the new one. */
  | 'drop-head'
  /** Drop the message being enqueued. */
  | 'drop-new'
  /** Throw a MailboxFullError — caller can surface it. */
  | 'reject';

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
export class BoundedMailbox<T = unknown> extends Mailbox<T> {
  private readonly capacity: number;
  private readonly overflow: BoundedMailboxOverflow;
  private readonly onDrop?: (reason: 'drop-head' | 'drop-new') => void;
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

  override enqueue(env: Envelope<T>): void {
    if (this.size >= this.capacity) {
      match(this.overflow)
        .with('drop-head', () => {
          super.dequeueUser();
          this.droppedCount++;
          this.onDrop?.('drop-head');
          super.enqueue(env);
        })
        .with('drop-new', () => {
          this.droppedCount++;
          this.onDrop?.('drop-new');
        })
        .with('reject', () => { throw new MailboxFullError(this.capacity); })
        .exhaustive();
      return;
    }
    super.enqueue(env);
  }
}
