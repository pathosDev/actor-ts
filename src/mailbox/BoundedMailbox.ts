import { match } from 'ts-pattern';
import { Mailbox, type Envelope } from '../internal/Mailbox.js';
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
          // `removeOldest` rather than `dequeueUser`: the latter returns
          // undefined while the mailbox is suspended, which used to make this
          // whole arm a no-op — the queue grew past capacity and the drop was
          // reported anyway.  Counting is gated on an actual removal so the
          // metric cannot claim a drop that did not happen.
          const dropped = super.removeOldest();
          if (dropped !== undefined) {
            this.droppedCount++;
            this.onDrop?.('drop-head');
          }
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
