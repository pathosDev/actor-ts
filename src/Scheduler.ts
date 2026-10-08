import type { ActorRef } from './ActorRef.js';
import type { Clock } from './Clock.js';
import { LogContext } from './LogContext.js';
import { MAX_TIMER_DELAY_MS } from './util/Constants.js';

/**
 * Where the scheduler reports a scheduled task that threw.
 *
 * A `Scheduler` cannot reach the system logger on its own, and the reason is
 * construction order rather than ownership: `ActorSystem` builds the scheduler
 * *before* the logger, because a log sink's flush ticker is armed on the
 * scheduler (`BatchingSink`) and therefore needs one to already exist.  So the
 * logger cannot be a constructor parameter, and the sink is a slot the owner
 * fills in afterwards — `ActorSystem` assigns one once both exist, and
 * everything the framework reports about a failed task flows through that
 * assignment (#678).
 *
 * The error and nothing else.  `DispatcherErrorSink` carries a `dispatcherId`
 * because a system has many dispatchers and a report has to say which one
 * failed; a system has exactly one scheduler, and the task itself is an
 * anonymous closure the scheduler never had a name for.  Inventing an
 * identifier here would mean inventing one at every call site too.
 */
export type SchedulerErrorSink = (error: unknown) => void;

/** A handle that lets callers cancel a scheduled task. */
export interface Cancellable {
  /**
   * Cancel the schedule.  `true` when this call did the cancelling, `false`
   * when there was nothing left to cancel — already cancelled, or a one-shot
   * that has already fired.
   */
  cancel(): boolean;
  /**
   * Whether the schedule is finished: cancelled, or — for a one-shot — fired.
   * A repeating schedule is only finished once it is cancelled.
   */
  readonly isCancelled: boolean;
}

class SimpleCancellable implements Cancellable {
  private _settled = false;
  constructor(private readonly onCancel: () => void) {}

  cancel(): boolean {
    if (this._settled) return false;
    this._settled = true;
    this.onCancel();
    return true;
  }

  /**
   * @internal Mark a one-shot as finished because it fired, without running
   * the cancel action — there is no native handle left to clear.  Without
   * this the handle reports itself schedulable forever: `isCancelled` stays
   * false, `cancel()` claims to have cancelled something that already ran,
   * and per-actor timer maps keyed on these never shed an entry (#642).
   */
  _settle(): void { this._settled = true; }

  get isCancelled(): boolean { return this._settled; }
}

/**
 * @internal The host's timer primitives, as far as a chained schedule needs
 * them.
 *
 * A seam rather than the globals for one reason: a link of a chain is 24.9
 * days long, so a test hands {@link Scheduler} a set that runs on virtual time
 * instead of waiting for one.  Only the chained path arms through it.  A delay
 * at or below the ceiling still calls the runtime's `setTimeout` and
 * `setInterval` directly, because that path runs under every actor timer and
 * a seam there would be an indirection on every arm, paid for a property only
 * the chain has.
 */
export interface HostTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

/**
 * The runtime's own primitives, looked up when a link is armed rather than
 * captured when this module loads, so a test that substitutes a global sees
 * the chained path reach it exactly as the direct path does.
 */
const runtimeHostTimers: HostTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => { clearInterval(handle as ReturnType<typeof setInterval>); },
};

/** `handle`, after asking the runtime not to stay alive for it alone. */
function unreferenced<T>(handle: T): T {
  (handle as unknown as { unref?: () => void }).unref?.();
  return handle;
}

/**
 * @internal {@link runtimeHostTimers} with each handle unreferenced as it is
 * armed: what a chain is armed over where a pending timer must never keep the
 * process alive on its own.
 *
 * Below the ceiling those sites arm one unreferenced host timer (the
 * `InMemoryCache` sweep, an `HttpClient` deadline), and a chain of ordinary
 * links would undo exactly that, 24.9 days at a time.  One set here rather
 * than a copy at each site, because two copies of a primitive drift apart.
 */
export const unreferencedHostTimers: HostTimers = {
  setTimeout: (callback, delayMs) => unreferenced(setTimeout(callback, delayMs)),
  clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
  setInterval: (callback, intervalMs) => unreferenced(setInterval(callback, intervalMs)),
  clearInterval: (handle) => { clearInterval(handle as ReturnType<typeof setInterval>); },
};

