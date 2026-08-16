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
 *     and the **minimum** is kept — the round that was not interrupted.
 */
import { describe, expect, test } from 'bun:test';
import { redactUrlCredentials } from '../../src/util/RedactUrlCredentials.js';
import { addressMatchesPins, parseAddressPin } from '../../src/util/CidrMatch.js';
import { resolveStaticPath } from '../../src/http/static/StaticPath.js';
import { stripSurrounding, stripTrailing } from '../../src/util/StripCharacters.js';

/** Input lengths, each 4× the last — the step a quadratic scan turns into ~16×. */
const SIZES: readonly number[] = [2_000, 8_000, 32_000];

/**
 * The same shape one rung lower, for the control below: it is measured while
 * still quadratic, so 32 000 characters would cost it five seconds on every
 * run for a fact 8 000 already establishes.
 */
const CONTROL_SIZES: readonly number[] = [500, 2_000, 8_000];

/** Linear steps by 4×, quadratic by 16×. Fail in the gap, nearer the safe end. */
const MAXIMUM_STEP_RATIO = 6;

/** Wall-clock per size and round; the call count follows from it. */
const MEASUREMENT_BUDGET_MS = 10;

/** Rounds per size; the minimum is kept, so one descheduled round is harmless. */
const MEASUREMENT_ROUNDS = 3;

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

/** Mean cost of one call, over the best of {@link MEASUREMENT_ROUNDS} timed budgets. */
function perCallMilliseconds(run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < MEASUREMENT_ROUNDS; round++) {
    const started = performance.now();
    let calls = 0;
    let elapsed = 0;
    do {
      run();
      calls++;
      elapsed = performance.now() - started;
    } while (elapsed < MEASUREMENT_BUDGET_MS);
    best = Math.min(best, elapsed / calls);
  }
  return best;
}

function measureGrowth(
  build: (size: number) => string,
  run: (input: string) => unknown,
  sizes: readonly number[] = SIZES,
): GrowthMeasurement {
  const warmupInput = build(WARMUP_SIZE);
  for (let i = 0; i < WARMUP_CALLS; i++) sink = run(warmupInput);
  const milliseconds = sizes.map((size) => {
    const input = build(size);
    return perCallMilliseconds(() => {
      sink = run(input);
    });
  });
  const ratios = milliseconds.slice(1).map((current, i) => current / milliseconds[i]);
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
