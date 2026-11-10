import { describe, expect, test } from 'bun:test';
import { minimumElapsedMs } from './TimerTolerance.js';

/**
 * The tolerance itself had no test, which is how it kept an allowance for a
 * defect that no longer exists.
 *
 * Bun 1.3 could fire a `setTimeout` a full 15.625 ms quantum **early** (#477),
 * so the bound gave a whole quantum away per timer. Bun 1.4's event loop
 * resolves due-ness correctly: re-measured on 2026-09-08, 60 samples at each of
 * 5, 20, 30 and 60 ms, **not one fire below nominal** — and 30 ms, the value
 * that used to be pathological, came back at 30.04 ms minimum (#1338).
 *
 * An early-fire allowance on a runtime that never fires early is not caution.
 * It is a bound that cannot fail: `minimumElapsedMs(30)` used to admit 10 ms,
 * which no `setTimeout(30)` has produced under either version of bun.
 */
describe('minimumElapsedMs grants lateness, not earliness', () => {
  test('a real timer of N ms clears the bound for N', () => {
    // The measured floor is nominal itself, so the bound has to sit below it.
    for (const nominal of [5, 20, 30, 60, 250]) {
      expect(minimumElapsedMs(nominal)).toBeLessThan(nominal);
    }
  });

  test('it no longer gives away a timer quantum', () => {
    // The old shape was `nominal - 16 - 4`, so 30 ms admitted 10 ms. The
    // measured minimum for `setTimeout(30)` is 30.04 ms; a bound of 10 could
    // not have failed for any reason a test would want to hear about.
    expect(minimumElapsedMs(30)).toBe(26);
    expect(minimumElapsedMs(20)).toBe(16);
    expect(minimumElapsedMs(60)).toBe(56);
  });

  test('the slack is a fixed headroom rather than a fraction', () => {
    // A proportional tolerance would grow with the delay, so a 5-second timer
    // would admit a wait that never happened. Lateness comes from the OS
    // scheduler and does not scale with the requested delay.
    const slack = (nominal: number): number => nominal - minimumElapsedMs(nominal);
    expect(slack(20)).toBe(slack(2_000));
  });

  test('a tiny delay still yields a positive bound', () => {
    // `nominal - headroom` goes non-positive below 5 ms, and a bound of 0 or
    // less is satisfied by a microtask — which is precisely the thing an
    // elapsed-time assertion exists to rule out.
    expect(minimumElapsedMs(1)).toBeGreaterThan(0);
    expect(minimumElapsedMs(4)).toBeGreaterThan(0);
  });
});
