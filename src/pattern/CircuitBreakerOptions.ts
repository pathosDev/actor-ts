import { OptionsBuilder } from '../util/OptionsBuilder.js';

/** Plain options-object shape accepted by a {@link CircuitBreaker}. */
export interface CircuitBreakerOptionsType {
  /** Consecutive failures before the breaker opens.  Must be >= 1. */
  readonly maxFailures: number;
  /** How long the breaker stays open before letting a probe through.  ms. */
  readonly resetTimeoutMs: number;
  /** Per-call timeout; exceeding this counts as a failure. */
  readonly callTimeoutMs?: number;
  /** Optional: classify errors as non-failures to bypass breaker counting. */
  readonly isFailure?: (err: Error) => boolean;
}

/**
 * Fluent builder for {@link CircuitBreakerOptionsType}:
 *
 *     new CircuitBreaker(CircuitBreakerOptions.create()
 *       .withMaxFailures(5)
 *       .withResetTimeoutMs(10_000));
 */
export class CircuitBreakerOptionsBuilder extends OptionsBuilder<CircuitBreakerOptionsType> {
  /** Start a fresh builder. */
  static create(): CircuitBreakerOptionsBuilder {
    return new CircuitBreakerOptionsBuilder();
  }

  /** Consecutive failures before the breaker opens.  Must be >= 1. */
  withMaxFailures(maxFailures: number): this {
    return this.set('maxFailures', maxFailures);
  }

  /** How long the breaker stays open before letting a probe through (ms). */
  withResetTimeoutMs(resetTimeoutMs: number): this {
    return this.set('resetTimeoutMs', resetTimeoutMs);
  }

  /** Per-call timeout; exceeding it counts as a failure. */
  withCallTimeoutMs(callTimeoutMs: number): this {
    return this.set('callTimeoutMs', callTimeoutMs);
  }

  /** Classify errors as non-failures to bypass breaker counting. */
  withIsFailure(isFailure: (err: Error) => boolean): this {
    return this.set('isFailure', isFailure);
  }
}

/**
 * Accepted input for the {@link CircuitBreaker} constructor: the fluent
 * {@link CircuitBreakerOptionsBuilder} OR a plain
 * {@link CircuitBreakerOptionsType} object.
 */
export type CircuitBreakerOptions = CircuitBreakerOptionsBuilder | Partial<CircuitBreakerOptionsType>;
/** Value alias so `CircuitBreakerOptions.create()` / `new CircuitBreakerOptions()` resolve to the builder. */
export const CircuitBreakerOptions = CircuitBreakerOptionsBuilder;
