import type { Scheduler } from '../Scheduler.js';
import { OptionsError } from '../util/OptionsValidator.js';
import { applyJitter } from './BackoffPolicy.js';
import { DEFAULT_MAX_RETRY_DELAY_MS, MAX_TIMER_DELAY_MS } from './Constants.js';

/**
 * Refuse a `RetryOptions` value, the way the rest of the tree refuses one.
 *
 * `OptionsError` rather than the bare `Error` these checks used to throw.
 * Every other refused argument in the framework raises it — `assertAskTimeout`,
 * `assertStashCapacity`, every `OptionsValidator` subclass — and the
 * difference is not cosmetic: `retry` wraps a caller's factory, so the error
 * that comes back out of it is *usually* the factory's own.  A plain `Error`
 * from the option checks is indistinguishable from that, and a caller
 * branching on "was my call refused or did my dependency fail?" had nothing to
 * branch on.  Pre-1.0, changing the class is a hard cut rather than a
 * deprecation; `OptionsError extends Error`, so a `catch` that only reads
 * `.message` is unaffected.
 */
function refuse(field: string, reason: string, value: unknown): never {
  throw new OptionsError(
    `retry: ${field} ${reason} (got ${OptionsError.renderValue(value)})`,
    'retry',
    field,
    value,
  );
}

export type RetryOptions = {
  /** Total attempts including the initial call.  Must be >= 1. */
  readonly attempts: number;
  /** Base delay between retries, in ms. */
  readonly delayMs?: number;
  /** Exponential-backoff multiplier applied to `delayMs` (default 1 — no backoff). */
  readonly factor?: number;
  /**
   * Upper bound for any individual retry delay.  Defaults to
   * `DEFAULT_MAX_RETRY_DELAY_MS` (60 000 ms) — pass
   * `Number.POSITIVE_INFINITY` for the unbounded schedule this option used
   * to have by default, in which case the hard clamp at the 32-bit timer
   * limit (`2_147_483_647` ms, ~24.9 days) is the only ceiling left.
   */
  readonly maxDelayMs?: number;
  /**
   * Jitter fraction in `[0, 1]`.  The delay is multiplied by
   * `1 + random(-randomFactor, +randomFactor)`, so N callers that failed on
   * the same upstream event stop retrying in lockstep and hammering the
   * recovering dependency in synchronised waves.
   *
   * Default `0` — unlike `exponentialBackoff`, whose callers are always
   * fleets of reconnecting clients, `retry` wraps a single call and its
   * schedule has always been deterministic.  Opting in is the change; `0.2`
   * is the spread the rest of the project uses.
   */
  readonly randomFactor?: number;
  /** Override `Math.random` for deterministic tests. */
  readonly random?: () => number;
  /**
   * Predicate that decides whether a specific error is retryable.  Return
   * false to short-circuit with the final error.  Defaults to "retry any".
   */
  readonly shouldRetry?: (err: Error, attempt: number) => boolean;
  /** Called after each failed attempt; useful for logging/metrics. */
  readonly onAttempt?: (err: Error, attempt: number) => void;
  /**
   * How the delay between attempts is awaited.  Defaults to `setTimeout`.
   * Override to take the retry loop off the wall clock — a
   * `ManualScheduler`-backed sleep makes the backoff schedule exact and
   * instant in tests, where a real timer's ±quantum jitter makes a capped
   * delay indistinguishable from an uncapped one.  Same escape hatch as
   * `random` above, for the other half of the schedule.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Where the delay between attempts is armed.  Default: a host timer.
   *
   * The same thing {@link sleep} buys, without the caller writing the adapter:
   * `scheduler: system.scheduler` puts the whole backoff schedule on virtual
   * time under a `ManualScheduler`, so a five-attempt exponential backoff is
   * exact and instant instead of being the sum of five real delays (#1424).
   *
   * `sleep` wins if both are given — it is the lower-level door, and a caller
   * that supplied one meant it.
   */
  readonly scheduler?: Scheduler;
};

const setTimeoutSleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Invoke `factory` up to `options.attempts` times with configurable
 * exponential backoff.  Returns the first successful result.  Propagates
 * the final error if every attempt fails or `shouldRetry` vetoes a retry.
 *
 * Every delay is bounded twice: by `maxDelayMs`, which now defaults to
 * {@link DEFAULT_MAX_RETRY_DELAY_MS} rather than to infinity, and
 * unconditionally by {@link MAX_TIMER_DELAY_MS} (#771).
 */
export async function retry<T>(factory: () => Promise<T>, options: RetryOptions): Promise<T> {
  const max = options.attempts;
  // `Number.isNaN` and not `!Number.isFinite`, and the asymmetry with the
  // knobs below is the point: `attempts: Number.POSITIVE_INFINITY` is a
  // working "retry until it succeeds" schedule, so refusing it would narrow
  // an accepted domain for no defect.  `NaN` is the opposite — `NaN < 1` is
  // false, so it used to skip this refusal, and then `attempt <= max` is
  // false on the first iteration, so the loop body never ran either.  The
  // caller got a bare `Error` whose whole message was the string
  // `"undefined"` from the fall-through below, for a dependency that was
  // never called (#1509).  Same shape as `maxDelayMs`, which keeps
  // `Infinity` legal for the same kind of reason.
  if (Number.isNaN(max) || max < 1) refuse('attempts', 'must be >= 1', max);
  const base = options.delayMs ?? 0;
  const factor = options.factor ?? 1;
  const maxDelay = options.maxDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const randomFactor = options.randomFactor ?? 0;
  // `Number.isFinite` first, because a range test is not a validity test:
  // `NaN < 0` and `NaN > 1` are both false, so the comparison pair alone let
  // the one value through that nothing downstream can recover from.  It needs
  // no typo to arrive — an absent configuration field is `undefined` and any
  // arithmetic over it is `NaN` — and it lands where the three knobs below
  // land, on a product that `if (delay > 0)` discards: measured at four
  // attempts, `factoryCalls=4 sleeps=[]` against `[1000,2000,4000]` for the
  // same schedule with a sane factor (#1509).  `Infinity` was already refused
  // by `> 1`; the check is written this way to match the three below rather
  // than to catch it twice.
  if (!Number.isFinite(randomFactor) || randomFactor < 0 || randomFactor > 1) {
    refuse('randomFactor', 'must be in [0, 1]', randomFactor);
  }
  // The other three knobs of the schedule, refused here for the reason the
  // two above are (#771, #1509).  Left unchecked they all land on the same
  // outcome: the product below is `NaN`, negative or zero, `if (delay > 0)`
  // is false, and the wait is skipped *entirely* — so `retry` busy-loops
  // against the dependency that is already failing.  That is the failure
  // direction the timer clamp exists to invert, reached through the options
  // instead of through the arithmetic, and none of the shapes needs a typo:
  // an absent configuration field arrives as `undefined` and any arithmetic
  // over it as `NaN`.
  //
  // `Infinity` is legal for `maxDelayMs` alone, because there it *means*
  // something — the documented opt-out of the default ceiling, after which
  // the 32-bit timer clamp is what bounds the schedule.  As a base or a
  // multiplier it means nothing a finite delay can come out of.
  if (!Number.isFinite(base) || base < 0) {
    refuse('delayMs', 'must be a non-negative finite number', base);
  }
  if (!Number.isFinite(factor) || factor <= 0) {
    refuse('factor', 'must be a positive finite number', factor);
  }
  if (Number.isNaN(maxDelay) || maxDelay < 0) {
    refuse('maxDelayMs', 'must be >= 0 (Number.POSITIVE_INFINITY for no ceiling)', maxDelay);
  }
  const random = options.random ?? Math.random;
  const shouldRetry = options.shouldRetry ?? ((): boolean => true);
  // `sleep` first: it is the lower-level door, and a caller who supplied one
  // meant it. A scheduler is the same thing without the adapter (#1424).
  const scheduler = options.scheduler;
  const sleep = options.sleep
    ?? (scheduler === undefined
      ? setTimeoutSleep
      : (ms: number): Promise<void> => new Promise((resolve) => {
        scheduler.scheduleOnceFunction(ms, () => { resolve(); });
      }));

  let lastError: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await factory();
    } catch (err) {
      lastError = err;
      const asErr = err instanceof Error ? err : new Error(String(err));
      options.onAttempt?.(asErr, attempt);
      if (attempt >= max || !shouldRetry(asErr, attempt)) {
        throw asErr;
      }
      // The timer clamp goes on *both* sides of the jitter, and each side
      // closes a different hole (#771).
      //
      // After, because a delay already sitting on the ceiling and then
      // multiplied by `1 + randomFactor` would land back over the 32-bit
      // limit and reopen the overflow.
      //
      // Before, because `applyJitter` multiplies, and `Infinity * 0` is
      // `NaN` — which `Math.max`, `Math.min` and finally `delay > 0` all
      // propagate silently, so the sleep is skipped *entirely* and `retry`
      // busy-loops against the failing dependency.  It takes an explicit
      // `maxDelayMs: Number.POSITIVE_INFINITY` — the finite default is what
      // keeps the product finite otherwise — together with
      // `randomFactor: 1`, whose lower jitter edge is a multiplier of
      // exactly zero.  Narrow, and strictly worse than the overflow the
      // clamp was added for.  A finite base cannot produce it.
      const capped = Math.min(base * Math.pow(factor, attempt - 1), maxDelay, MAX_TIMER_DELAY_MS);
      const delay = Math.min(applyJitter(capped, randomFactor, random), MAX_TIMER_DELAY_MS);
      if (delay > 0) {
        await sleep(delay);
      }
    }
  }
  // Reached when `attempts` is fractional — `attempt >= max` is false on the
  // last whole iteration, so the loop waits once more and then runs out — and
  // `lastError` is an `Error` by then, because getting here at all takes a
  // caught failure.  The entry guard is what makes that true: it is the only
  // thing standing between this line and an `attempts` under which the body
  // never runs, which is how it used to rethrow `new Error(String(undefined))`
  // — the string `"undefined"`, for a factory that was never called (#1509).
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
