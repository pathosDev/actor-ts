import type { ActorRef } from './ActorRef.js';
import type { ActorPath } from './ActorPath.js';
import type { ActorSystem } from './ActorSystem.js';
import type { ActorClassOrFactory } from './Actor.js';
import type { ActorOptions } from './ActorOptions.js';
import type { EntityContext } from './EntityContext.js';
import type { Logger } from './Logger.js';
import type { Option } from './util/Option.js';
import type { ThrottleOptions, ThrottleOnExcess } from './ThrottleOptions.js';

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

  /**
   * The `Cluster` this actor's system joined, `None` on a local-only
   * system (#833).  Ask this when the actor has to work either way —
   * it answers rather than throws.
   *
   * Inside code that only ever runs clustered, prefer the `this.cluster`
   * getter on {@link Actor}: same object, no unwrapping.
   */
  readonly cluster: Option<import('./cluster/Cluster.js').Cluster>;

  /** Parent actor, or `None` for the root guardian. */
  readonly parent: Option<ActorRef>;

  /** Snapshot of direct children. */
  readonly children: ReadonlyArray<ActorRef>;

  /**
   * Sharding identity when `ClusterSharding` started this actor as an
   * entity, `None` for every other actor.
   *
   * Set on the entity itself and nowhere else — an entity's own children
   * get `None` — so `Some` here means "I *am* the entity", not "I live
   * under one".  A child that needs the id gets it passed down.
   *
   * Inside an entity, prefer the `this.entityId` / `this.entity` getters on
   * {@link Actor}: they answer the same question without the unwrapping,
   * because entity code already knows it is an entity.
   */
  readonly entity: Option<EntityContext>;

  /**
   * Logger bound to this actor's path, and to whatever
   * `Actor.displayName()` currently resolves to.
   */
  readonly log: Logger;

  /**
   * Name this actor in log lines and in the DevTools tree from inside the
   * running actor (#891) — for a name that only becomes known at runtime
   * (after recovery, after the first message), and for `Behaviors` actors,
   * which have no subclass to override `Actor.displayName()` on:
   *
   *     Behaviors.setup<Command>((context) => {
   *       context.setDisplayName(`User(${userId})`);
   *       return Behaviors.receive(...);
   *     });
   *
   * Takes effect on the very next record, and outranks both
   * `ActorOptions.withDisplayName(...)` and the method.  Purely cosmetic — the
   * path stays the identity everywhere that routes or correlates.
   */
  setDisplayName(name: string): void;

  /**
   * Spawn a child actor under this one with a deterministic
   * caller-supplied name.  The name must be unique among siblings.
   * For an auto-generated name, see {@link spawnAnonymous}.
   */
  spawn<T>(actor: ActorClassOrFactory<T>, name: string, options?: ActorOptions<T>): ActorRef<T>;

  /**
   * Spawn a child actor under this one with an auto-generated name.
   * Useful for one-shot helpers and other transient children where
   * the caller doesn't need a stable path.  For a deterministic
   * name, see {@link spawn}.
   */
  spawnAnonymous<T>(actor: ActorClassOrFactory<T>, options?: ActorOptions<T>): ActorRef<T>;

  /**
   * Spawn a typed-Behavior child with a deterministic name — the
   * Behavior-DSL counterpart to {@link spawn}.  Wraps the Behavior
   * in `typedActor` internally so callers don't have to.
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

  /**
   * Start death-watching an actor.  A `Terminated` message is sent when it
   * stops.
   *
   * It arrives on this actor's ordinary user queue, behind every `tell` already
   * waiting there, and it cannot be lost on the way: a mailbox bound and a
   * `throttle({ onExcess: 'drop' })` both step over it, because the framework
   * sends it once and has no way to send it again (#729).  A watcher that
   * cannot be reached at all — it has already stopped — gets a dead letter, so
   * the loss is visible rather than silent.
   */
  watch(ref: ActorRef): ActorRef;

  /**
   * Death-watch `ref`, but deliver `message` instead of `Terminated(ref)`.
   *
   * `Terminated` answers "did *that one* die?", which forces every watcher to
   * carry the signal in its protocol and to re-derive the meaning of the death
   * from `Terminated.actor`.  A watcher that watches several kinds of actor —
   * workers, a connection, a peer — ends up with one handler branching on ref
   * identity.  `watchWith` moves that decision to registration time, so each
   * death arrives as the domain message the watcher already handles:
   *
   *     this.context.watchWith(worker, { kind: 'workerLost', name });
   *     this.context.watchWith(connection, { kind: 'connectionLost' });
   *
   * `message` must belong to this actor's own protocol — it is delivered to
   * `onReceive` like any other user message, not as a signal.  "Like any other"
   * covers ordering and nothing else: it is queued behind whatever is already
   * there, and it is exempt from this actor's mailbox bound and throttle for
   * the same reason the `Terminated` it replaces is (#729) — a death is
   * announced once.
   *
   * Last call wins: `watchWith` on an already-watched ref replaces whatever the
   * previous `watch`/`watchWith` registered, and a later plain `watch` drops the
   * custom message again.  The registration is consumed by the death it
   * describes — watching the same *name* again after a restart is a new
   * subject and needs a new call.
   */
  watchWith(ref: ActorRef, message: TMessage): ActorRef;

  /** Stop watching — whether registered via `watch` or `watchWith`. */
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

  /* -------------------------- Diagnostics ------------------------------- */

  /**
   * Start recording this actor's recent message handlings — type,
   * sender, mailbox wait, handling time and outcome — for the DevTools
   * explain plan or for reading back in code.
   *
   * Opt-in per actor because it is not free: recording every message on
   * every actor would cost more than many of the handlers being
   * measured.  Enabling it also starts timestamping this actor's
   * incoming envelopes, which is what makes the mailbox-wait figure
   * possible.
   *
   *     override preStart(): void {
   *       this.context.enableExplainPlan({ capacity: 100 });
   *     }
   */
  enableExplainPlan(options?: { readonly capacity?: number }): void;

  /** Stop recording and discard what was recorded. */
  disableExplainPlan(): void;

  /** Recorded handlings, oldest first.  Empty while recording is off. */
  explainPlan(): ReadonlyArray<import('./internal/Instrumentation.js').MessageExplain>;

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
   * {@link ThrottleOnExcess}.  System commands (create, terminate,
   * supervision, …) are NOT throttled — they run on the system queue,
   * ahead of user messages, so timer fires and lifecycle events stay
   * responsive.
   *
   * A death-watch `Terminated` is on the *user* queue and is exempt all the
   * same: it consumes no token and is never the message an `onExcess: 'drop'`
   * discards, because the framework announces a death once (#729).  Before
   * that exemption this JSDoc claimed the exemption anyway and the code did
   * the opposite.
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
 * The throttle option types live in `./ThrottleOptions.ts` alongside the
 * rest of the Options family (the fluent builder and the validator);
 * re-exported here so they travel with the {@link ActorContext.throttle}
 * method that consumes them.
 */
export type { ThrottleOptions, ThrottleOnExcess };

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