/**
 * A one-shot armed as a chain of host timers, none longer than
 * {@link MAX_TIMER_DELAY_MS}, so a delay past that ceiling waits the whole of
 * it.
 *
 * The links are counted down rather than measured: each one subtracts its own
 * length from what is left, so the armed total is exactly the requested delay
 * and no clock is read.  What a chain adds is the lateness of every link
 * rather than of one — at most two links for anything under 49.7 days, against
 * a delay of weeks.  A delay that never runs out (`Infinity`) re-arms a
 * ceiling-long link for as long as nobody cancels it, which is what it says.
 */
class ChainedTimeout implements Cancellable {
  private remainingMs: number;
  private handle: unknown = null;
  private settled = false;

  constructor(
    private readonly callback: () => void,
    delayMs: number,
    private readonly hostTimers: HostTimers,
  ) {
    this.remainingMs = delayMs;
    this.armNextLink();
  }

  /**
   * Clears whichever link is armed at the moment of the call.  A cancel that
   * reached only the first link would leave the rest of the chain to fire up to
   * 24.9 days after it was cancelled — the property every owner of one is
   * relying on.
   */
  cancel(): boolean {
    if (this.settled) return false;
    this.settled = true;
    this.hostTimers.clearTimeout(this.handle);
    this.handle = null;
    return true;
  }

  get isCancelled(): boolean { return this.settled; }

  private armNextLink(): void {
    const linkMs = Math.min(this.remainingMs, MAX_TIMER_DELAY_MS);
    this.remainingMs -= linkMs;
    this.handle = this.hostTimers.setTimeout(this.onLinkElapsed, linkMs);
  }

  private readonly onLinkElapsed = (): void => {
    this.handle = null;
    if (this.remainingMs > 0) {
      this.armNextLink();
      return;
    }
    this.settled = true;
    this.callback();
  };
}

/**
 * @internal Arm `callback` to run once after `delayMs`, for a delay longer
 * than one host timer holds.
 *
 * `setTimeout` cannot hold a delay above {@link MAX_TIMER_DELAY_MS} (~24.9
 * days) and fires it early instead of refusing it: Bun and Node arm it as 1 ms
 * behind a `TimeoutOverflowWarning`, Deno wraps it modulo 2^32 without a word —
 * 2^31 ms fires at once there, 2^32 + 300 ms after 300 ms (bun 1.4.2, node
 * 26.10, deno 2.6.8).  `retry` clamps to the ceiling (#771) and the HTTP server
 * refuses deadlines past it; a scheduled task, an `ask` deadline or an
 * `HttpClient` deadline may be any length a caller asks for, so neither answer
 * fits there.  Clamping would fire weeks early, refusing would break calls that
 * work today, and a chain is the one shape that does what was asked.
 *
 * Returns a {@link Cancellable}, which is also what lets `AskResponseRef` hold
 * one in the slot it keeps for a scheduler's handle.  Not on any barrel: its
 * callers are the scheduler, the `ask` deadline, `after()` without a
 * scheduler, `gracefulStop`'s budget for a ref it cannot watch, the
 * `InMemoryCache` sweep, a persistent actor's recovery deadline and an
 * `HttpClient` deadline.
 */
export function armChainedTimeout(
  callback: () => void,
  delayMs: number,
  hostTimers: HostTimers = runtimeHostTimers,
): Cancellable {
  return new ChainedTimeout(callback, delayMs, hostTimers);
}

/**
 * Time-based scheduler — a thin wrapper over `setTimeout` / `setInterval`,
 * accurate enough for typical use and good enough for tests.  Inject a
 * `ManualScheduler` from the TestKit when you want fully deterministic
 * time advancement.  A delay longer than one host timer holds (~24.9 days) is
 * armed as a chain of them, so it waits as long as it says
 * ({@link armChainedTimeout}).
 *
 * It is also the system's {@link Clock}, and the two belong together for a
 * reason: a component that arms a timer almost always also asks what time it
 * is, and if those answers come from different sources the timer and the
 * reading disagree.  That was the state before this — ticks ran through a
 * `ManualScheduler` while the code they drove read `Date.now()`, so a hundred
 * advanced ticks all landed on the same real instant.
 */
