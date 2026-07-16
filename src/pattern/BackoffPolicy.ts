/**
 * Pure backoff-policy primitives — stateless functions of `(restartCount)`
 * to a delay in milliseconds.  Decoupled from {@link BackoffSupervisor}
 * so callers can plug in their own policy without subclassing the
 * supervisor, and so the policy itself is trivially unit-testable.
 *
 * Two built-ins:
 *
 *   - `exponentialBackoff` — `min × 2^n` clamped to `max`, with optional
 *     ± jitter expressed as a fraction of the un-jittered delay.  This
 *     is the policy you usually want — fast-then-slow, randomised so
 *     a herd of clients doesn't synchronise their reconnect attempts.
 *
 *   - `linearBackoff` — `min + step × n` clamped to `max`.  Niche; use
 *     when you specifically want bounded growth (e.g. polling cadence
 *     that should plateau quickly).
 *
 * The randomness source defaults to `Math.random` but can be overridden
 * — pass a seeded RNG to make the policy deterministic in tests.
 */

export interface BackoffPolicy {
  /**
   * Delay in milliseconds before the next restart attempt.  `restartCount`
   * is 0-based: the **first** restart (after the very first failure)
   * passes `0`, the second restart passes `1`, etc.
   */
  delayFor(restartCount: number): number;
}

export interface ExponentialBackoffOptions {
  /** Floor for the delay, in ms. The first restart delay is at least this. */
  readonly minMs: number;
  /** Ceiling for the delay, in ms. */
  readonly maxMs: number;
  /**
   * Jitter fraction in `[0, 1]`.  The actual delay is multiplied by
   * `1 + random(-randomFactor, +randomFactor)` so two replicas don't
   * synchronise.  Default `0.2`.
   */
  readonly randomFactor?: number;
  /** Override `Math.random` for deterministic tests. */
  readonly random?: () => number;
}

export interface LinearBackoffOptions {
  readonly minMs: number;
  readonly maxMs: number;
  /** Linear step in ms — added once per restart. */
  readonly stepMs: number;
  readonly randomFactor?: number;
  readonly random?: () => number;
}

/**
 * `min × 2^n` clamped to `max`, multiplied by `1 ± randomFactor`.
 *
 *   exponentialBackoff({ minMs: 200, maxMs: 10_000, randomFactor: 0.2 })
 *   //  n=0 → ~200 (160..240)
 *   //  n=1 → ~400 (320..480)
 *   //  n=2 → ~800
 *   //  n=10 → 10_000 (clamped)
 */
export function exponentialBackoff(options: ExponentialBackoffOptions): BackoffPolicy {
  validateBaseOpts(options);
  const randomFactor = options.randomFactor ?? 0.2;
  if (randomFactor < 0 || randomFactor > 1) {
    throw new Error(`exponentialBackoff: randomFactor must be in [0, 1], got ${randomFactor}`);
  }
  const random = options.random ?? Math.random;
  return {
    delayFor(restartCount: number): number {
      const attempt = Math.max(0, restartCount);
      // Use a guarded power so we don't overflow to Infinity for huge attempt counts.
      const raw = attempt >= 30 ? options.maxMs : options.minMs * Math.pow(2, attempt);
      const clamped = Math.min(raw, options.maxMs);
      return applyJitter(clamped, randomFactor, random);
    },
  };
}

/**
 * `min + step × n` clamped to `max`.  Same jitter contract as
 * {@link exponentialBackoff}.  Use when you want a bounded, predictable
 * cadence rather than exponential growth.
 */
export function linearBackoff(options: LinearBackoffOptions): BackoffPolicy {
  validateBaseOpts(options);
  if (options.stepMs < 0) throw new Error(`linearBackoff: stepMs must be >= 0, got ${options.stepMs}`);
  const randomFactor = options.randomFactor ?? 0.2;
  if (randomFactor < 0 || randomFactor > 1) {
    throw new Error(`linearBackoff: randomFactor must be in [0, 1], got ${randomFactor}`);
  }
  const random = options.random ?? Math.random;
  return {
    delayFor(restartCount: number): number {
      const attempt = Math.max(0, restartCount);
      const raw = options.minMs + options.stepMs * attempt;
      const clamped = Math.min(raw, options.maxMs);
      return applyJitter(clamped, randomFactor, random);
    },
  };
}

/* ------------------------------ helpers --------------------------------- */

function validateBaseOpts(options: { minMs: number; maxMs: number }): void {
  if (!Number.isFinite(options.minMs) || options.minMs < 0) {
    throw new Error(`backoff: minMs must be a non-negative finite number, got ${options.minMs}`);
  }
  if (!Number.isFinite(options.maxMs) || options.maxMs < options.minMs) {
    throw new Error(`backoff: maxMs must be a finite number >= minMs (${options.minMs}), got ${options.maxMs}`);
  }
}

function applyJitter(base: number, randomFactor: number, random: () => number): number {
  if (randomFactor === 0) return base;
  // random() returns [0, 1); map to [-randomFactor, +randomFactor].
  const sign = random() * 2 - 1;
  // Floor at 0 — a sub-zero delay would be nonsensical.
  return Math.max(0, base * (1 + sign * randomFactor));
}
