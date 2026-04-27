import type { ActorRef } from '../ActorRef.js';

export interface Envelope<T = unknown> {
  readonly message: T;
  readonly sender: ActorRef | null;
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
