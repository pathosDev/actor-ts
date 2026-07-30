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

export type ReceiveBehavior<T> = {
  readonly kind: 'receive';
  readonly handler: (context: TypedActorContext<T>, message: T) => Behavior<T>;
  readonly onSignal?: (context: TypedActorContext<T>, signal: Signal) => Behavior<T>;
};

export type SetupBehavior<T> = {
  readonly kind: 'setup';
  readonly factory: (context: TypedActorContext<T>) => Behavior<T>;
};

export type WithTimersBehavior<T> = {
  readonly kind: 'with-timers';
  readonly factory: (timers: import('../ActorContext.js').TimerScheduler<T>) => Behavior<T>;
};

export type WithStashBehavior<T> = {
  readonly kind: 'with-stash';
  readonly capacity: number;
  readonly factory: (stash: StashBuffer<T>) => Behavior<T>;
};

export type SuperviseBehavior<T> = {
  readonly kind: 'supervise';
  readonly child: Behavior<T>;
  readonly strategy: SupervisorStrategy;
};

export type SameBehavior = { readonly kind: 'same'; };
export type StoppedBehavior = { readonly kind: 'stopped'; };
export type UnhandledBehavior = { readonly kind: 'unhandled'; };
export type EmptyBehavior = { readonly kind: 'empty'; };
export type IgnoreBehavior = { readonly kind: 'ignore'; };

/**
 * Lightweight stash interface handed to `Behaviors.withStash` factories.
 * Thin wrapper over the OO `context.stash()` API so the typed DSL keeps
 * the same guarantees (FIFO, capacity, overflow error).
 */
export type StashBuffer<T> = {
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
};
