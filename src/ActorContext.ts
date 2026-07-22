import type { ActorRef } from './ActorRef.js';
import type { ActorPath } from './ActorPath.js';
import type { ActorSystem } from './ActorSystem.js';
import type { Props } from './Props.js';
import type { Logger } from './Logger.js';
import type { Option } from './util/Option.js';

/** Behaviour is just a message handler. Used for become/unbecome. */
export type Receive<T> = (message: T) => void | Promise<void>;

/**
 * Runtime API given to every Actor.  Access through `this.context` inside
 * an Actor subclass.
 */
export interface ActorContext<TMessage = unknown> {
  /** A reference to this actor. */
  readonly self: ActorRef<TMessage>;

  /** The ActorPath of this actor. */
  readonly path: ActorPath;

  /** The sender of the message currently being processed, or `None`. */
  readonly sender: Option<ActorRef>;

  /** The enclosing ActorSystem. */
  readonly system: ActorSystem;

  /** Parent actor, or `None` for the root guardian. */
  readonly parent: Option<ActorRef>;

  /** Snapshot of direct children. */
  readonly children: ReadonlyArray<ActorRef>;

  /** Logger bound to this actor's path. */
  readonly log: Logger;

  /**
   * Spawn a child actor under this one with a deterministic
   * caller-supplied name.  The name must be unique among siblings.
   * For an auto-generated name, see {@link spawnAnonymous}.
   */
  spawn<T>(props: Props<T>, name: string): ActorRef<T>;

  /**
   * Spawn a child actor under this one with an auto-generated name.
   * Useful for one-shot helpers and other transient children where
   * the caller doesn't need a stable path.  For a deterministic
   * name, see {@link spawn}.
   */
  spawnAnonymous<T>(props: Props<T>): ActorRef<T>;

  /**
   * Spawn a typed-Behavior child with a deterministic name — the
   * Behavior-DSL counterpart to {@link spawn}.  Wraps the Behavior
   * in `typedProps` internally so callers don't have to.
   *
   *     const child = this.context.spawnTyped(counter(0), 'counter');
   */
  spawnTyped<T>(behavior: import('./typed/Behavior.js').Behavior<T>, name: string): ActorRef<T>;

  /**
   * Anonymous variant of {@link spawnTyped} — the Behavior-DSL
   * counterpart to {@link spawnAnonymous}.
   */
  spawnTypedAnonymous<T>(behavior: import('./typed/Behavior.js').Behavior<T>): ActorRef<T>;

  /** Look up a direct child by name.  `None` if no such child exists. */
  child(name: string): Option<ActorRef>;

  /**
   * Build an ActorSelection that resolves a full-path lookup.  Delegates to
   * the enclosing ActorSystem — same semantics as `system.actorSelection`.
   */
  actorSelection(path: string): import('./ActorSelection.js').ActorSelection;

  /** Ask the runtime to stop the given actor.  Equivalent to ref.stop(). */
  stop(ref: ActorRef): void;

  /** Stop this actor itself. */
  stopSelf(): void;

  /** Start death-watching an actor.  A Terminated message is sent when it stops. */
  watch(ref: ActorRef): ActorRef;

  /** Stop watching. */
  unwatch(ref: ActorRef): ActorRef;

  /**
   * Replace the current behaviour.  When `discardOld` is false, the previous
   * behaviour is pushed onto a stack and can be restored via unbecome().
   */
  become(behavior: Receive<TMessage>, discardOld?: boolean): void;

  /** Pop the behaviour stack, restoring the previous behaviour. */
  unbecome(): void;

  /**
   * Fire a ReceiveTimeout message when no user message has been received in
   * `ms`.  Pass 0 to disable.
   */
  setReceiveTimeout(ms: number): void;

  /** Disable the receive timeout. */
  cancelReceiveTimeout(): void;

  /* ----------------------------- Stash ---------------------------------- */

