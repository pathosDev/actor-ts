/**
 * Tolerances for tests that measure real elapsed time (#477, #1338).
 *
 * ## The defect this existed for, and its end
 *
 * Windows' default timer resolution is 15.625 ms.  Bun 1.3 decided a timer was
 * due on that tick boundary, so a `setTimeout` whose deadline sat just *below* a
 * tick multiple fired a full tick **early**.  Measured on Bun 1.3.1 / Windows 11,
 * `performance.now()` deltas on an idle machine, 1500–2000 samples per row:
 *
 *   setTimeout(20)   min  19.82   p50 31.13   max  63.78    never early
 *   setTimeout(30)   min  18.67   p50 30.52   max 174.97    ~11 ms early
 *   setTimeout(50)   min  54.04   p50 62.58   max  72.06    never early
 *
 * 30 ms was the pathological value — just under `2 × 15.625 = 31.25`, so the
 * loop could treat it as due one tick in.
 *
 * **Bun 1.4's event loop resolves due-ness correctly and the row is gone.**
 * Re-measured on 2026-09-08, same machine, 60 samples per row:
 *
 *   setTimeout( 5)   min   5.23   p50  5.80   max  6.43    0/60 early
 *   setTimeout(20)   min  20.08   p50 21.00   max 21.40    0/60 early
 *   setTimeout(30)   min  30.04   p50 30.91   max 31.38    0/60 early
 *   setTimeout(60)   min  60.26   p50 60.89   max 61.54    0/60 early
 *
 * Not one fire below nominal at any delay, and the pathological value is the
 * best-behaved of them.  The 1.3 table stays above because a tolerance that
 * says only what is true today explains nothing about why it exists.
 *
 * So the slack here is now **lateness-only**.  It has to be: an early-fire
 * allowance on a runtime that never fires early is not caution, it is a bound
 * that cannot fail — `minimumElapsedMs(30)` used to admit 10 ms, which no
 * `setTimeout(30)` has ever produced under either version.
 *
 * ## The rule that did not change
 *
 * **There is still no safe upper bound.**  The same 30 ms timer was measured at
 * 46 ms idle and 201 ms under CPU load, and lateness is unbounded by
 * construction — it is whatever the OS scheduler decides.  A bound loose enough
 * to survive can no longer tell the delay it is checking apart from a longer
 * one, which makes it an assertion about nothing.
 *
 * Assert **virtual time** instead, which since #1424 is available nearly
 * everywhere the framework waits: `system.clock`, `TestKit.advance`,
 * `after(ms, factory, scheduler)`, `retry({ scheduler })`,
 * `CircuitBreakerOptions.withScheduler`, `LeaseOptions.withScheduler`,
 * `MultiNodeSpec.advanceUntil`.  A `ManualScheduler` turns "did five seconds
 * pass" from a measurement into a fact.
 */

/**
 * Slack for a *late* fire, so a lower bound never parks exactly on the
 * theoretical floor.
 *
 * Four milliseconds against a measured worst case of 1.5 ms of lateness at the
 * delays this repository actually uses, which leaves room for a machine slower
 * than the one the table above was taken on without letting the bound admit a
 * timer that did not run.
 */
const HEADROOM_MS = 4;

/**
 * Lower bound for "a real timer of `nominalMs` elapsed".
 *
 * Since Bun 1.4 a timer does not fire early, so this subtracts headroom only —
 * it no longer gives away a whole 15.625 ms quantum per timer, and a chain of
 * *k* timers no longer needs *k* quanta subtracted at the call site.
 *
 * It is still a *lower* bound and nothing more.  Separating a timer from a
 * microtask is the only thing an elapsed-time assertion can honestly establish
 * on a real clock.  When a test needs to pin down *when* something ran, assert
 * the ordering against another observable — a flag the callback sets, a probe
 * message — or move it onto virtual time.
 */
export function minimumElapsedMs(nominalMs: number): number {
  return Math.max(1, nominalMs - HEADROOM_MS);
}
