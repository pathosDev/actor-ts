import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

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
 * Validates resolved {@link CircuitBreakerOptionsType} settings.
 * `maxFailures` and `resetTimeoutMs` are required at runtime too — a breaker
 * without them would silently never open / never probe.
 */
export class CircuitBreakerOptionsValidator extends OptionsValidator<CircuitBreakerOptionsType> {
  constructor() {
    super('CircuitBreakerOptions');
  }
  protected rules(s: Partial<CircuitBreakerOptionsType>): void {
    if (s.maxFailures === undefined) this.fail('maxFailures', 'is required');
    if (s.resetTimeoutMs === undefined) this.fail('resetTimeoutMs', 'is required');
    this.positiveInt('maxFailures');
    this.nonNegativeNumber('resetTimeoutMs');
    this.positiveNumber('callTimeoutMs');
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
