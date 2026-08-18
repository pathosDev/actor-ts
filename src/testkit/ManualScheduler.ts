import type { ActorRef } from '../ActorRef.js';
import { LogContext } from '../LogContext.js';
import { Scheduler, type Cancellable } from '../Scheduler.js';

type Task = {
  id: number;
  fireAt: number;
  run: () => void;
  cancelled: boolean;
  /** If set, the task re-enqueues itself after firing. */
  repeat?: { intervalMs: number };
};

/**
 * Scheduler implementation driven entirely by `advance(ms)` — the wall
 * clock is ignored.  Swap this into
 * `ActorSystem.create(name, ActorSystemOptions.create().withScheduler(scheduler))`
 * in tests to get deterministic timer behaviour.
 */
export class ManualScheduler extends Scheduler {
  private _now = 0;
  private tasks: Task[] = [];
  private idCounter = 0;
  private stopped = false;

  /* -------------------------- Scheduler API overrides -------------------------- */

  override scheduleOnceFunction(delayMs: number, task: () => void): Cancellable {
    return this.add({ fireAt: this._now + delayMs, run: task });
  }

  override scheduleOnce<T>(
    delayMs: number,
    target: ActorRef<T>,
    message: T,
    sender: ActorRef | null = null,
  ): Cancellable {
    return this.add({
      fireAt: this._now + delayMs,
      run: () => target.tell(message, sender),
    });
  }

  override scheduleAtFixedRateFunction(
    initialDelayMs: number,
    intervalMs: number,
    task: () => void,
  ): Cancellable {
    return this.add({
      fireAt: this._now + initialDelayMs,
      run: task,
      repeat: { intervalMs },
    });
  }

  override scheduleAtFixedRate<T>(
    initialDelayMs: number,
    intervalMs: number,
    target: ActorRef<T>,
    message: T,
    sender: ActorRef | null = null,
  ): Cancellable {
    return this.add({
      fireAt: this._now + initialDelayMs,
      run: () => target.tell(message, sender),
      repeat: { intervalMs },
    });
  }

  override shutdown(): void {
    this.stopped = true;
    this.tasks = [];
  }

  /* --------------------------- Virtual-time controls --------------------------- */

  /** Current virtual time in ms (monotonic, advances only via `advance`). */
  now(): number { return this._now; }

  /** Number of scheduled non-cancelled tasks. */
  get pendingCount(): number {
    return this.tasks.filter(t => !t.cancelled).length;
  }

  /**
   * Advance virtual time by `ms`.  Any timers whose `fireAt` falls inside
   * the advanced range fire in deterministic order (earliest first, ties
   * broken by insertion order).
   */
  advance(ms: number): void {
    if (this.stopped) return;
    const target = this._now + ms;
    while (true) {
      const next = this.peekNext(target);
      if (!next) break;
      this._now = next.fireAt;
      // Mirror the real scheduler in all three respects: a fired task runs
      // with the MDC cleared (#718 — here it would otherwise inherit whatever
      // store `advance()` was called from, which is the same defect one layer
      // up), a throwing task is reported rather than propagated, and the
      // report goes through the inherited `onError` sink so a system that
      // took this scheduler through `ActorSystemOptions.withScheduler` sees
      // the failure on its logger and its event stream (#678).  Every
      // scheduling method here is an override, so `Scheduler.runGuarded`
      // never runs on this path — without this call the testkit would keep
      // the raw-console behaviour the framework just abandoned, and a double
      // that diverges from the real scheduler is a double that lets a
      // regression pass.
      try { LogContext.runFresh(next.run); } catch (e) {
        this.reportTaskError(e);
      }
      if (next.repeat) {
        next.fireAt = this._now + next.repeat.intervalMs;
      } else {
        next.cancelled = true;
      }
      this.pruneCancelled();
    }
    this._now = target;
    this.pruneCancelled();
  }

  /** Jump directly to the time of the next pending task (or no-op if none). */
  advanceToNext(): void {
    const next = this.peekAny();
    if (next) this.advance(Math.max(0, next.fireAt - this._now));
  }

  /* ---------------------------------- Internals --------------------------------- */

  private add(partial: Omit<Task, 'id' | 'cancelled'>): Cancellable {
    if (this.stopped) {
      return { cancel: () => false, isCancelled: true };
    }
    const task: Task = { id: ++this.idCounter, cancelled: false, ...partial };
    this.tasks.push(task);
    return {
      cancel: () => {
        if (task.cancelled) return false;
        task.cancelled = true;
        return true;
      },
      get isCancelled() { return task.cancelled; },
    };
  }

  private peekNext(upTo: number): Task | null {
    let best: Task | null = null;
    for (const task of this.tasks) {
      if (task.cancelled || task.fireAt > upTo) continue;
      if (!best || task.fireAt < best.fireAt || (task.fireAt === best.fireAt && task.id < best.id)) best = task;
    }
    return best;
  }

  private peekAny(): Task | null {
    let best: Task | null = null;
    for (const task of this.tasks) {
      if (task.cancelled) continue;
      if (!best || task.fireAt < best.fireAt || (task.fireAt === best.fireAt && task.id < best.id)) best = task;
    }
    return best;
  }

  private pruneCancelled(): void {
    this.tasks = this.tasks.filter(t => !t.cancelled);
  }
}
