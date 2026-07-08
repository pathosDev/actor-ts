import { Mailbox, type Envelope } from '../internal/Mailbox.js';

/**
 * Priority order for user messages.  Lower numeric priority values are
 * dequeued first — `0` is highest priority.  Ties are broken by FIFO
 * insertion order.
 */
export type PriorityFunction<T> = (message: T) => number;

export interface PriorityMailboxOptionsType<T> {
  readonly priorityFor: PriorityFunction<T>;
}

/**
 * User messages are dequeued in priority order (ascending priority value,
 * then FIFO).  System messages still take strict precedence over any user
 * message.  Internally backed by an ordered array — suitable for moderate
 * mailbox sizes; swap for a heap if throughput becomes a concern.
 */
export class PriorityMailbox<T = unknown> extends Mailbox<T> {
  private readonly priorityFor: PriorityFunction<T>;
  /** Monotonic counter — tie-breaker preserving FIFO among equal-priority messages. */
  private seq = 0;
  private readonly ordered: Array<{ env: Envelope<T>; priority: number; seq: number }> = [];

  constructor(options: PriorityMailboxOptionsType<T>) {
    super();
    this.priorityFor = options.priorityFor;
  }

  override enqueue(env: Envelope<T>): void {
    const priority = this.priorityFor(env.message);
    const entry = { env, priority, seq: this.seq++ };
    // Insert by priority, then seq.  Binary-search insertion — O(log n)
    // locate + O(n) splice, adequate for moderate queues.
    let lo = 0, hi = this.ordered.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const item = this.ordered[mid]!;
      if (item.priority < priority || (item.priority === priority && item.seq < entry.seq)) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this.ordered.splice(lo, 0, entry);
  }

  override dequeueUser(): Envelope<T> | undefined {
    if (this.suspended) return undefined;
    return this.ordered.shift()?.env;
  }

  override get size(): number { return this.ordered.length; }

  override hasUserMessages(): boolean { return this.ordered.length > 0; }

  override drainUser(): Envelope<T>[] {
    const out = this.ordered.map(e => e.env);
    this.ordered.length = 0;
    return out;
  }

  override prependUser(envs: Array<Envelope<T>>): void {
    // Reinsert via enqueue — priority is re-computed, which is the correct
    // behaviour (unstashed messages rejoin their priority tier).
    for (const e of envs) this.enqueue(e);
  }

  /** Peek at the next message that would be dequeued, without removing it. */
  override hasMessages(): boolean {
    return this.hasSystemMessages() || (!this.suspended && this.ordered.length > 0);
  }
}
