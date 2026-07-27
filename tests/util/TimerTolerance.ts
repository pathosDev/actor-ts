/**
 * Tolerances for tests that measure real elapsed time (#477).
 *
 * Windows' default timer resolution is 15.625 ms and Bun's event loop
 * decides a timer is due on that tick boundary — so a `setTimeout` whose
 * deadline sits just *below* a tick multiple fires a full tick **early**.
 * Measured on Bun 1.3.1 / Windows 11, `performance.now()` deltas on an
 * idle machine, 1500–2000 samples per row:
 *
 *   setTimeout(20)   min  19.82   p50 31.13   max  63.78    never early
 *   setTimeout(30)   min  18.67   p50 30.52   max 174.97    ~11 ms early
 *   setTimeout(50)   min  54.04   p50 62.58   max  72.06    never early
 *
 * 30 ms is the pathological value: just under `2 × 15.625 = 31.25`, so the
 * loop can treat it as due one tick in.  Nothing about the *clock* is to
 * blame — `Date.now()` ticks at 1 ms under Bun and `performance.now()` at
 * ~0.0001 ms — so measuring more precisely does not help.  An early timer
 * is early however you time it.
 *
 * Two rules follow:
 *
 *   1. A lower bound must sit a full quantum below the nominal delay.
 *      Use {@link minimumElapsedMs}; do not hand-pick a number close to
 *      nominal ("30 ms timer, assert >= 25") — that has no margin at all
 *      and fails without any load.
 *   2. There is no safe *upper* bound.  The same 30 ms timer was measured
 *      at 46 ms idle and 201 ms under CPU load, so a bound loose enough to
 *      survive can no longer tell the delay it is checking apart from a
 *      longer one.  Assert virtual time instead — inject a
 *      `ManualScheduler`-backed clock (see `retry`'s `sleep` option).
 */

/** Windows' timer quantum (15.625 ms), rounded up to a whole millisecond. */
export const TIMER_QUANTUM_MS = 16;

/** Extra slack so a bound never parks exactly on the theoretical floor. */
const HEADROOM_MS = 4;

/**
 * Lower bound for "a real timer of `nominalMs` elapsed", assuming a single
 * timer — a chain of *k* timers can lose *k* quanta, so subtract
 * accordingly at the call site.
 *
 * The bound is deliberately loose: separating a timer from a microtask is
 * the only thing an elapsed-time assertion can honestly establish on a
 * quantized clock.  When a test needs to pin down *when* something ran,
 * assert the ordering against another observable step (a flag set by the
 * callback, a probe message) rather than tightening this number.
 */
export function minimumElapsedMs(nominalMs: number): number {
  return Math.max(1, nominalMs - TIMER_QUANTUM_MS - HEADROOM_MS);
}
