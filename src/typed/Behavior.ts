import type { TypedActorContext } from './TypedActorContext.js';
import type { SupervisorStrategy } from '../Supervision.js';

/**
 * Signals are lifecycle/system events delivered to a behavior's onSignal
 * handler — enough to react to children terminating or to the actor
 * itself stopping.
 */
export type Signal =
  | { readonly kind: 'post-stop' }
  | { readonly kind: 'pre-restart'; readonly reason: Error }
  | { readonly kind: 'terminated'; readonly ref: import('../ActorRef.js').ActorRef };

/**
 * A Behavior describes how to handle the next message (and optionally
 * lifecycle signals).  Behaviors are values, not classes — the runtime
 * interprets the discriminant and calls back into user code.
 */
export type Behavior<T> =
  | ReceiveBehavior<T>
  | SetupBehavior<T>
  | WithTimersBehavior<T>
  | WithStashBehavior<T>
  | SuperviseBehavior<T>
  | SameBehavior
  | StoppedBehavior
  | UnhandledBehavior
  | EmptyBehavior
  | IgnoreBehavior;

export interface ReceiveBehavior<T> {
  readonly _kind: 'receive';
  readonly handler: (ctx: TypedActorContext<T>, msg: T) => Behavior<T>;
  readonly onSignal?: (ctx: TypedActorContext<T>, signal: Signal) => Behavior<T>;
}

export interface SetupBehavior<T> {
  readonly _kind: 'setup';
  readonly factory: (ctx: TypedActorContext<T>) => Behavior<T>;
}

export interface WithTimersBehavior<T> {
  readonly _kind: 'with-timers';
  readonly factory: (timers: import('../ActorContext.js').TimerScheduler<T>) => Behavior<T>;
}

export interface WithStashBehavior<T> {
  readonly _kind: 'with-stash';
  readonly capacity: number;
  readonly factory: (stash: StashBuffer<T>) => Behavior<T>;
}

export interface SuperviseBehavior<T> {
  readonly _kind: 'supervise';
  readonly child: Behavior<T>;
  readonly strategy: SupervisorStrategy;
}

export interface SameBehavior { readonly _kind: 'same'; }
export interface StoppedBehavior { readonly _kind: 'stopped'; }
export interface UnhandledBehavior { readonly _kind: 'unhandled'; }
export interface EmptyBehavior { readonly _kind: 'empty'; }
export interface IgnoreBehavior { readonly _kind: 'ignore'; }

/**
 * Lightweight stash interface handed to `Behaviors.withStash` factories.
 * Thin wrapper over the OO `context.stash()` API so the typed DSL keeps
 * the same guarantees (FIFO, capacity, overflow error).
 */
export interface StashBuffer<T> {
  /** Stash the current message; must be called during a user message. */
  stash(message: T): void;
  /** Replay the buffered messages back onto the mailbox. */
  unstashAll(): void;
  /** True if the buffer holds any message. */
  readonly isEmpty: boolean;
  /** True if the buffer is at capacity. */
  readonly isFull: boolean;
  /** Current number of stashed messages. */
  readonly size: number;
}