  /**
   * Buffer the message currently being handled.  It is reinserted into the
   * mailbox when `unstashAll()` is called.  Throws if called outside a
   * user-message handler or if the stash is full.
   */
  stash(): void;

  /**
   * Prepend every stashed message back onto the user mailbox in the order
   * they were stashed.  The buffer is empty afterwards.
   */
  unstashAll(): void;

  /** Number of currently-stashed messages. */
  readonly stashSize: number;

  /* ----------------------------- Timers --------------------------------- */

  /**
   * Per-actor scheduling facade.  Timers are identified by user-supplied
   * string keys and are automatically cancelled when the actor stops.
   */
  readonly timers: TimerScheduler<TMessage>;

  /* --------------------------- Rate limiting ---------------------------- */

  /**
   * Throttle this actor's user-message processing to a token-bucket
   * rate (#83).  Every dequeue from the user mailbox consumes one
   * token; when the bucket is empty the cell behaves per
   * {@link ThrottleOnExcess}.  System messages (Terminated,
   * supervision, watchNotify) are NOT throttled — they always run
   * immediately, so timer fires and lifecycle events stay
   * responsive.
   *
   * Calling `throttle` again replaces the existing limiter; pass
   * `{ qps: Infinity }` or call {@link cancelThrottle} to remove one.
   *
   * Cluster-aware variants (split a budget across cluster-router
   * routees, etc.) are out of scope here — this is per-actor only.
   */
  throttle(options: ThrottleOptions): void;

  /** Remove any active throttle, restoring unlimited dequeue rate. */
  cancelThrottle(): void;
}

/**
 * What to do with a user message dequeued while the actor's
 * {@link ActorContext.throttle | throttle} bucket is empty.
 */
export type ThrottleOnExcess =
  /**
   * *(default)* Don't dequeue — pause the message-pump until tokens
   * replenish, then resume normally.  Natural backpressure: the
   * mailbox queues up, every message eventually processes, latency
   * grows under load.
   */
  | 'pause'
  /**
   * Dequeue the message and discard it (with a debug log).  Useful
   * for telemetry-style traffic where staleness is worse than loss.
   */
  | 'drop';

export interface ThrottleOptions {
  /** Token-refill rate, tokens per second.  Required; must be > 0. */
  readonly qps: number;
  /** Bucket capacity.  Default: `qps` (one second of refill). */
  readonly burst?: number;
  /** What to do when the bucket is empty.  Default: `'pause'`. */
  readonly onExcess?: ThrottleOnExcess;
  /** Time source — pass a deterministic clock for tests.  Default: `Date.now`. */
  readonly now?: () => number;
}

/**
 * Actor-scoped scheduler.  A fresh `startSingleTimer`/`startTimerWithFixedDelay`
 * call with the same key replaces any existing timer under that key.
 */
export interface TimerScheduler<TMessage = unknown> {
  /** Fire `message` once after `delayMs`. */
  startSingleTimer(key: string, message: TMessage, delayMs: number): void;

  /** Fire `message` every `intervalMs`, optionally preceded by `initialDelayMs`. */
  startTimerWithFixedDelay(
    key: string,
    message: TMessage,
    intervalMs: number,
    initialDelayMs?: number,
  ): void;

  /** Cancel a specific timer.  Returns true if a timer was actually running. */
  cancel(key: string): boolean;

  /** Cancel every timer this actor has started. */
  cancelAll(): void;

  /** True if the timer under `key` is still scheduled to fire. */
  isTimerActive(key: string): boolean;

  /** Names of active timers (diagnostics). */
  activeKeys(): string[];
}

export class StashOverflowError extends Error {
  constructor(capacity: number) {
    super(`Stash overflow: buffer is full (capacity=${capacity})`);
    this.name = 'StashOverflowError';
  }
}

export class StashOutsideHandlerError extends Error {
  constructor() {
    super('context.stash() must be called while handling a user message');
    this.name = 'StashOutsideHandlerError';
  }
}
