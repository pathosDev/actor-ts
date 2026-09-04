import { LogLevel } from '../Logger.js';
import { OptionsError } from '../util/OptionsValidator.js';
import type { ActorRef } from '../ActorRef.js';
import type { SupervisorStrategy } from '../Supervision.js';
import type { TimerScheduler } from '../ActorContext.js';
import type {
  Behavior,
  BehaviorInterceptor,
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
 * `Behaviors.same` directly without wrapping.  Each is exposed as its own
 * payload-free type rather than as `Behavior<T>`; see the accessors below for
 * why that is what makes them usable without a cast.
 */
const SAME: SameBehavior = { kind: 'same' };
const STOPPED: StoppedBehavior = { kind: 'stopped' };
const UNHANDLED: UnhandledBehavior = { kind: 'unhandled' };
const EMPTY: EmptyBehavior = { kind: 'empty' };
const IGNORE: IgnoreBehavior = { kind: 'ignore' };

/**
 * Fluent builder returned by `Behaviors.supervise(...)` so users can write
 * `Behaviors.supervise(b).onFailure(strategy)`.
 */
export interface SuperviseBuilder<T> {
  onFailure(strategy: SupervisorStrategy): Behavior<T>;
}

/**
 * Tuning for `Behaviors.logMessages`.  A per-call parameter bag in the shape
 * of `StrategyOptions` rather than the `XOptions` builder triad: nothing here
 * is configurable from HOCON, and a fluent builder for two fields that are
 * chosen at the call site would be ceremony without a payoff.
 *
 * `level` is deliberately narrower than `Logger`'s four levels.  Logging every
 * message is a diagnostic, and a diagnostic that reports at `warn` or `error`
 * would poison exactly the signal an operator filters on.
 */
export type LogMessagesOptions<T> = {
  readonly level?: 'debug' | 'info';
  /**
   * Renders the whole log line, replacing the built-in `received <kind>`.
   * Must not throw; if it does, the built-in line is emitted instead so the
   * message is still recorded rather than the actor failing over a log call.
   */
  readonly formatter?: (message: T) => string;
};

/**
 * Reject a stash capacity that is not an integer `>= 1`.
 *
 * The domain is `OptionsValidator.positiveInt`'s, and deliberately so: it is
 * the rule `BoundedMailboxOptionsValidator` already applies to the
 * structurally identical `BoundedMailboxOptionsType.capacity`, so the one
 * bound a user can draw on a stash reports the same way as the one they draw
 * on a mailbox.  It throws that helper's {@link OptionsError} for the same
 * reason — the value is well-typed but outside its domain, which is exactly
 * what that error means — rather than a bare `Error` a caller cannot
 * discriminate.
 *
 * `NaN` and `Infinity` are what motivate the check (#795).  Every comparison
 * against `NaN` is false and nothing is `>= Infinity`, so either one defeats
 * the `buffer.length >= capacity` guard **and** the `isFull` built on the same
 * comparison: the buffer then grows without limit behind an API whose JSDoc
 * promises a capacity-bounded one, while `isFull` reports `false` the whole
 * way.  Neither needs a typo to arrive — `Number(process.env.STASH_CAPACITY)`
 * with the variable unset is `NaN`, and an arithmetic expression over an
 * absent configuration field is too.
 *
 * Zero and negative values are the mirror failure and are refused for the
 * opposite reason: they leave `stash()` throwing `StashOverflowError` on the
 * very first call, so the buffer is not unbounded but permanently unusable,
 * again with nothing naming the configuration that caused it.  A fractional
 * capacity is refused because a bound between two message counts is a defect
 * at the call site, not a bound anyone meant to draw.
 *
 * Written out rather than run through an `OptionsValidator` subclass for the
 * reason `ActorRef`'s `assertAskTimeout` is: this is one predicate over one
 * positional argument, with no `XOptions.ts` family for it to belong to.
 * `origin` is what the failure is attributed to — the two call sites are
 * reached by different routes and must not claim each other's.
 */
export function assertStashCapacity(capacity: number, origin: string): void {
  // `Number.isInteger` does not coerce, so it also rejects a non-number that
  // reached here from untyped JavaScript — and rejects `NaN` and `Infinity`
  // without either needing a comparison of its own.
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new OptionsError(
      `${origin}: capacity must be an integer >= 1 (got ${String(capacity)})`
      + ' — a stash whose bound never compares true is not bounded at all',
      origin,
      'capacity',
      capacity,
    );
  }
}

/**
 * Factory for building Behaviors — the functional facade over the OO
 * Actor API.  Use these combinators to compose an actor's logic as a tree
 * of values rather than as an imperative class.
 */
