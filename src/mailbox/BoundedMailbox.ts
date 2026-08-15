import { match } from 'ts-pattern';
import type { Envelope } from '../internal/Mailbox.js';
import { DroppingMailbox, MailboxFullError } from './DroppingMailbox.js';
import { BoundedMailboxOptionsValidator, type BoundedMailboxOptions, type BoundedMailboxOptionsType, type BoundedMailboxOverflow } from './BoundedMailboxOptions.js';

// Re-exported from its historical home so `import { MailboxFullError } from
// './BoundedMailbox.js'` keeps resolving — the class moved to
// `DroppingMailbox.ts` when `PriorityMailbox` became the second mailbox that
// can raise it (#647).
export { MailboxFullError } from './DroppingMailbox.js';

/**
 * Mailbox with a fixed upper bound on queued user messages.  Policy for
 * what happens when a message arrives on a full mailbox is configurable.
 */
export class BoundedMailbox<T = unknown> extends DroppingMailbox<T> {
  private readonly capacity: number;
  private readonly overflow: BoundedMailboxOverflow;

  constructor(options: BoundedMailboxOptions) {
    super();
    const settings = { ...(options as Partial<BoundedMailboxOptionsType>) };
    new BoundedMailboxOptionsValidator().validate(settings);
    this.capacity = settings.capacity!;
    this.overflow = settings.overflow ?? 'reject';
    // The caller's hook is just the first observer — see `DroppingMailbox`.
    if (settings.onDrop !== undefined) this.observeDrops(settings.onDrop);
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
