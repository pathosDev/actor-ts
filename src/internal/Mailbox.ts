import type { ActorRef } from '../ActorRef.js';
import type { LogContextData } from '../LogContext.js';
import type { SpanContext } from '../tracing/Tracer.js';

export type Envelope<T = unknown> = {
  readonly message: T;
  readonly sender: ActorRef | null;
  /**
   * Optional MDC snapshot captured at `tell` time.  Propagated
   * through the actor's `onReceive` so log lines emitted while
   * handling this message (and any tells issued from inside it)
   * carry the originating context.  See {@link LogContext}.
   */
  readonly context?: LogContextData;
  /**
   * Optional active-span context captured at `tell` time.  If the
   * tracing extension is enabled and the receiver also has it
   * enabled, the receiver's `actor.receive` span links back to this
   * one as its parent — producing one coherent trace across actor
   * hops and cluster nodes.  See {@link Tracer}.
   */
  readonly trace?: SpanContext;
  /**
   * Wall clock at first enqueue, stamped only while the receiving
   * actor has an explain plan enabled — see `ActorContext.
   * enableExplainPlan`.  A stashed message keeps its original stamp
   * when replayed (`prependUser` does not restamp), so mailbox wait
   * measures the whole time from arrival to handling.
   */
  readonly enqueuedAtMs?: number;
};

/**
 * Why a mailbox discarded a message — the `reason` label on
 * `actor_mailbox_dropped_total`.
 *
 * Deliberately a closed set of two rather than a free-form string, even for a
 * mailbox of your own: `reason` is a metric label, and an open one is a
 * cardinality vector (#745).  Pick whichever describes what you did — you
 * dropped the oldest queued message, or you dropped the arriving one.
 * Refusing a message is not a drop; that throws instead.
 *
 * Lives here rather than in `BoundedMailboxOptions.ts` despite typing an
 * option field there: it is the vocabulary of {@link DropReportingMailbox},
 * which every mailbox may implement, and `BoundedMailbox` is only the
 * built-in one that does.  The layering runs base → subclass, so the shared
 * word belongs at the base.
 */
export type MailboxDropReason = 'drop-head' | 'drop-new';

/**
 * A mailbox that discards messages and is willing to say so.
 *
 * Implement it on a {@link Mailbox} subclass of your own and the cell counts
 * its drops in `actor_mailbox_dropped_total`, with the same
 * `{class, path, reason}` labels the built-in bound produces.  `BoundedMailbox`
 * implements it; nothing else needs to.
 *
 * The cell probes for this method rather than testing
 * `instanceof BoundedMailbox` on purpose.  Since #661 the base `Mailbox` is
 * public and subclassing it is a supported thing to do, so a queue that drops
 * for its own reasons should not be second-class in the telemetry.
 */
export interface DropReportingMailbox {
  /**
   * Register a drop observer.  Called by the cell once, before the mailbox
   * receives anything.
   *
   * **Additive, not a setter.**  Whatever the mailbox already reports —
   * `BoundedMailboxOptions.onDrop`, a previously registered observer — has to
   * keep firing.  A caller who wired their own metric does not lose it
   * because the framework wired the stock one.
   */
  observeDrops(observer: (reason: MailboxDropReason) => void): void;
}

/**
 * Does this mailbox report its drops?  The structural check that keeps
 * {@link DropReportingMailbox} open to implementations the framework has
 * never heard of.
 */
export function reportsDrops<T>(
  mailbox: Mailbox<T>,
): mailbox is Mailbox<T> & DropReportingMailbox {
  return typeof (mailbox as Partial<DropReportingMailbox>).observeDrops === 'function';
}

/**
 * Per-actor message queue.  System messages (create, terminate, failure, …)
 * are kept on a separate priority queue and drained before any user message.
 */
export class Mailbox<T = unknown> {
  private userQueue: Envelope<T>[] = [];
  private systemQueue: Envelope<unknown>[] = [];
  private _suspended = false;

  get suspended(): boolean { return this._suspended; }

  enqueue(env: Envelope<T>): void {
    this.userQueue.push(env);
  }

  /** Put envelopes at the FRONT of the user queue, preserving their order. */
  prependUser(envs: Array<Envelope<T>>): void {
    this.userQueue.unshift(...envs);
  }

  enqueueSystem(env: Envelope<unknown>): void {
    this.systemQueue.push(env);
  }

  dequeueUser(): Envelope<T> | undefined {
    if (this._suspended) return undefined;
    return this.userQueue.shift();
  }

  /**
   * Remove the oldest user message, regardless of suspension.
   *
   * `dequeueUser` refuses while suspended, and rightly so — a suspended actor
   * must not be handed work.  Making room in a full queue is a different
   * question: it is not delivery, and a bounded mailbox that quietly stops
   * enforcing its bound while the actor is suspended is unbounded exactly when
   * the bound matters most, since suspension means the actor has failed and is
   * awaiting its parent's supervision decision while messages keep arriving.
   *
   * Returns `undefined` only when the queue is already empty, which lets the
   * caller distinguish a real drop from a no-op.
   */
  protected removeOldest(): Envelope<T> | undefined {
    return this.userQueue.shift();
  }

  dequeueSystem(): Envelope<unknown> | undefined {
    return this.systemQueue.shift();
  }

  hasMessages(): boolean {
    return this.systemQueue.length > 0 || (!this._suspended && this.userQueue.length > 0);
  }
  hasUserMessages(): boolean { return this.userQueue.length > 0; }
  hasSystemMessages(): boolean { return this.systemQueue.length > 0; }

  /** Number of pending user messages. */
  get size(): number { return this.userQueue.length; }

  suspend(): void { this._suspended = true; }
  resume(): void { this._suspended = false; }

  /** Drain all user messages; returns them so the caller can forward to dead letters. */
  drainUser(): Envelope<T>[] {
    const drained = this.userQueue;
    this.userQueue = [];
    return drained;
  }

  drainSystem(): Envelope<unknown>[] {
    const drained = this.systemQueue;
    this.systemQueue = [];
    return drained;
  }
}