export const Behaviors = {
  /**
   * Run `factory` once with the actor's context; the returned Behavior is
   * the first one the actor adopts.  Use this to capture `context.self` or spawn
   * children in the "constructor".
   */
  setup<T>(factory: (context: TypedActorContext<T>) => Behavior<T>): Behavior<T> {
    return { kind: 'setup', factory };
  },

  /** Standard receive — gets both context and message. */
  receive<T>(
    handler: (context: TypedActorContext<T>, message: T) => Behavior<T>,
  ): ReceiveBehavior<T> {
    return { kind: 'receive', handler };
  },

  /**
   * Receive with an additional signal handler.
   *
   * The handler belongs to *this* behavior, not to the actor: transitioning to a
   * `receive` that declares none unregisters it, so a state machine that needs
   * `post-stop` cleanup — or wants a watched actor's death as a signal rather
   * than as a message — declares `onSignal` in every state that needs it.  The
   * sentinels are the exception: `Behaviors.stopped` leaves the handler in place,
   * because a `post-stop` handler that stopped working the moment the actor
   * stopped itself would be useless.
   */
  receiveWithSignal<T>(
    handler: (context: TypedActorContext<T>, message: T) => Behavior<T>,
    onSignal: (context: TypedActorContext<T>, signal: Signal) => Behavior<T>,
  ): ReceiveBehavior<T> {
    return { kind: 'receive', handler, onSignal };
  },

  /** Receive when you don't need the context — message-only shortcut. */
  receiveMessage<T>(handler: (message: T) => Behavior<T>): ReceiveBehavior<T> {
    return { kind: 'receive', handler: (_context, message) => handler(message) };
  },

  /** Expose the per-actor TimerScheduler to the behavior. */
  withTimers<T>(factory: (timers: TimerScheduler<T>) => Behavior<T>): Behavior<T> {
    return { kind: 'with-timers', factory };
  },

  /**
   * Expose a capacity-bounded stash buffer.  The inner behavior can stash
   * user messages (e.g. during init) and call `stash.unstashAll()` later.
   *
   * `capacity` must be an integer `>= 1`; `0`, a negative, a fractional value,
   * `NaN` and `Infinity` throw {@link OptionsError} — see
   * {@link assertStashCapacity} for why a bound that never compares true is
   * worse than no bound at all.  The rejection lands here, on the caller's
   * stack while the behavior is still a value, rather than later inside the
   * actor that adopts it.
   */
  withStash<T>(capacity: number, factory: (stash: StashBuffer<T>) => Behavior<T>): Behavior<T> {
    assertStashCapacity(capacity, 'Behaviors.withStash');
    return { kind: 'with-stash', capacity, factory };
  },

  /**
   * Wrap a behavior with a supervisor strategy.  Any error thrown from the
   * wrapped handler is routed through `strategy` — the behavior is restarted
   * (reset to its initial form), stopped, resumed, or escalated.
   *
   * The wrapper **installs a scope that outlives the subtree it wraps**, the
   * same way `intercept` survives its inner behavior's transitions: it
   * contributes its side effect once and the framework remembers the strategy
   * for the actor's lifetime, so a behavior the wrapped one transitions *to* is
   * still supervised.  `Behaviors.stopped` is the way out of a scope; a
   * transition is not.
   *
   * Nesting layers rather than replaces.  In
   * `supervise(supervise(leaf).onFailure(inner)).onFailure(outer)` the innermost
   * strategy decides; `Directive.Escalate` — and a restart budget it has spent —
   * hand the same error to the next scope out, and only falling off the outermost
   * one reaches the actor's cell, where the parent's strategy applies.  A scope a
   * running behavior installs (returning a fresh `supervise(...)` from a handler)
   * nests *inside* the ones already active rather than displacing them.
   *
   * A restart decided by an outer scope re-resolves that scope's own child, which
   * rebuilds the wrappers below it — so the inner scopes come back with a full
   * restart allowance.
   */
  supervise<T>(child: Behavior<T>): SuperviseBuilder<T> {
    return {
      onFailure(strategy: SupervisorStrategy): Behavior<T> {
        return { kind: 'supervise', child, strategy };
      },
    };
  },

  /**
   * Wrap `inner` so `interceptor` runs first on every message.  The interceptor
   * observes, transforms, or drops — it decides whether `inner` runs at all:
   *
   *     const b = Behaviors.intercept(inner, (context, message, next) => {
   *       if (isNoise(message)) return Behaviors.same;   // drop, inner never sees it
   *       return next(context, transform(message));      // transform + delegate
   *     });
   *
   * The wrapper **survives the inner behavior's transitions**: whatever the
   * interceptor returns becomes the new *inner* behavior and is re-wrapped, so
   * an inner `Behaviors.receive` that swaps itself out stays intercepted.  The
   * only way out is `Behaviors.stopped`, where there is nothing left to
   * intercept.
   *
   * Nesting runs outermost-first — in `intercept(intercept(leaf, first), second)`
   * it is `second` that sees the message first, and `first` only runs if
   * `second` delegates.
   *
   * Errors thrown by the interceptor are treated exactly like errors from the
   * inner handler: they reach an enclosing `supervise`.
   *
   * User messages only; lifecycle signals go straight to `receiveWithSignal`'s
   * handler and are not intercepted.
   */
  intercept<T>(inner: Behavior<T>, interceptor: BehaviorInterceptor<T>): Behavior<T> {
    return { kind: 'intercept', inner, interceptor };
  },

  /**
   * Forward every message to `observer` **before** `inner` handles it — a tap
   * for test probes and audit trails:
   *
   *     const probe = kit.createTestProbe();
   *     const monitored = Behaviors.monitor(probe, inner);
   *
   * Forward-then-deliver is the deliberate order: the monitor sees a message
   * even if handling it crashes the actor, which is the case you most want a
   * trace of.  Delivery to the monitor is fire-and-forget and its failures are
   * swallowed — a broken tap must not take the actor down with it.
   */
  monitor<T>(observer: ActorRef<T>, inner: Behavior<T>): Behavior<T> {
    return Behaviors.intercept(inner, (context, message, next) => {
      try { observer.tell(message); } catch { /* a tap never breaks the actor */ }
      return next(context, message);
    });
  },

  /**
   * Log every message before `inner` handles it — `debug` by default:
   *
   *     const traced = Behaviors.logMessages(inner);
   *     const audited = Behaviors.logMessages(inner, {
   *       level: 'info',
   *       formatter: (message) => `order ${message.orderId}`,
   *     });
   *
   * The built-in line is `received <kind>` for the project's tagged messages,
   * falling back to the class name and then to `typeof` — a bare object literal
   * has a `constructor.name` of `Object`, which would say nothing.
   *
   * The line is only built when the actor's logger would actually emit it, so
   * leaving this in place on a system logging at `warn` costs one comparison
   * per message rather than a formatted string.
   */
  logMessages<T>(inner: Behavior<T>, options: LogMessagesOptions<T> = {}): Behavior<T> {
    const level = options.level ?? 'debug';
    const threshold = level === 'info' ? LogLevel.Info : LogLevel.Debug;
    return Behaviors.intercept(inner, (context, message, next) => {
      if (threshold >= context.log.level) context.log[level](logLine(message, options.formatter));
      return next(context, message);
    });
  },

  /*
   * The sentinels answer with their own payload-free type, never `Behavior<T>`
   * for some particular `T`.
   *
   * They used to be typed `Behavior<never>`, on the reasoning that a value
   * carrying no message fits every message type.  That is the wrong direction
   * for this union: `ReceiveBehavior<T>` and friends hold `T` in *parameter*
   * position, so they are contravariant, and `Behavior<never>` is assignable
   * to no other instantiation at all.  Any handler that mixed a real
   * transition with `Behaviors.same` inferred `Behavior<T> | Behavior<never>`
   * and was rejected, which is why callers ended up writing `Behaviors.same as
   * Behavior<T>` per arm, or casting the whole match.
   *
   * `SameBehavior` and the rest are non-generic, so each is a constituent of
   * `Behavior<T>` for *every* `T`: the mixed union now reduces back to
   * `Behavior<T>` by itself and the casts are unnecessary.  Narrowing a return
   * type this way is source-compatible — anything that accepted
   * `Behavior<never>` accepts these.
   */

  /** Sentinel: keep the current behavior. */
  get same(): SameBehavior { return SAME; },

  /** Sentinel: stop the actor. */
  get stopped(): StoppedBehavior { return STOPPED; },

  /** Sentinel: mark the message as unhandled (goes to dead letters). */
  get unhandled(): UnhandledBehavior { return UNHANDLED; },

  /** Sentinel: accept messages but do nothing — useful as a placeholder. */
  get empty(): EmptyBehavior { return EMPTY; },

  /** Sentinel: drop every incoming message silently. */
  get ignore(): IgnoreBehavior { return IGNORE; },
};

