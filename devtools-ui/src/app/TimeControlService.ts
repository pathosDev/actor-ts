import { DestroyRef, Injectable, computed, inject, signal, type Signal } from '@angular/core';

import { frozenNow } from '../core/timeControl.js';

/**
 * How often the shared clock advances.
 *
 * One second, because every reading it drives is a duration rendered to the
 * second — uptime, "stopped 12s ago", "last answered 3 min ago".
 */
const CLOCK_INTERVAL_MS = 1_000;

/**
 * Whether time is running, and what time it is (#1349).
 *
 * The panels used to each keep their own `Date.now()` signal and their own
 * one-second interval.  They now share this one, which is what makes a
 * pause mean anything: freezing delivery alone would still leave the actors
 * panel sweeping its tombstones away against the wall clock, thirty seconds
 * after the reader paused specifically to look at one.
 *
 * Two clocks, deliberately:
 *
 * - {@link now} is the one the panels read.  It stops while paused, so every
 *   "how long ago" reading in the UI holds still with the data it describes.
 * - {@link wallClock} never stops.  The shell's offline detection reads it,
 *   because a connection that dies during a pause still has to be announced
 *   — a dead node that reads as a paused one is the worst outcome here.
 */
@Injectable({ providedIn: 'root' })
export class TimeControlService {
  private readonly wall = signal(Date.now());
  private readonly pausedAt = signal<number | null>(null);

  /** Real time, always advancing.  For anything a pause must not hide. */
  readonly wallClock: Signal<number> = this.wall.asReadonly();

  /** When the reader stopped time, or `null` while it runs. */
  readonly pausedAtMs: Signal<number | null> = this.pausedAt.asReadonly();

  readonly paused: Signal<boolean> = computed(() => this.pausedAt() !== null);

  /**
   * The clock the panels read instead of `Date.now()`.
   *
   * Frozen at the moment of the pause, so a view and the durations printed
   * over it describe the same instant.
   */
  readonly now: Signal<number> = computed(() => this.pausedAt() ?? this.wall());

  /**
   * How long time has been stopped, for the header reading.  0 while running.
   *
   * The tick is what makes this recompute; the VALUE comes from the real clock
   * rather than from the ticked signal.  The two differ because a browser
   * throttles a hidden tab's intervals to roughly once a minute — reading the
   * signal itself had the header claim 29 seconds after 50 had passed.  That
   * is why the constructor also refreshes the clock on `visibilitychange`:
   * without it this stays at whatever it last computed, which for a tab left
   * on a paused view is the reading it had milliseconds after the click.
   */
  readonly pausedForMs: Signal<number> = computed(() => {
    const since = this.pausedAt();
    if (since === null) return 0;
    this.wall();
    return Math.max(0, Date.now() - since);
  });

  constructor() {
    const clock = setInterval(() => this.wall.set(Date.now()), CLOCK_INTERVAL_MS);
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => clearInterval(clock));

    // Coming back to the tab corrects every duration on screen at once.
    // A hidden tab's interval is throttled to about once a minute, so without
    // this the first thing a returning reader sees is a set of readings frozen
    // wherever the throttle left them — and on a paused view, the one reading
    // they are most likely to check is how long it has been paused.
    const refresh = (): void => this.wall.set(Date.now());
    document.addEventListener('visibilitychange', refresh);
    destroyRef.onDestroy(() => document.removeEventListener('visibilitychange', refresh));
  }

  /**
   * The frozen clock, imperatively.
   *
   * For the folding paths (`touch`) that need a timestamp outside a reactive
   * context.  Reads through to the real clock while running, so a caller
   * cannot accidentally get a value a whole tick stale.
   */
  nowMs(): number {
    return frozenNow(this.pausedAt());
  }

  pause(): void {
    if (this.pausedAt() !== null) return;
    const at = Date.now();
    // Advance the wall clock in the same breath, so `pausedForMs` starts at 0
    // rather than at however far into the current tick the click landed.
    this.wall.set(at);
    this.pausedAt.set(at);
  }

  resume(): void {
    if (this.pausedAt() === null) return;
    this.pausedAt.set(null);
    this.wall.set(Date.now());
  }

  toggle(): void {
    if (this.pausedAt() === null) this.pause();
    else this.resume();
  }
}