export class Scheduler implements Clock {
  private _cancelled = false;

  /**
   * @param hostTimers @internal What a schedule longer than one host timer
   *   holds is chained over — the runtime's own unless a test substitutes a
   *   virtual set.  See {@link HostTimers} for why nothing else arms through
   *   it.
   */
  constructor(private readonly hostTimers: HostTimers = runtimeHostTimers) {}

  /**
   * The wall clock.  `ManualScheduler` overrides it with virtual time, which is
   * what makes handing a component `system.clock` enough to make it testable.
   */
  now(): number { return Date.now(); }

  /**
   * Does time here move only when someone advances it?
   *
   * Asked by the few places that would otherwise arm a raw `setTimeout` on a
   * path hot enough to care.  Routing a deadline through a scheduler buys
   * exactly one thing — a test can advance past it — and a wall-clock scheduler
   * cannot offer that, so where the answer is `false` those places keep the
   * host timer.
   *
   * Measured rather than assumed: arming every `ask` deadline through
   * {@link scheduleOnceFunction} costs ~13% of `ask-throughput` (195k -> 170k
   * ask/s, p50 2.8 -> 3.1 µs) for the `SimpleCancellable`, the {@link live} Set
   * insert and delete, and the guarded closure.  Keeping the dispatch but
   * bypassing the scheduler restores the figure exactly, which is what isolates
   * the cost to this path rather than to the lookup that reaches it.
   */
  get isVirtual(): boolean { return false; }

  /**
   * Where a scheduled task that threw is reported.  Optional so that a
   * scheduler stays usable with no system at all — a bare `new Scheduler()`
   * in a test, or one constructed before `ActorSystem.create` returns — and
   * an unset sink falls back to `console.error`, which is what every
   * scheduler did before the slot existed.
   *
   * `ActorSystem` fills it in with `??=`, so a sink the owner set
   * deliberately survives being handed to a system through
   * `ActorSystemOptions.withScheduler`.
   */
  onError?: SchedulerErrorSink;

  /**
   * Every schedule that still owns a native handle.
   *
   * `shutdown()` used to set a flag and stop there, which makes callbacks
   * no-ops but leaves the underlying timers armed — and an armed
   * `setInterval` holds the event loop open, so a terminated `ActorSystem`
   * kept the whole process alive (#641).  A flag cannot clear a handle that
   * exists only inside a closure, so the closures register themselves here.
   */
  private readonly live = new Set<SimpleCancellable>();

  /** Deliver a message once after a delay. */
  scheduleOnce<T>(
    delayMs: number,
    target: ActorRef<T>,
    message: T,
    sender: ActorRef | null = null,
  ): Cancellable {
    return this.oneShot(delayMs, () => target.tell(message, sender));
  }

  /** Run a user-supplied function once after a delay. */
  scheduleOnceFunction(delayMs: number, task: () => void): Cancellable {
    return this.oneShot(delayMs, () => this.runGuarded(task));
  }

  /** Deliver a message repeatedly at a fixed interval, after an initial delay. */
  scheduleAtFixedRate<T>(
    initialDelayMs: number,
    intervalMs: number,
    target: ActorRef<T>,
    message: T,
    sender: ActorRef | null = null,
  ): Cancellable {
    return this.fixedRate(initialDelayMs, intervalMs, () => target.tell(message, sender));
  }

  scheduleAtFixedRateFunction(
    initialDelayMs: number,
    intervalMs: number,
    task: () => void,
  ): Cancellable {
    return this.fixedRate(initialDelayMs, intervalMs, () => this.runGuarded(task));
  }

  /**
   * @internal Called by the system when terminating.  Clears every armed
   * handle rather than only suppressing its callback, so nothing is left
   * holding the event loop open.
   */
  shutdown(): void {
    this._cancelled = true;
    // Copy first: `cancel()` removes the entry via `track`'s closure.
    for (const cancellable of [...this.live]) cancellable.cancel();
    this.live.clear();
  }

  /* --------------------------- internals -------------------------------- */

