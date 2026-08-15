import type { ActorRef } from '../ActorRef.js';
import type { LogContextData } from '../LogContext.js';
import type { SpanContext } from '../tracing/Tracer.js';
import { RingBuffer } from '../util/RingBuffer.js';

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
 *
 * Both queues are {@link RingBuffer}s rather than plain arrays, which is
 * invisible from the outside and load-bearing underneath: every removal used
 * to be an `Array.prototype.shift()`, and that reindexes the whole backlog.
 * Since #1148 made the unbounded mailbox the default again there is no
 * capacity capping how deep a backlog gets, so an actor that falls behind its
 * producers was paying a memmove of its entire queue for every message it
 * delivered (#408).
 *
 * The fields stay `private`, so a subclass sees only the methods — which is
 * why swapping the backing store is not a breaking change even though
 * `Mailbox` is public and explicitly subclassable since #661 / #1002.  The
 * one seam a subclass touches is `protected` {@link removeOldest}, and its
 * signature is unchanged.
 */
export class Mailbox<T = unknown> {
  private readonly userQueue = new RingBuffer<Envelope<T>>();
  private readonly systemQueue = new RingBuffer<Envelope<unknown>>();
  private _suspended = false;

  get suspended(): boolean { return this._suspended; }

  enqueue(env: Envelope<T>): void {
    this.userQueue.push(env);
  }

  /**
   * Put envelopes at the FRONT of the user queue, preserving their order.
   *
   * One bulk move, not a spread: `unstashAll` replays up to
   * `DEFAULT_STASH_CAPACITY` envelopes in a single call, and
   * `unshift(...envs)` would both reindex the backlog once per envelope and
   * push the whole batch onto the call stack as arguments.
   */
  prependUser(envs: Array<Envelope<T>>): void {
    this.userQueue.unshiftAll(envs);
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

  /**
   * Drain all user messages; returns them so the caller can forward to dead
   * letters.
   *
   * Materialises a fresh array rather than handing out the backing store —
   * a ring is not a dense array, so there is nothing to hand out.  The
   * allocation is real but it is on the termination path, where the caller
   * (`ActorCell`) only iterates the result once.
   */
  drainUser(): Envelope<T>[] {
    return this.userQueue.drain();
  }

  drainSystem(): Envelope<unknown>[] {
    return this.systemQueue.drain();
  }
}
