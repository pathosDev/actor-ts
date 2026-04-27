import type { ActorRef } from './ActorRef.js';

/**
 * Gracefully stops an actor after it has processed all currently
 * enqueued messages.  Classic actor-model "stop after drain" semantic.
 */
export class PoisonPill {
  static readonly instance = new PoisonPill();
  private constructor() {}
  toString(): string { return 'PoisonPill'; }
}

/**
 * Immediately terminates the actor (raises an ActorKilledException inside the cell).
 */
export class Kill {
  static readonly instance = new Kill();
  private constructor() {}
  toString(): string { return 'Kill'; }
}

/**
 * Delivered to watchers when a watched actor has been terminated.
 */
export class Terminated {
  constructor(
    public readonly actor: ActorRef,
    public readonly existenceConfirmed: boolean = true,
    public readonly addressTerminated: boolean = false,
  ) {}
  toString(): string { return `Terminated(${this.actor})`; }
}

/**
 * Sent to an actor when it has not received a message within its configured
 * receive timeout. See ActorContext.setReceiveTimeout.
 */
export class ReceiveTimeout {
  static readonly instance = new ReceiveTimeout();
  private constructor() {}
  toString(): string { return 'ReceiveTimeout'; }
}

/**
 * Wraps an undeliverable message sent to dead letters.
 */
export class DeadLetter {
  constructor(
    public readonly message: unknown,
    public readonly sender: ActorRef | null,
    public readonly recipient: ActorRef,
  ) {}
  toString(): string {
    return `DeadLetter(msg=${String(this.message)}, from=${this.sender ?? 'none'}, to=${this.recipient})`;
  }
}

/** Thrown when an actor handles a Kill system message. */
export class ActorKilledError extends Error {
  constructor() {
    super('Kill');
    this.name = 'ActorKilledError';
  }
}

/** Thrown inside askers when the ask target times out. */
export class AskTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AskTimeoutError';
  }
}
