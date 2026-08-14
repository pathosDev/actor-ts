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
  // Public rather than protected: the class doubles as an EventStream
  // channel token, and a protected constructor is not assignable to the
  // public constructor type `subscribe` takes.  Abstract already stops
  // anyone instantiating it.
  constructor(
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

/**
 * A unit of work scheduled on a dispatcher threw, and supervision was not
 * going to hear about it.
 *
 * Deliberately *not* an {@link ActorLifecycleEvent}: it is not a
 * transition in an actor's life, and its `actor` may be `null` — a task
 * handed straight to `dispatcher.execute` belongs to no cell.  Subscribing
 * to the lifecycle base must not start delivering failures.
 *
 * Everything supervision can catch is already caught before it gets here:
 * a throw out of `onReceive` goes to the parent's strategy.  What lands on
 * this channel is what supervision structurally cannot see — a failure in
 * the machinery *around* the handler, or in a task the framework never
 * owned.  That makes it low-volume and worth alerting on, which is exactly
 * why it needed a channel instead of a console line (#410).
 */
export class DispatcherError {
  constructor(
    /** `id` of the dispatcher whose unit failed. */
    public readonly dispatcherId: string,
    /** The failure, normalised to an `Error` even when a non-Error was thrown. */
    public readonly cause: Error,
    /**
     * The actor whose turn failed, or `null` when the failing unit came
     * straight from `dispatcher.execute` and belongs to no cell.
     */
    public readonly actor: ActorRef | null = null,
  ) {}
  toString(): string {
    const where = this.actor === null ? this.dispatcherId : String(this.actor.path);
    return `DispatcherError(${where}, ${this.cause.message})`;
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
