import { Mailbox, type DropReportingMailbox, type MailboxDropReason } from '../internal/Mailbox.js';

/**
 * A message arrived on a full mailbox whose overflow policy is `reject`.
 *
 * Thrown at the **`tell` call site**, not inside the actor whose mailbox is
 * full — that is the whole point of choosing `reject` over a drop: the sender
 * learns it has to back off.
 *
 * Lives beside {@link DroppingMailbox} rather than in `BoundedMailbox.ts`
 * because both built-in bounds raise it, and a shared error that is defined
 * inside one of its two raisers reads as if the other borrowed it.  The name
 * is re-exported from `BoundedMailbox.ts` and from both barrels, so it is
 * still imported exactly where it always was.
 */
export class MailboxFullError extends Error {
  constructor(capacity: number) {
    super(`bounded mailbox full (capacity=${capacity})`);
    this.name = 'MailboxFullError';
  }
}

/**
 * Base for a mailbox that discards messages and accounts for it.
 *
 * The bookkeeping — the counter, the caller's hook, the framework's observers
 * — is identical for every bound and got written once, inside `BoundedMailbox`
 * (#1149).  `PriorityMailbox` grew a capacity of its own in #647 and cannot
 * reuse `BoundedMailbox`: it keeps its messages in a priority-ordered array
 * rather than in the base user queue, so it shares the *accounting* but not
 * the *queue*.  Duplicating the accounting is how the second copy comes to
 * lack the observer the first one has, which is the exact shape of #1149.
 *
 * Subclasses call {@link reportDrop} once per message actually discarded —
 * "actually" being load-bearing, since #407 was a counter that ran on a
 * removal that had not happened.
 *
 * A caller-supplied `onDrop` is registered as the first observer rather than
 * held in a separate slot, so ordering is fixed and obvious: the counter
 * first, then the hook the caller wired at construction, then whatever the
 * framework registered afterwards.
 *
 * Implementing {@link DropReportingMailbox} here is what puts a subclass into
 * `actor_mailbox_dropped_total`: the cell probes structurally for
 * `observeDrops`, so it never needs to know which mailbox it was handed.
 */
export abstract class DroppingMailbox<T = unknown> extends Mailbox<T> implements DropReportingMailbox {
  /**
   * Drop observers, in registration order.  A list rather than one slot so
   * registering is additive: the cell registers one, and a mailbox instance
   * shared between two cells (a documented mistake, but a possible one)
   * reports to both instead of the second silently unhooking the first.
   */
  private readonly dropObservers: Array<(reason: MailboxDropReason) => void> = [];

  /** Number of messages dropped by the overflow policy — useful for metrics. */
  droppedCount = 0;

  /** See {@link DropReportingMailbox.observeDrops} — additive. */
  observeDrops(observer: (reason: MailboxDropReason) => void): void {
    this.dropObservers.push(observer);
  }

  /**
   * One place that owns "a message was discarded".
   *
   * Before #1149 the counter and the caller's hook were incremented inline in
   * each overflow branch, which is how the framework's observer came to be
   * missing from the `withMailbox` path — the wiring lived at the
   * construction site rather than at the drop.
   */
  protected reportDrop(reason: MailboxDropReason): void {
    this.droppedCount++;
    for (const observer of this.dropObservers) observer(reason);
  }
}