/**
 * The line `logMessages` writes.  A custom formatter owns the whole line; a
 * throwing one falls back to the built-in rendering rather than propagating,
 * because a diagnostic that kills the actor it observes is worse than a
 * diagnostic that reads a little worse.
 */
function logLine<T>(message: T, formatter?: (message: T) => string): string {
  if (formatter === undefined) return `received ${describeMessage(message)}`;
  try {
    return formatter(message);
  } catch {
    return `received ${describeMessage(message)} (formatter threw)`;
  }
}

/**
 * A short name for a message.  `kind` first — every message union in this
 * project is discriminated on it, and it is the field a reader scans for.
 * Class instances fall back to their constructor name; `Object` is skipped
 * because it names an object literal without describing it.
 */
function describeMessage(message: unknown): string {
  if (typeof message !== 'object' || message === null) return typeof message;
  const kind = (message as { kind?: unknown }).kind;
  if (typeof kind === 'string') return kind;
  const className = message.constructor?.name;
  return className !== undefined && className !== 'Object' ? className : 'object';
}

/*
 * Re-exports for callers that prefer named imports.  These predate the
 * sentinels being assignable on their own and exist to pin `T` explicitly
 * (`same<string>()`); they no longer need a cast to do it.
 */
export const same = <T>(): Behavior<T> => SAME;
export const stopped = <T>(): Behavior<T> => STOPPED;
export const unhandled = <T>(): Behavior<T> => UNHANDLED;
export const empty = <T>(): Behavior<T> => EMPTY;
export const ignore = <T>(): Behavior<T> => IGNORE;
