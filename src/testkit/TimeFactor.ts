/**
 * One multiplier for every testkit deadline (#1376).
 *
 * ## What it is for
 *
 * Every timeout in the testkit was a millisecond literal baked into the source
 * — `TestProbe`'s 3 000 ms, `expectNoMessage`'s 300, `MultiNodeSpec`'s 10 000,
 * `ParallelMultiNodeSpec`'s 30 000 and its 5 s control RPC and 10 s handshake.
 * Those numbers encode an assumption about machine speed that is false on a
 * hosted runner and false on a loaded laptop, and the only way to change them
 * was to edit each one. Which is why the repository grew a quarantine instead
 * (#538).
 *
 * These deadlines are **failure budgets, not expected durations**: nothing is
 * asserted on them, they exist to turn a hang into a message. That is exactly
 * the kind of number that should scale with the machine, and exactly the kind
 * that must never be *asserted* on — see `TimerTolerance` for the other half of
 * that rule.
 *
 * ## Virtual time is better, where it applies
 *
 * This is not a substitute for `ManualScheduler`. Where a test can advance a
 * clock it should: virtual time removes the race rather than widening it, and
 * a budget that cannot be reached is better than a budget that is merely
 * generous. The factor is for what is left over — convergence waits, probe
 * timeouts, barrier waits — where a real cluster really does take real time.
 *
 * ## The per-test cap does not scale, and that is deliberate
 *
 * The sharp edge, and the one the issue asks the implementation to answer:
 * bun's per-test timeout is **not** something this module can reach. It is
 * either the 5 000 ms default or a literal third argument to `test()`, and a
 * factor that quietly tripled a 4 000 ms budget under an untouched 5 000 ms cap
 * would recreate the exact failure `AwaitConditionBudgets` exists to prevent —
 * the runner's timeout wins the race and the budget's message, the one naming
 * what was being waited for, is never printed.
 *
 * So the factor scales budgets and **the guard scales with it**: at a raised
 * factor `AwaitConditionBudgets` measures the scaled budget against the
 * unscaled cap and fails for any test that can no longer report. A test that
 * should scale with the factor declares its cap through {@link scaledMs},
 * which that guard recognises. Raising the factor is therefore loud where it
 * cannot work, rather than silently worse.
 */

/** Environment variable that sets the factor for a whole run. */
export const TEST_TIME_FACTOR_VARIABLE = 'ACTOR_TS_TEST_TIME_FACTOR';

/**
 * No scaling, which is what every local run and every ordinary CI job uses.
 *
 * A default of 1 makes the feature inert until somebody asks for it — the point
 * is that a slow machine can be *told*, not that deadlines drift upward on
 * their own.
 */
export const DEFAULT_TEST_TIME_FACTOR = 1;

/**
 * Read once per process, because a deadline computed with one factor and
 * checked against another is worse than either.
 */
let cached: number | undefined;

/**
 * The factor in effect, from {@link TEST_TIME_FACTOR_VARIABLE}.
 *
 * A malformed value **throws** rather than falling back to 1. The variable is
 * set by somebody who wants slower deadlines, and silently ignoring their typo
 * would hand them a run that fails for the reason they were trying to fix,
 * with nothing anywhere saying the setting did not take.
 */
export function testTimeFactor(): number {
  if (cached !== undefined) return cached;
  const raw = process.env[TEST_TIME_FACTOR_VARIABLE];
  if (raw === undefined || raw === '') {
    cached = DEFAULT_TEST_TIME_FACTOR;
    return cached;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `${TEST_TIME_FACTOR_VARIABLE}=${raw} is not a positive number. `
      + 'It multiplies every testkit deadline; 1 is no scaling, 3 makes every '
      + 'budget three times as long.',
    );
  }
  cached = parsed;
  return cached;
}

/**
 * `ms` scaled by the factor, rounded up.
 *
 * Rounded **up** rather than to nearest: every caller is a deadline, and a
 * budget that came out a millisecond short of what was asked for is the one
 * rounding error that can turn a green run red.
 */
export function scaledMs(ms: number): number {
  const factor = testTimeFactor();
  return factor === DEFAULT_TEST_TIME_FACTOR ? ms : Math.ceil(ms * factor);
}

/**
 * A phrase naming the factor, for a failure message — empty when it is 1.
 *
 * Empty at the default on purpose: a timeout message that mentions a factor
 * nobody set sends the reader after a setting that is not the cause. When the
 * factor *is* raised it belongs in every message it lengthened, because "waited
 * 30 s" and "waited 30 s, which was 10 s scaled by 3" are different facts and
 * only the second one is actionable.
 */
export function describeTimeFactor(): string {
  const factor = testTimeFactor();
  return factor === DEFAULT_TEST_TIME_FACTOR
    ? ''
    : ` (${TEST_TIME_FACTOR_VARIABLE}=${factor}, so this budget is ${factor}x the declared one)`;
}

/**
 * Forget the cached reading.
 *
 * Exported for this module's own tests, which have to observe more than one
 * factor in one process. Nothing else should call it: a factor that changes
 * mid-run is the inconsistency the cache exists to prevent.
 *
 * @internal
 */
export function resetTimeFactorForTest(): void {
  cached = undefined;
}
