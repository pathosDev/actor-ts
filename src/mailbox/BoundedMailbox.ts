import { match } from 'ts-pattern';
import { Mailbox, type Envelope } from '../internal/Mailbox.js';

export type BoundedMailboxOverflow =
  /** Drop the oldest message in the queue to make room for the new one. */
  | 'drop-head'
  /** Drop the message being enqueued. */
  | 'drop-new'
  /** Throw a MailboxFullError — caller can surface it. */
  | 'reject';

export interface BoundedMailboxSettings {
  readonly capacity: number;
  readonly overflow?: BoundedMailboxOverflow;
}

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
  /** Number of messages dropped by the overflow policy — useful for metrics. */
  droppedCount = 0;

  constructor(settings: BoundedMailboxSettings) {
    super();
    if (settings.capacity < 1) throw new Error('BoundedMailbox: capacity must be >= 1');
    this.capacity = settings.capacity;
    this.overflow = settings.overflow ?? 'reject';
  }

  override enqueue(env: Envelope<T>): void {
    if (this.size >= this.capacity) {
      match(this.overflow)
        .with('drop-head', () => {
          super.dequeueUser();
          this.droppedCount++;
          super.enqueue(env);
        })
        .with('drop-new', () => { this.droppedCount++; })
        .with('reject', () => { throw new MailboxFullError(this.capacity); })
        .exhaustive();
      return;
    }
    super.enqueue(env);
  }
}