  private track(onCancel: () => void): SimpleCancellable {
    const cancellable: SimpleCancellable = new SimpleCancellable(() => {
      this.live.delete(cancellable);
      onCancel();
    });
    this.live.add(cancellable);
    return cancellable;
  }

  private settle(cancellable: SimpleCancellable): void {
    this.live.delete(cancellable);
    cancellable._settle();
  }

  /**
   * Run one fired schedule with the MDC of whoever armed it left behind.
   *
   * `AsyncLocalStorage` binds a store when the timer is *created*, so a
   * schedule armed from inside a request's `LogContext.run` scope fires under
   * that request's context — for the whole life of a `setInterval`, which is
   * the process lifetime for anything armed in `preStart`.  The callback then
   * either `tell`s (and `LocalActorRef.tell` re-stamps the inherited context
   * onto the envelope, so it travels downstream and over the wire) or runs a
   * user task whose log lines claim a request that ended long ago (#718).
   *
   * A fired schedule belongs to nobody: the arming request is over, and the
   * tick serves whoever comes next.  So this is exactly the seam
   * {@link LogContext.runFresh} documents, and clearing fails safe — a field
   * nobody set cannot leak.  A caller who genuinely wants the arming context
   * on its ticks says so, by capturing `LogContext.snapshot()` at arm time and
   * reopening it inside the task.
   *
   * The clear sits here rather than at the four public entry points so that
   * every schedule gets it — the two message forms *and* the two bare-function
   * forms, which never pass through an `ActorCell` and would otherwise stay
   * leaking whatever the delivery side does.
   */
  private fireCleared(run: () => void): void {
    LogContext.runFresh(run);
  }

  /**
   * Run a user-supplied task, reporting a throw instead of letting it escape.
   *
   * Escaping matters twice over: the task runs inside a bare `setTimeout` /
   * `setInterval` callback, so a throw is an uncaught exception with no
   * supervisor above it, and on a repeating schedule it would also be the
   * last tick.  A method rather than the module-level function it used to be,
   * because the report now needs `this` to reach {@link onError}.
   */
  private runGuarded(task: () => void): void {
    try {
      task();
    } catch (error) {
      this.reportTaskError(error);
    }
  }

  /**
   * Report a task that threw through {@link onError}, or — when nothing wired
   * a sink, and only then — on the console.
   *
   * The console branch is the documented last resort, not a second channel.
   * It exists because a scheduler is usable without a system at all, and a
   * failure that reaches nobody is worse than one that reaches a terminal.
   * The sink is called inside its own guard for the same reason: a sink that
   * throws has destroyed the only report of the original error, so the
   * fallback takes over and prints what the sink was handed.  The sink's own
   * failure is printed *after* it — an operator who wired a sink and sees
   * console output anyway is owed the reason, but the original error is still
   * the one nobody else is holding.
   *
   * `protected` rather than private because the TestKit's `ManualScheduler`
   * overrides every scheduling entry point and so never reaches
   * {@link runGuarded}.  It catches in `advance()` instead and has to be able
   * to reach the same report; otherwise a system built with
   * `ActorSystemOptions.withScheduler(new ManualScheduler())` would keep
   * exactly the behaviour this replaces, and `src/testkit/` is shipped
   * surface rather than in-repo scaffolding.
   */
  protected reportTaskError(error: unknown): void {
    const sink = this.onError;
    if (sink === undefined) {
      console.error('[actor-ts] unhandled scheduler error:', error);
      return;
    }
    try {
      sink(error);
    } catch (sinkFailure) {
      console.error('[actor-ts] unhandled scheduler error:', error);
      console.error('[actor-ts] the scheduler error sink failed too:', sinkFailure);
    }
  }

  private oneShot(delayMs: number, run: () => void): Cancellable {
    // The one comparison the path below pays for the chain; everything after
    // it is the code every actor timer has always run.
    if (delayMs > MAX_TIMER_DELAY_MS) return this.chainedOneShot(delayMs, run);
    let handle: ReturnType<typeof setTimeout> | null = null;
    const cancellable = this.track(() => {
      if (handle !== null) { clearTimeout(handle); handle = null; }
    });
    handle = setTimeout(() => {
      handle = null;
      // Settle before running: the schedule is over either way, and `run`
      // may itself schedule, cancel, or throw.
      this.settle(cancellable);
      if (!this._cancelled) this.fireCleared(run);
    }, delayMs);
    return cancellable;
  }

