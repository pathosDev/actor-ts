/**
 * The string scans a remote peer can drive stay **linear** (#1198).
 *
 * Every function measured here used to be a quadratic regex — an unanchored
 * pattern whose leading quantifier the engine retries from every start
 * position, so a run of characters in that class with no terminator costs
 * O(n²).  Each one is reachable with a value the caller did not choose:
 *
 *   - `redactUrlCredentials` runs over the `Location` header of a redirect
 *     (`HttpClient`), so the input is whatever server the caller was pointed
 *     at.  484 ms of blocked event loop at the 16 KiB header limit.
 *   - `resolveStaticPath` runs over the decoded remainder of a request path.
 *   - `addressMatchesPins` runs over a hostname from a DNS or Kubernetes API
 *     response (`DnsSeedProvider`, `KubernetesApiSeedProvider`).
 *
 * **The assertion is growth, not a wall-clock budget.**  An absolute
 * threshold would be a machine-speed test and would flake on a loaded CI
 * runner; a ratio survives a uniformly slower box.  Each input is four times
 * the last, so a linear scan steps by ~4× and a quadratic one by ~16×.
 * {@link MAXIMUM_STEP_RATIO} sits between them with enough headroom that
 * scheduler noise cannot reach it — and far enough below 16 that the defect
 * this file was written for fails it by a factor of three.
 *
 * Two things that make a timing test lie, handled explicitly:
 *
 *   - **An unwarmed first call reads as slow.**  Every measurement is
 *     preceded by {@link WARMUP_CALLS} calls on a short input, so the
 *     interpreter has tiered up before the clock starts.
 *   - **A single sample is a coin flip.**  Each size is measured over a
 *     time *budget* rather than a fixed call count (so a sub-microsecond
 *     linear scan is still averaged over thousands of calls, well clear of
 *     the timer's resolution), repeated {@link MEASUREMENT_ROUNDS} times,
 *     and the **minimum** is kept — the window that was not interrupted.
 *   - **A disturbance can outlast a size's every window.**  The windows are
 *     short and *interleaved across sizes* — round one measures every size
 *     back to back, then round two, and so on — rather than one size's
 *     rounds run consecutively.  The consecutive shape (three 10 ms windows
 *     per size, next size after) measured a linear scan at 8.7× once on the
 *     Windows `--parallel` leg (#1530): whatever slowed the largest size
 *     lasted longer than its 30 ms of measurement, so the minimum was taken
 *     over three disturbed windows.  Steady contention does not do that — a
 *     co-tenant burning or thrashing the same two cores left every shape at
 *     ~4× — but a *bursty* one does, and reproduces the failure: two
 *     co-tenants alternating 40–100 ms of cache thrash with 60–150 ms of
 *     sleep, pinned to the measurement's two logical cores, took the
 *     consecutive shape to a worst step of 8.4× and 10.2× over 40 runs each
 *     (p90 7.3× and 7.8×).  Fifty 1 ms windows per size, interleaved, read
 *     4.2× and 5.1× worst under the same bursts (p90 4.0×), because a
 *     window shorter than a burst falls between bursts often enough for
 *     every size to get an undisturbed minimum, and the quadratic control
 *     still read 16×.  The same A/B through `bun test` itself, fifteen runs
 *     of each file under the 40/60 bursts: the old shape's six scans read
 *     p90 6.7× and worst 7.6×, this one's p90 4.1× and worst 4.8×.
 *     Widening the threshold instead would have been the drive-by that
 *     closes the gap to the defect this file exists to catch.
 */
import { describe, expect, test } from 'bun:test';
import { redactUrlCredentials } from '../../src/util/RedactUrlCredentials.js';
import { addressMatchesPins, parseAddressPin } from '../../src/util/CidrMatch.js';
import { resolveStaticPath } from '../../src/http/static/StaticPath.js';
import { stripSurrounding, stripTrailing } from '../../src/util/StripCharacters.js';

/** Input lengths, each 4× the last — the step a quadratic scan turns into ~16×. */
const SIZES: readonly number[] = [2_000, 8_000, 32_000];

