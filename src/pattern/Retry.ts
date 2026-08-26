export type RetryOptions = {
  /** Total attempts including the initial call.  Must be >= 1. */
  readonly attempts: number;
  /** Base delay between retries, in ms. */
  readonly delayMs?: number;
  /** Exponential-backoff multiplier applied to `delayMs` (default 1 — no backoff). */
  readonly factor?: number;
  /**
   * Upper bound for any individual retry delay.  Unbounded by default; the
   * hard clamp at the 32-bit timer limit (`2_147_483_647` ms, ~24.9 days)
   * still applies, so an omitted cap degrades to a very long wait rather
   * than to no wait at all.
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
};

const setTimeoutSleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * The largest delay `setTimeout` — the primitive `setTimeoutSleep` above
 * picks — can actually represent.  Its argument is coerced to a 32-bit
 * signed integer, and anything larger silently becomes `1`, so an
 * exponential backoff that overflows does not wait longer: it stops waiting
 * altogether and turns into a hot loop against the dependency that is
 * already failing (#771).
 *
 * Clamping is therefore not a cap on what the caller may ask for, it is the
 * direction the failure has to fall in: "waits ~24.9 days" is a
 * misconfiguration an operator can see and fix, "waits 1 ms" looks like the
 * retry working.  It applies to an injected `sleep` too — a delay this large
 * is a bug wherever it is awaited, and making the clamp conditional would
 * make the one path that matters the one no test can observe.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * `base × (1 ± randomFactor)`, floored at 0.
 *
 * Deliberately local rather than a call into
 * `pattern/BackoffPolicy` — `exponentialBackoff` hardcodes base 2 and so
 * cannot express `RetryOptions.factor`, and it *throws* unless `maxMs` is
 * finite, which is exactly the omitted-cap shape `retry` has to keep
 * accepting.  The same trade-off `BrokerActor._jitteredBackoff` records for
 * the reconnect path (#652).  The jitter contract is identical to the
 * primitive's.
 */
function applyJitter(base: number, randomFactor: number, random: () => number): number {
  if (randomFactor === 0) return base;
  // random() returns [0, 1); map to [-randomFactor, +randomFactor].
  return Math.max(0, base * (1 + (random() * 2 - 1) * randomFactor));
}

/**
 * Invoke `factory` up to `options.attempts` times with configurable
 * exponential backoff.  Returns the first successful result.  Propagates
 * the final error if every attempt fails or `shouldRetry` vetoes a retry.
 */
export async function retry<T>(factory: () => Promise<T>, options: RetryOptions): Promise<T> {
  const max = options.attempts;
  if (max < 1) throw new Error(`retry: attempts must be >= 1 (got ${max})`);
  const base = options.delayMs ?? 0;
  const factor = options.factor ?? 1;
  const maxDelay = options.maxDelayMs ?? Number.POSITIVE_INFINITY;
  const randomFactor = options.randomFactor ?? 0;
  if (randomFactor < 0 || randomFactor > 1) {
    throw new Error(`retry: randomFactor must be in [0, 1] (got ${randomFactor})`);
  }
  const random = options.random ?? Math.random;
  const shouldRetry = options.shouldRetry ?? ((): boolean => true);
  const sleep = options.sleep ?? setTimeoutSleep;

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
      const capped = Math.min(base * Math.pow(factor, attempt - 1), maxDelay);
      // The timer clamp goes *after* the jitter, not before it: a delay
      // already sitting on the ceiling and then multiplied by
      // `1 + randomFactor` would land back over the 32-bit limit and reopen
      // the overflow this line exists to close.
      const delay = Math.min(applyJitter(capped, randomFactor, random), MAX_TIMER_DELAY_MS);
      if (delay > 0) {
        await sleep(delay);
      }
    }
  }
  // Unreachable, but TS can't prove it.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
