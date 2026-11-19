import { Scheduler, type Cancellable } from '../../src/Scheduler.js';

/**
 * The wall-clock scheduler, except that a timer armed at one of the delays a
 * test names is captured instead of armed, so the test fires it at the moment
 * it means — with whatever it chose to queue ahead of it (#1750).
 *
 * Captured by delay rather than by caller because a scheduler cannot see its
 * caller: a test picks a delay nothing else in the system uses (`7_771`, not
 * `50`) and configures the actor under test with it.  Everything else is armed
 * for real, so the cluster the actor needs keeps running.
 */
export class CapturingScheduler extends Scheduler {
  private readonly capturedDelays = new Set<number>();
  private readonly captured = new Map<number, Array<() => void>>();

  /** Capture, rather than arm, every timer armed from here on at `delayMs` — one-shot or fixed-rate. */
  capture(delayMs: number): void { this.capturedDelays.add(delayMs); }

  override scheduleOnceFunction(delayMs: number, task: () => void): Cancellable {
    if (!this.capturedDelays.has(delayMs)) return super.scheduleOnceFunction(delayMs, task);
    return this.hold(delayMs, task);
  }

  override scheduleAtFixedRateFunction(initialDelayMs: number, intervalMs: number, task: () => void): Cancellable {
    if (!this.capturedDelays.has(intervalMs)) {
      return super.scheduleAtFixedRateFunction(initialDelayMs, intervalMs, task);
    }
    return this.hold(intervalMs, task);
  }

  /** How many timers have been captured at `delayMs` so far, cancelled ones included. */
  capturedAt(delayMs: number): number { return this.captured.get(delayMs)?.length ?? 0; }

  /**
   * Fire the most recently captured timer at `delayMs`, exactly as it would
   * have fired itself — synchronously, from outside any actor's turn.
   */
  fire(delayMs: number): void {
    const tasks = this.captured.get(delayMs) ?? [];
    const task = tasks[tasks.length - 1];
    if (task === undefined) throw new Error(`no timer was captured at ${delayMs} ms`);
    task();
  }

  private hold(delayMs: number, task: () => void): Cancellable {
    const tasks = this.captured.get(delayMs) ?? [];
    tasks.push(task);
    this.captured.set(delayMs, tasks);
    let cancelled = false;
    return {
      cancel: (): boolean => {
        if (cancelled) return false;
        cancelled = true;
        return true;
      },
      get isCancelled(): boolean { return cancelled; },
    };
  }
}
