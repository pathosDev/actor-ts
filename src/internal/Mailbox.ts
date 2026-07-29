import type { ActorRef } from '../ActorRef.js';
import type { LogContextData } from '../LogContext.js';
import type { SpanContext } from '../tracing/Tracer.js';

export interface Envelope<T = unknown> {
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