  private fixedRate(initialDelayMs: number, intervalMs: number, run: () => void): Cancellable {
    if (initialDelayMs > MAX_TIMER_DELAY_MS || intervalMs > MAX_TIMER_DELAY_MS) {
      return this.chainedFixedRate(initialDelayMs, intervalMs, run);
    }
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let intervalHandle: ReturnType<typeof setInterval> | null = null;
    const cancellable = this.track(() => {
      if (timeoutHandle !== null) { clearTimeout(timeoutHandle); timeoutHandle = null; }
      if (intervalHandle !== null) { clearInterval(intervalHandle); intervalHandle = null; }
    });
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      if (cancellable.isCancelled || this._cancelled) return;
      this.fireCleared(run);
      // Re-checked after the first tick, because `run` may have cancelled its
      // own handle — the seed-retry tick in `Cluster` does exactly that the
      // moment the node is `up`.  That cancel settles the cancellable and
      // drops it from `live` while `intervalHandle` is still `null`, so an
      // interval armed here anyway would be one that neither `cancel()` nor
      // `shutdown()` can ever reach: a referenced timer firing into an early
      // return for the life of the process, holding the event loop open
      // after every system has terminated (#1567).
      if (cancellable.isCancelled || this._cancelled) return;
      intervalHandle = setInterval(() => {
        if (cancellable.isCancelled || this._cancelled) return;
        this.fireCleared(run);
      }, intervalMs);
    }, initialDelayMs);
    return cancellable;
  }

  /**
   * {@link oneShot} for a delay no single host timer holds; see
   * {@link armChainedTimeout} for why a chain.
   *
   * The whole chain is one entry in {@link live}, so `cancel()` and
   * `shutdown()` reach whichever link is armed when they run, and a link
   * elapsing on the way neither fires nor settles the schedule.
   */
  private chainedOneShot(delayMs: number, run: () => void): Cancellable {
    let chain: Cancellable | null = null;
    const cancellable = this.track(() => {
      if (chain !== null) { chain.cancel(); chain = null; }
    });
    chain = armChainedTimeout(() => {
      chain = null;
      this.settle(cancellable);
      if (!this._cancelled) this.fireCleared(run);
    }, delayMs, this.hostTimers);
    return cancellable;
  }

  /**
   * {@link fixedRate} where the initial delay or the interval is past the
   * ceiling.  `setInterval` treats its period exactly as `setTimeout` treats a
   * delay, so an interval past it ran as a ~1 ms loop on Bun and Node, for the
   * life of the schedule.
   *
   * Such an interval is a chained one-shot per period, re-armed after each
   * tick.  The period then stretches by the tick's own run time, which is
   * nothing against 24.9 days and is why an interval that fits one host timer
   * still gets the host's own repeat once a long initial delay has run out.
   * The re-check after the tick is the one {@link fixedRate} carries, for the
   * same reason (#1567).
   */
  private chainedFixedRate(initialDelayMs: number, intervalMs: number, run: () => void): Cancellable {
    const hostTimers = this.hostTimers;
    let chain: Cancellable | null = null;
    let intervalHandle: unknown = null;
    const cancellable = this.track(() => {
      if (chain !== null) { chain.cancel(); chain = null; }
      if (intervalHandle !== null) { hostTimers.clearInterval(intervalHandle); intervalHandle = null; }
    });
    const tick = (): void => {
      chain = null;
      if (cancellable.isCancelled || this._cancelled) return;
      this.fireCleared(run);
      if (cancellable.isCancelled || this._cancelled) return;
      if (intervalMs > MAX_TIMER_DELAY_MS) {
        chain = armChainedTimeout(tick, intervalMs, hostTimers);
        return;
      }
      intervalHandle = hostTimers.setInterval(() => {
        if (cancellable.isCancelled || this._cancelled) return;
        this.fireCleared(run);
      }, intervalMs);
    };
    chain = armChainedTimeout(tick, initialDelayMs, hostTimers);
    return cancellable;
  }
}
