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
          //
          // Since #729 it also returns undefined when everything queued is a
          // lifecycle notification that may not be dropped.  The arrival is
          // still admitted: the bound is a memory ceiling, and overshooting it
          // by the size of a watch set is a smaller price than blinding the
          // watcher.  Nothing is reported, because nothing was discarded.
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

  /**
   * A death notification is queued whatever the bound says — see
   * {@link Mailbox.enqueueSignal}.
   *
   * Straight to the base queue, past the capacity check, and that is the whole
   * override: every one of the three policies destroyed the notification
   * otherwise, each in its own way (#729).  `drop-head` evicted whatever sat
   * at the front, `drop-new` discarded the notification on arrival — the more
   * likely of the two, since a `Terminated` arrives *late* relative to the
   * flood that filled the queue — and `reject` was worse than either: it threw
   * `MailboxFullError` synchronously on the **sender's** stack, and the sender
   * is the dying cell's own watcher-notify loop.  That throw escaped
   * `finalizeTermination` mid-loop, so the remaining watchers went unnotified,
   * the parent was never told the child had stopped, and `terminate()` never
   * settled.  `reject` is also this class's constructor default, so the
   * documented `withMailbox(() => new BoundedMailbox({ capacity: n }))` shape
   * reached it without naming it.
   */
  override enqueueSignal(env: Envelope<T>): void {
    super.enqueue(env);
  }
}
