export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerSettings {
  /** Consecutive failures before the breaker opens.  Must be >= 1. */
  readonly maxFailures: number;
  /** How long the breaker stays open before letting a probe through.  ms. */
  readonly resetTimeoutMs: number;
  /** Per-call timeout; exceeding this counts as a failure. */
  readonly callTimeoutMs?: number;
  /** Optional: classify errors as non-failures to bypass breaker counting. */
  readonly isFailure?: (err: Error) => boolean;
}

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
 * Three-state circuit breaker.  Wraps calls that might fail — when enough
 * fail in a row the breaker "opens" and refuses further calls for a
 * timeout window.  The first call after the timeout probes the upstream
 * ("half-open"); if it succeeds, the breaker closes and normal operation
 * resumes.
 *
 * Not tied to actors — works with any `() => Promise<T>` factory.  For
 * actor-based usage, wrap `ask(target, msg, timeout)` in the factory.
 */
export class CircuitBreaker {
  private _state: CircuitState = 'closed';
  private failureCount = 0;
  private nextProbeAt = 0;
  private readonly listeners = new Set<StateListener>();

  constructor(public readonly settings: CircuitBreakerSettings) {
    if (settings.maxFailures < 1) {
      throw new Error('CircuitBreaker: maxFailures must be >= 1');
    }
    if (settings.resetTimeoutMs < 0) {
      throw new Error('CircuitBreaker: resetTimeoutMs must be >= 0');
    }
  }

  get state(): CircuitState { return this._state; }

  /** Call `factory` under breaker supervision.  Throws `CircuitBreakerOpenError` when open. */
  async call<T>(factory: () => Promise<T>): Promise<T> {
    this.maybeTransitionToHalfOpen();
    if (this._state === 'open') throw new CircuitBreakerOpenError();

    const promise = this.settings.callTimeoutMs && this.settings.callTimeoutMs > 0
      ? this.applyTimeout(factory(), this.settings.callTimeoutMs)
      : factory();

    try {
      const value = await promise;
      this.onSuccess();
      return value;
    } catch (err) {
      const asErr = err instanceof Error ? err : new Error(String(err));
      const isFailure = this.settings.isFailure?.(asErr) ?? true;
      if (isFailure) this.onFailure();
      throw asErr;
    }
  }

  /** Observe state transitions — useful for logging/metrics. */
  onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Force the breaker into a specific state (mostly for tests / admin). */
  setState(next: CircuitState): void {
    if (this._state === next) return;
    this._state = next;
    this.failureCount = 0;
    if (next === 'open') this.nextProbeAt = Date.now() + this.settings.resetTimeoutMs;
    for (const l of this.listeners) { try { l(next); } catch { /* ignore */ } }
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
    if (this.failureCount >= this.settings.maxFailures) {
      this.setState('open');
    }
  }

  private maybeTransitionToHalfOpen(): void {
    if (this._state !== 'open') return;
    if (Date.now() >= this.nextProbeAt) this.setState('half-open');
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
