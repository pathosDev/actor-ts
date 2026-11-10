/**
 * The time a component reads, as a contract rather than a global.
 *
 * `ManualScheduler` has had virtual time since the TestKit existed, and almost
 * nothing in the framework could see it.  `Scheduler` exposed no `now()` at
 * all, so every component that needed the time read `Date.now()` for itself —
 * 213 sites across 87 files when this contract was introduced.  The result was
 * a **mixed clock**: gossip, heartbeat and failure-detection ticks all run
 * through `system.scheduler`, so a `ManualScheduler` drives them, but the
 * failure detector took no `now` and read the wall clock, so advancing virtual
 * time by a hundred ticks fired a hundred heartbeats that all arrived at the
 * same real instant.  A detector handed a hundred samples with zero elapsed
 * time between them concludes nothing, and a test meaning "this peer went quiet
 * for a minute" had no way to say so.
 *
 * One method, deliberately.  A clock answers what time it is; scheduling work
 * *at* a time is {@link Scheduler}, which implements this and is therefore the
 * one object a component needs for both.  Keeping them separate in the type
 * lets a component that only reads the time say so, and lets a test hand it a
 * clock without handing it the power to arm timers.
 *
 * Milliseconds since the Unix epoch, matching `Date.now()`, so a `Clock` is a
 * drop-in for the reads it replaces.  It is **not** promised to be monotonic:
 * {@link SystemClock} moves with the system clock, NTP steps included.  A
 * duration that must not go backwards belongs on `performance.now()` and is one
 * of the reads this contract deliberately does not cover.
 *
 * @see ManualScheduler — the implementation a test advances by hand.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

/**
 * The wall clock, for everything that is not a test.
 *
 * Exists so a component can take a `Clock` without every production call site
 * having to write `{ now: () => Date.now() }`, and so the default is a named
 * thing that shows up in a stack rather than an anonymous literal.
 */
export class SystemClock implements Clock {
  now(): number { return Date.now(); }
}

/**
 * The process-wide {@link SystemClock}.
 *
 * A clock holds no state, so one instance is enough, and a shared default keeps
 * a `?? systemClock` fallback from allocating on every call.
 */
export const systemClock: Clock = new SystemClock();
