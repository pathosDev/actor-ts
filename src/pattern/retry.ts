export interface RetryOptions {
  /** Total attempts including the initial call.  Must be >= 1. */
  readonly attempts: number;
  /** Base delay between retries, in ms. */
  readonly delayMs?: number;
  /** Exponential-backoff multiplier applied to `delayMs` (default 1 — no backoff). */
  readonly factor?: number;
  /** Upper bound for any individual retry delay. */
  readonly maxDelayMs?: number;
  /**
   * Predicate that decides whether a specific error is retryable.  Return
   * false to short-circuit with the final error.  Defaults to "retry any".
   */
  readonly shouldRetry?: (err: Error, attempt: number) => boolean;
  /** Called after each failed attempt; useful for logging/metrics. */
  readonly onAttempt?: (err: Error, attempt: number) => void;
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
  const shouldRetry = options.shouldRetry ?? ((): boolean => true);

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
      const delay = Math.min(base * Math.pow(factor, attempt - 1), maxDelay);
      if (delay > 0) {
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  // Unreachable, but TS can't prove it.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
