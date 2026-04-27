import type { ActorRef } from '../ActorRef.js';
import { Scheduler, type Cancellable } from '../Scheduler.js';

interface Task {
  id: number;
  fireAt: number;
  fn: () => void;
  cancelled: boolean;
  /** If set, the task re-enqueues itself after firing. */
  repeat?: { intervalMs: number };
}

/**
 * Scheduler implementation driven entirely by `advance(ms)` — the wall
 * clock is ignored.  Swap this into `ActorSystem.create(name, { scheduler })`
 * in tests to get deterministic timer behaviour.
 */
export class ManualScheduler extends Scheduler {
  private _now = 0;
  private tasks: Task[] = [];
  private idCounter = 0;
  private stopped = false;

  /* -------------------------- Scheduler API overrides -------------------------- */

  override scheduleOnceFn(delayMs: number, fn: () => void): Cancellable {
    return this.add({ fireAt: this._now + delayMs, fn });
  }

  override scheduleOnce<T>(
    delayMs: number,
    target: ActorRef<T>,
    message: T,
    sender: ActorRef | null = null,
  ): Cancellable {
    return this.add({
      fireAt: this._now + delayMs,
      fn: () => target.tell(message, sender),
    });
  }

  override scheduleAtFixedRateFn(
    initialDelayMs: number,
    intervalMs: number,
    fn: () => void,
  ): Cancellable {
    return this.add({
      fireAt: this._now + initialDelayMs,
      fn,
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
      fn: () => target.tell(message, sender),
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
      try { next.fn(); } catch (e) {
        // Mirror the real scheduler: log, do not propagate.
        console.error('[ManualScheduler] task threw:', e);
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
    for (const t of this.tasks) {
      if (t.cancelled || t.fireAt > upTo) continue;
      if (!best || t.fireAt < best.fireAt || (t.fireAt === best.fireAt && t.id < best.id)) best = t;
    }
    return best;
  }

  private peekAny(): Task | null {
    let best: Task | null = null;
    for (const t of this.tasks) {
      if (t.cancelled) continue;
      if (!best || t.fireAt < best.fireAt || (t.fireAt === best.fireAt && t.id < best.id)) best = t;
    }
    return best;
  }

  private pruneCancelled(): void {
    this.tasks = this.tasks.filter(t => !t.cancelled);
  }
}
