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

/**
 * Base class for the actor-lifecycle events published on the
 * {@link EventStream}.
 *
 * Until these existed the event stream carried dead letters, cluster
 * events and broker events — but nothing about actors coming and going,
 * so the only way to learn that the tree had changed was to poll it.
 * A common base lets a subscriber take the whole family with one
 * `subscribe(ref, ActorLifecycleEvent)` (the stream matches by
 * `instanceof`, so subclasses reach base subscribers).
 *
 * Publishing is unconditional but cheap: the event stream skips
 * allocation-free when nothing subscribes to the channel.  These are
 * *observations*, not control flow — nothing in the runtime reacts to
 * them, and a slow subscriber cannot delay an actor's lifecycle.
 */
export abstract class ActorLifecycleEvent {
  protected constructor(
    /** The actor the event is about. */
    public readonly actor: ActorRef,
  ) {}
}

/** An actor finished starting: its instance exists and `preStart` ran. */
export class ActorStarted extends ActorLifecycleEvent {
  constructor(
    actor: ActorRef,
    /** Constructor name of the actor instance. */
    public readonly className: string,
    /** Path of the parent, or `null` for the root guardian. */
    public readonly parentPath: string | null,
  ) {
    super(actor);
  }
  toString(): string { return `ActorStarted(${this.actor.path}, ${this.className})`; }
}

/** An actor terminated.  Its children are already gone when this fires. */
export class ActorStopped extends ActorLifecycleEvent {
  constructor(actor: ActorRef) { super(actor); }
  toString(): string { return `ActorStopped(${this.actor.path})`; }
}

/** A supervisor restarted an actor; the path stays, the instance does not. */
export class ActorRestarted extends ActorLifecycleEvent {
  constructor(
    actor: ActorRef,
    /** Failure that triggered the restart. */
    public readonly cause: Error,
  ) {
    super(actor);
  }
  toString(): string { return `ActorRestarted(${this.actor.path}, ${this.cause.message})`; }
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