/**
 * The same shape two rungs lower, for the control below: it is measured
 * while still quadratic, and fifty windows of a call that costs ~60 ms at
 * 8 000 characters is three seconds on every run for a fact 2 000 already
 * establishes — measured: 0.02 ms, 0.28 ms, 4.3 ms and 62 ms a call at 125,
 * 500, 2 000 and 8 000, the ~16× step from the first rung on.
 */
const CONTROL_SIZES: readonly number[] = [125, 500, 2_000];

/**
 * Linear steps by 4×, quadratic by 16×; the threshold sits in the gap.
 *
 * It was 6, which is the midpoint on a log scale and looks like the obvious
 * choice — but a linear scan measured 6.49 on a machine running the full suite
 * in parallel, so the margin above 4 was not the margin it appeared to be.  8
 * still fails the defect this file exists for by a factor of two, and moves the
 * headroom to the side where being wrong costs a false alarm rather than a
 * missed regression.
 */
const MAXIMUM_STEP_RATIO = 8;

/**
 * Wall-clock per window; the call count follows from it.  Short on purpose
 * — shorter than the bursts that inflated the consecutive shape (see the
 * file comment) — and still hundreds of calls for a linear scan on the
 * smallest input, a dozen on the largest; the quadratic control gets one
 * call per window, which is all a 16× step needs.
 */
const MEASUREMENT_BUDGET_MS = 1;

/**
 * Windows per size, interleaved across sizes; the minimum is kept.  Fifty
 * spreads each size's windows over ~150 ms of wall clock, so a disturbance
 * has to last that long, uninterrupted, to reach the minimum.
 */
const MEASUREMENT_ROUNDS = 50;

/** Enough calls on a short input to tier up before anything is timed. */
const WARMUP_CALLS = 2_000;

/** Length of the warm-up input: long enough to be representative, short enough that O(n²) warm-up is free. */
const WARMUP_SIZE = 100;

/**
 * Generous per-test ceiling: when the assertion fails it fails *slowly* (that
 * is the defect), and a timeout would report the wrong thing.
 */
const MEASUREMENT_TIMEOUT_MS = 120_000;

type GrowthMeasurement = {
  readonly sizes: readonly number[];
  readonly milliseconds: readonly number[];
  readonly ratios: readonly number[];
};

/** Keeps the measured call's result live, so nothing can be optimised away. */
let sink: unknown;

/** Mean cost of one call over one timed window of {@link MEASUREMENT_BUDGET_MS}. */
function perCallMilliseconds(run: () => void): number {
  const started = performance.now();
  let calls = 0;
  let elapsed = 0;
  do {
    run();
    calls++;
    elapsed = performance.now() - started;
  } while (elapsed < MEASUREMENT_BUDGET_MS);
  return elapsed / calls;
}

function measureGrowth(
  build: (size: number) => string,
  run: (input: string) => unknown,
  sizes: readonly number[] = SIZES,
): GrowthMeasurement {
  const warmupInput = build(WARMUP_SIZE);
  for (let i = 0; i < WARMUP_CALLS; i++) sink = run(warmupInput);
  const inputs = sizes.map(build);
  // Round-major, not size-major: every size gets one window per round, so
  // the windows of one size are spread across the whole measurement instead
  // of sitting in one stretch a single disturbance can cover (#1530).
  const milliseconds = sizes.map(() => Number.POSITIVE_INFINITY);
  for (let round = 0; round < MEASUREMENT_ROUNDS; round++) {
    inputs.forEach((input, i) => {
      milliseconds[i] = Math.min(milliseconds[i]!, perCallMilliseconds(() => {
        sink = run(input);
      }));
    });
  }
  const ratios = milliseconds.slice(1).map((current, i) => current / milliseconds[i]!);
  return { sizes, milliseconds, ratios };
}

/**
 * Assert the measurement is not superlinear, printing the table when it is —
 * the ratios are the whole diagnosis, and `expect` alone would swallow them.
 */
