import {
  CircuitBreakerOptionsValidator,
  DEFAULT_CIRCUIT_BREAKER_BACKOFF_FACTOR,
  DEFAULT_CIRCUIT_BREAKER_MAX_RESET_TIMEOUT_MS,
  DEFAULT_CIRCUIT_BREAKER_RANDOM_FACTOR,
  type CircuitBreakerOptions,
  type CircuitBreakerOptionsType,
} from './CircuitBreakerOptions.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreakerOpenError extends Error {
  constructor(message = 'circuit breaker is open') {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreakerTimeoutError extends Error {
  constructor(ms: number) {
    super(`call timed out after ${ms}ms`);
    this.name = 'CircuitBreakerTimeoutError';
  }
}

type StateListener = (state: CircuitState) => void;

/**
 * `base × (1 ± randomFactor)`, floored at 0.
 *
 * The fourth local copy of this arithmetic, and deliberately not a call into
 * `pattern/BackoffPolicy`: `exponentialBackoff` hardcodes base 2 and so cannot
 * express `CircuitBreakerOptionsType.backoffFactor`, and it *throws* unless
 * `maxMs` is finite.  `Retry.applyJitter` records the same trade-off for the
 * retry schedule and `BrokerActor._jitteredBackoff` for the reconnect one
 * (#652, #771); the duplication is the house position, not an oversight.
 */
function applyJitter(base: number, randomFactor: number, random: () => number): number {
  if (randomFactor === 0) return base;
  // random() returns [0, 1); map to [-randomFactor, +randomFactor].
  return Math.max(0, base * (1 + (random() * 2 - 1) * randomFactor));
}

/**
 * Three-state circuit breaker.  Wraps calls that might fail — when enough
 * fail in a row the breaker "opens" and refuses further calls for a
 * timeout window.  The first call after the timeout probes the upstream
 * ("half-open"); if it succeeds, the breaker closes and normal operation
 * resumes.
 *
 * Not tied to actors — works with any `() => Promise<T>` factory.  For
 * actor-based usage, wrap `ask(target, msg, timeout)` in the factory.
 *
 * The timeout window is flat by default and stays that way unless
 * `backoffFactor` or `randomFactor` is set: both ship neutral, so a breaker
 * built the way every release before #864 built one behaves identically.  A
 * breaker whose settings should come from HOCON instead is resolved by id
 * through `CircuitBreakerExtension`; this constructor is unchanged and remains
 * the door for one configured in code.
 */
export class CircuitBreaker {
  private _state: CircuitState = 'closed';
  private failureCount = 0;
  private _nextProbeAt = 0;
  private _consecutiveOpens = 0;
  private readonly listeners = new Set<StateListener>();

  public readonly options: CircuitBreakerOptionsType;

  constructor(options: CircuitBreakerOptions) {
    const settings = { ...(options as Partial<CircuitBreakerOptionsType>) };
    new CircuitBreakerOptionsValidator().validate(settings);
    this.options = settings as CircuitBreakerOptionsType;
  }

  get state(): CircuitState { return this._state; }

  /**
   * Epoch milliseconds at which the next call is let through as a probe.  `0`
   * while the breaker has never opened.
   *
   * Public because the reopen window is no longer a constant: with
   * `backoffFactor` or `randomFactor` set it differs per open, and this is the
   * only way for a metric — or a test — to see the schedule without waiting
   * out the delay it is trying to assert.
   */
  get nextProbeAt(): number { return this._nextProbeAt; }

  /**
   * Opens since the breaker last closed — the exponent `backoffFactor` is
   * raised to.  `0` while closed, `1` on the first open.
   */
  get consecutiveOpens(): number { return this._consecutiveOpens; }

  /** Call `factory` under breaker supervision.  Throws `CircuitBreakerOpenError` when open. */
  async call<T>(factory: () => Promise<T>): Promise<T> {
    this.maybeTransitionToHalfOpen();
    if (this._state === 'open') throw new CircuitBreakerOpenError();

    const promise = this.options.callTimeoutMs && this.options.callTimeoutMs > 0
      ? this.applyTimeout(factory(), this.options.callTimeoutMs)
      : factory();

    try {
      const value = await promise;
      this.onSuccess();
      return value;
    } catch (err) {
      const asErr = err instanceof Error ? err : new Error(String(err));
      if (this.countsAsFailure(asErr)) this.onFailure();
      throw asErr;
    }
  }

  /** Observe state transitions — useful for logging/metrics. */
  onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Force the breaker into a specific state (mostly for tests / admin).
   *
   * Every transition into `open` goes through here — the failure-count path,
   * the failed half-open probe, and an admin call alike — so this is where the
   * consecutive-open counter grows and where the reopen window is computed.
   * A forced open therefore counts as an open cycle, which is the consistent
   * reading: an operator holding a dependency open again and again is the same
   * signal as the dependency failing again and again, and the counter is reset
   * by the thing that means recovery, `closed`.  (Resetting it here alongside
   * `failureCount` would be the other consistent-looking choice and is not an
   * option at all: every open runs through this method, so the exponent could
   * never leave 1 and `backoffFactor` would be inert.)
   */
  setState(next: CircuitState): void {
    if (this._state === next) return;
    this._state = next;
    this.failureCount = 0;
    if (next === 'closed') this._consecutiveOpens = 0;
    if (next === 'open') {
      this._consecutiveOpens++;
      this._nextProbeAt = Date.now() + this.reopenDelayMs();
    }
    for (const listener of this.listeners) { try { listener(next); } catch { /* ignore */ } }
  }

  private onSuccess(): void {
    if (this._state === 'half-open') {
      this.setState('closed');
      return;
    }
    this.failureCount = 0;
  }

  private onFailure(): void {
    if (this._state === 'half-open') {
      this.setState('open');
      return;
    }
    this.failureCount++;
    if (this.failureCount >= this.options.maxFailures) {
      this.setState('open');
    }
  }

  /**
   * How long this open should last: the base window grown by
   * `backoffFactor` once per consecutive open, clamped to the ceiling, then
   * spread by the jitter fraction.
   *
   * The clamp is applied before the jitter and not after, unlike `retry`'s
   * double clamp — there the second one exists because the delay is handed to
   * `setTimeout`, whose 32-bit argument turns an overflow into a hot loop.
   * Nothing here reaches a timer: the window is a timestamp compared against
   * `Date.now()` on the next `call()`, so a value past the ceiling costs an
   * over-long wait and not a busy loop, and `maxResetTimeoutMs` is validated
   * finite so the product cannot reach `Infinity` either way.
   */
  private reopenDelayMs(): number {
    const factor = this.options.backoffFactor ?? DEFAULT_CIRCUIT_BREAKER_BACKOFF_FACTOR;
    const ceiling = this.options.maxResetTimeoutMs ?? DEFAULT_CIRCUIT_BREAKER_MAX_RESET_TIMEOUT_MS;
    const randomFactor = this.options.randomFactor ?? DEFAULT_CIRCUIT_BREAKER_RANDOM_FACTOR;
    const grown = Math.min(
      this.options.resetTimeoutMs * Math.pow(factor, this._consecutiveOpens - 1),
      ceiling,
    );
    return applyJitter(grown, randomFactor, this.options.random ?? Math.random);
  }

  /**
   * Whether `error` counts against the breaker.  The operator's name list is
   * consulted first and short-circuits — see
   * `CircuitBreakerOptionsType.ignoredErrorNames` for why that order and not
   * the other one.
   */
  private countsAsFailure(error: Error): boolean {
    if (this.options.ignoredErrorNames?.includes(error.name)) return false;
    return this.options.isFailure?.(error) ?? true;
  }

  private maybeTransitionToHalfOpen(): void {
    if (this._state !== 'open') return;
    if (Date.now() >= this._nextProbeAt) this.setState('half-open');
  }

  private applyTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CircuitBreakerTimeoutError(ms)), ms);
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }
}
