import type { ActorRef } from './ActorRef.js';

/** A handle that lets callers cancel a scheduled task. */
export interface Cancellable {
  cancel(): boolean;
  readonly isCancelled: boolean;
}

class SimpleCancellable implements Cancellable {
  private _cancelled = false;
  constructor(private readonly onCancel: () => void) {}
  cancel(): boolean {
    if (this._cancelled) return false;
    this._cancelled = true;
    this.onCancel();
    return true;
  }
  get isCancelled(): boolean { return this._cancelled; }
}

/**
 * Time-based scheduler — a thin wrapper over `setTimeout` / `setInterval`,
 * accurate enough for typical use and good enough for tests.  Inject a
 * `ManualScheduler` from the TestKit when you want fully deterministic
 * time advancement.
 */
export class Scheduler {
  private _cancelled = false;

  /** Deliver a message once after a delay. */
  scheduleOnce<T>(
    delayMs: number,
    target: ActorRef<T>,
    message: T,
    sender: ActorRef | null = null,
  ): Cancellable {
    let handle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      handle = null;
      if (!this._cancelled) target.tell(message, sender);
    }, delayMs);
    return new SimpleCancellable(() => {
      if (handle) { clearTimeout(handle); handle = null; }
    });
  }

  /** Run a user-supplied function once after a delay. */
  scheduleOnceFunction(delayMs: number, fn: () => void): Cancellable {
    let handle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      handle = null;
      if (!this._cancelled) {
        try { fn(); } catch (e) { console.error('[actor-ts] scheduler error:', e); }
      }
    }, delayMs);
    return new SimpleCancellable(() => {
      if (handle) { clearTimeout(handle); handle = null; }
    });
  }

  /** Deliver a message repeatedly at a fixed interval, after an initial delay. */
  scheduleAtFixedRate<T>(
    initialDelayMs: number,
    intervalMs: number,
    target: ActorRef<T>,
    message: T,
    sender: ActorRef | null = null,
  ): Cancellable {
    let stopped = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let intervalHandle: ReturnType<typeof setInterval> | null = null;

    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      if (stopped || this._cancelled) return;
      target.tell(message, sender);
      intervalHandle = setInterval(() => {
        if (stopped || this._cancelled) return;
        target.tell(message, sender);
      }, intervalMs);
    }, initialDelayMs);

    return new SimpleCancellable(() => {
      stopped = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (intervalHandle) clearInterval(intervalHandle);
    });
  }

  scheduleAtFixedRateFunction(
    initialDelayMs: number,
    intervalMs: number,
    fn: () => void,
  ): Cancellable {
    let stopped = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let intervalHandle: ReturnType<typeof setInterval> | null = null;
    const run = () => {
      if (stopped || this._cancelled) return;
      try { fn(); } catch (e) { console.error('[actor-ts] scheduler error:', e); }
    };
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      run();
      intervalHandle = setInterval(run, intervalMs);
    }, initialDelayMs);
    return new SimpleCancellable(() => {
      stopped = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (intervalHandle) clearInterval(intervalHandle);
    });
  }

  /** @internal Called by the system when terminating. */
  shutdown(): void { this._cancelled = true; }
}