function expectLinearGrowth(label: string, measurement: GrowthMeasurement): void {
  const worst = Math.max(...measurement.ratios);
  if (worst > MAXIMUM_STEP_RATIO) {
    const row = measurement.sizes.map((size, i) => `${size}: ${measurement.milliseconds[i].toFixed(3)} ms`).join('   ');
    const steps = measurement.ratios.map((r) => `${r.toFixed(1)}×`).join(', ');
    console.error(`${label} grows superlinearly — ${row}   steps: ${steps}`);
  }
  expect(worst).toBeLessThanOrEqual(MAXIMUM_STEP_RATIO);
}

describe('scans over remote input are linear (#1198)', () => {
  test('redactUrlCredentials — a run of scheme characters with no "://"', () => {
    // The `Location` header of a redirect, filled with characters that keep
    // `[A-Za-z0-9+.-]*` alive at every start position.
    expectLinearGrowth(
      'redactUrlCredentials (scheme-character run)',
      measureGrowth((size) => 'a'.repeat(size), (input) => redactUrlCredentials(input)),
    );
  }, MEASUREMENT_TIMEOUT_MS);

  test('redactUrlCredentials — an authority that never closes', () => {
    expectLinearGrowth(
      'redactUrlCredentials (unterminated authority)',
      measureGrowth((size) => `https://${'a'.repeat(size)}`, (input) => redactUrlCredentials(input)),
    );
  }, MEASUREMENT_TIMEOUT_MS);

  test('resolveStaticPath — a run of slashes inside the request path', () => {
    // Not leading (that is rejected outright) and not trailing, so the
    // trailing-slash strip retries the run from every position.
    expectLinearGrowth(
      'resolveStaticPath (interior slash run)',
      measureGrowth(
        (size) => `a${'/'.repeat(size)}b`,
        (input) => resolveStaticPath('/srv/static', input, { dotfiles: 'deny' }),
      ),
    );
  }, MEASUREMENT_TIMEOUT_MS);

  test('addressMatchesPins — a run of dots inside a resolved hostname', () => {
    const pins = [parseAddressPin('svc.cluster.local', 'test')];
    expectLinearGrowth(
      'addressMatchesPins (interior dot run)',
      measureGrowth((size) => `a${'.'.repeat(size)}b`, (input) => addressMatchesPins(input, pins)),
    );
  }, MEASUREMENT_TIMEOUT_MS);

  // The rest of the sites the same pattern reached are behind these two: the
  // four logging sinks and the D1 client strip a trailing slash from a
  // configured endpoint, `normalizeSegment` and the static-file listing strip
  // both ends of a path segment.  Nothing hostile reaches those, but they are
  // where the shape gets copied from, so they are measured at the helper.
  test('stripTrailing — a run that is not at the end', () => {
    expectLinearGrowth(
      'stripTrailing',
      measureGrowth((size) => `a${'/'.repeat(size)}b`, (input) => stripTrailing(input, '/')),
    );
  }, MEASUREMENT_TIMEOUT_MS);

  test('stripSurrounding — a run at neither end', () => {
    expectLinearGrowth(
      'stripSurrounding',
      measureGrowth((size) => `a${'/'.repeat(size)}b`, (input) => stripSurrounding(input, '/')),
    );
  }, MEASUREMENT_TIMEOUT_MS);

  test('the harness measures something — a deliberately quadratic scan fails it', () => {
    // Guards the guard: if `measureGrowth` ever stopped measuring (a call
    // optimised away, a budget that ends after one iteration), every
    // assertion above would pass vacuously.  This one has to fail the same
    // check the others pass.
    const quadratic = (input: string): unknown => input.replace(/\/+$/, '');
    const measurement = measureGrowth((size) => `a${'/'.repeat(size)}b`, quadratic, CONTROL_SIZES);
    expect(Math.max(...measurement.ratios)).toBeGreaterThan(MAXIMUM_STEP_RATIO);
  }, MEASUREMENT_TIMEOUT_MS);
});
