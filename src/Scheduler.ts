import type { ActorRef } from './ActorRef.js';
import { LogContext } from './LogContext.js';

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
 * Time-based scheduler — a thin wrapper over `setTimeout` / `setInterval`,
 * accurate enough for typical use and good enough for tests.  Inject a
 * `ManualScheduler` from the TestKit when you want fully deterministic
 * time advancement.
 */
export class Scheduler {
  private _cancelled = false;

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
    return this.oneShot(delayMs, () => runGuarded(task));
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
    return this.fixedRate(initialDelayMs, intervalMs, () => runGuarded(task));
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

  private oneShot(delayMs: number, run: () => void): Cancellable {
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
      intervalHandle = setInterval(() => {
        if (cancellable.isCancelled || this._cancelled) return;
        this.fireCleared(run);
      }, intervalMs);
    }, initialDelayMs);
    return cancellable;
  }
}

function runGuarded(task: () => void): void {
  try {
    task();
  } catch (e) {
    console.error('[actor-ts] scheduler error:', e);
  }
}
