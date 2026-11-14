import {
  Mailbox,
  type DropReportingMailbox,
  type Envelope,
  type MailboxDropObserver,
  type MailboxDropReason,
} from '../internal/Mailbox.js';

/**
 * A replay arrived on a full mailbox whose overflow policy is `reject`.
 *
 * Raised by `prependUser` only — the `unstashAll()` path, on the replaying
 * actor's own stack, refusing the whole batch.  It used to be thrown at the
 * **`tell` call site** too, into whoever sent the message, and when that
 * sender was an actor it was failed and restarted because the actor it sent
 * to was slow (#919).  A `tell` under `reject` now refuses the arrival without
 * throwing and dead-letters it: see `BoundedMailboxOverflow`.
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
 * `deadLetterDrops` as a bounded mailbox resolves it: what the caller said,
 * else on under `reject` and off otherwise (#919).
 *
 * `reject` is the policy that promises a refusal is never silent, and since
 * it stopped throwing at the `tell` the dead letter is how it keeps that
 * promise; a `drop-*` policy says loss is acceptable, so the fan-out stays
 * opt-in there.  Read off the raw argument because the base class holds the
 * field and has to be constructed before the settings are validated.  Shared
 * by the three bounded mailboxes, whose `overflow` vocabularies all carry
 * `reject`.
 */
export function deadLetterDropsFor(
  options: { readonly overflow?: string; readonly deadLetterDrops?: boolean },
): boolean {
  return options.deadLetterDrops ?? options.overflow === 'reject';
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
export abstract class DroppingMailbox<T = unknown> extends Mailbox<T> implements DropReportingMailbox<T> {
  /**
   * Drop observers, in registration order.  A list rather than one slot so
   * registering is additive: the cell registers one, and a mailbox instance
   * shared between two cells (a documented mistake, but a possible one)
   * reports to both instead of the second silently unhooking the first.
   */
  private readonly dropObservers: Array<MailboxDropObserver<T>> = [];

  /** Number of messages dropped by the overflow policy — useful for metrics. */
  droppedCount = 0;

  /**
   * See {@link DropReportingMailbox.deadLetterDrops}.  Fixed at construction
   * because the cell reads it once, when it registers its observer: a switch
   * a running mailbox could flip would mean re-reading it per dropped message,
   * on the path this class exists to keep cheap.
   */
  readonly deadLetterDrops: boolean;

  /**
   * The parameter is optional so an existing subclass that calls `super()`
   * keeps compiling: opting a mailbox of your own into the dead-letter path
   * should be a line you add, not a line you are forced to add.
   */
  protected constructor(deadLetterDrops?: boolean) {
    super();
    this.deadLetterDrops = deadLetterDrops ?? false;
  }

  /** See {@link DropReportingMailbox.observeDrops} — additive. */
  observeDrops(observer: MailboxDropObserver<T>): void {
    this.dropObservers.push(observer);
  }

  /**
   * One place that owns "a message was discarded".
   *
   * Before #1149 the counter and the caller's hook were incremented inline in
   * each overflow branch, which is how the framework's observer came to be
   * missing from the `withMailbox` path — the wiring lived at the
   * construction site rather than at the drop.
   *
   * `envelope` is the one that was actually discarded, which is not always
   * the one that arrived: a `drop-head` bound reports the message it evicted
   * to make room, and a priority bound reports whichever end lost.  Passing
   * the arrival instead would make every dead letter name a message that is
   * still queued (#773), so the parameter is the *removed* envelope wherever
   * the two differ, and each call site is written to hand over exactly what
   * it let go of.
   */
  protected reportDrop(reason: MailboxDropReason, envelope: Envelope<T>): void {
    this.droppedCount++;
    for (const observer of this.dropObservers) observer(reason, envelope);
  }
}
