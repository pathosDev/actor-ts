import type { SupervisorStrategy } from '../Supervision.js';
import type { TimerScheduler } from '../ActorContext.js';
import type {
  Behavior,
  ReceiveBehavior,
  SameBehavior,
  StashBuffer,
  StoppedBehavior,
  UnhandledBehavior,
  EmptyBehavior,
  IgnoreBehavior,
  Signal,
} from './Behavior.js';
import type { TypedActorContext } from './TypedActorContext.js';

/*
 * Singleton sentinels — identity-compared at runtime so users can use
 * `Behaviors.same` directly without wrapping.  Type-cast to Behavior<T> on
 * access so each usage site can pin T.
 */
const SAME: SameBehavior = { _kind: 'same' };
const STOPPED: StoppedBehavior = { _kind: 'stopped' };
const UNHANDLED: UnhandledBehavior = { _kind: 'unhandled' };
const EMPTY: EmptyBehavior = { _kind: 'empty' };
const IGNORE: IgnoreBehavior = { _kind: 'ignore' };

/**
 * Fluent builder returned by `Behaviors.supervise(...)` so users can write
 * `Behaviors.supervise(b).onFailure(strategy)`.
 */
export interface SuperviseBuilder<T> {
  onFailure(strategy: SupervisorStrategy): Behavior<T>;
}

/**
 * Factory for building Behaviors — the functional facade over the OO
 * Actor API.  Use these combinators to compose an actor's logic as a tree
 * of values rather than as an imperative class.
 */
export const Behaviors = {
  /**
   * Run `factory` once with the actor's context; the returned Behavior is
   * the first one the actor adopts.  Use this to capture `ctx.self` or spawn
   * children in the "constructor".
   */
  setup<T>(factory: (ctx: TypedActorContext<T>) => Behavior<T>): Behavior<T> {
    return { _kind: 'setup', factory };
  },

  /** Standard receive — gets both context and message. */
  receive<T>(
    handler: (ctx: TypedActorContext<T>, msg: T) => Behavior<T>,
  ): ReceiveBehavior<T> {
    return { _kind: 'receive', handler };
  },

  /** Receive with an additional signal handler. */
  receiveWithSignal<T>(
    handler: (ctx: TypedActorContext<T>, msg: T) => Behavior<T>,
    onSignal: (ctx: TypedActorContext<T>, signal: Signal) => Behavior<T>,
  ): ReceiveBehavior<T> {
    return { _kind: 'receive', handler, onSignal };
  },

  /** Receive when you don't need the context — message-only shortcut. */
  receiveMessage<T>(handler: (msg: T) => Behavior<T>): ReceiveBehavior<T> {
    return { _kind: 'receive', handler: (_ctx, msg) => handler(msg) };
  },

  /** Expose the per-actor TimerScheduler to the behavior. */
  withTimers<T>(factory: (timers: TimerScheduler<T>) => Behavior<T>): Behavior<T> {
    return { _kind: 'with-timers', factory };
  },

  /**
   * Expose a capacity-bounded stash buffer.  The inner behavior can stash
   * user messages (e.g. during init) and call `stash.unstashAll()` later.
   */
  withStash<T>(capacity: number, factory: (stash: StashBuffer<T>) => Behavior<T>): Behavior<T> {
    return { _kind: 'with-stash', capacity, factory };
  },

  /**
   * Wrap a behavior with a supervisor strategy.  Any error thrown from the
   * wrapped handler is routed through `strategy` — the behavior is restarted
   * (reset to its initial form), stopped, resumed, or escalated.
   */
  supervise<T>(child: Behavior<T>): SuperviseBuilder<T> {
    return {
      onFailure(strategy: SupervisorStrategy): Behavior<T> {
        return { _kind: 'supervise', child, strategy };
      },
    };
  },

  /** Sentinel: keep the current behavior. */
  get same(): Behavior<never> { return SAME as Behavior<never>; },

  /** Sentinel: stop the actor. */
  get stopped(): Behavior<never> { return STOPPED as Behavior<never>; },

  /** Sentinel: mark the message as unhandled (goes to dead letters). */
  get unhandled(): Behavior<never> { return UNHANDLED as Behavior<never>; },

  /** Sentinel: accept messages but do nothing — useful as a placeholder. */
  get empty(): Behavior<never> { return EMPTY as Behavior<never>; },

  /** Sentinel: drop every incoming message silently. */
  get ignore(): Behavior<never> { return IGNORE as Behavior<never>; },
};

/** Re-exports for callers that prefer named imports. */
export const same = <T>(): Behavior<T> => Behaviors.same as Behavior<T>;
export const stopped = <T>(): Behavior<T> => Behaviors.stopped as Behavior<T>;
export const unhandled = <T>(): Behavior<T> => Behaviors.unhandled as Behavior<T>;
export const empty = <T>(): Behavior<T> => Behaviors.empty as Behavior<T>;
export const ignore = <T>(): Behavior<T> => Behaviors.ignore as Behavior<T>;
