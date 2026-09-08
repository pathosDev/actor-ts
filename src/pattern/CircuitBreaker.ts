import type { Clock } from '../Clock.js';
import { systemClock } from '../Clock.js';
import type { Scheduler } from '../Scheduler.js';
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

  /**
   * Where the reset window is measured.  Resolved once: a breaker's scheduler
   * cannot change, and both readers sit on the protected-call path.
   */
  private readonly clock: Clock;

  /**
   * The same object when one was supplied, `null` when none was.
   *
   * Separate from {@link clock} because the two are used for different things
   * and only one has a free fallback: reading the time falls back to
   * `systemClock`, while arming a timer falls back to `setTimeout` — which is
   * cheaper than any scheduler and is exactly what this always did.
   */
  private readonly scheduler: Scheduler | null;

  constructor(options: CircuitBreakerOptions) {
    const settings = { ...(options as Partial<CircuitBreakerOptionsType>) };
    new CircuitBreakerOptionsValidator().validate(settings);
    this.options = settings as CircuitBreakerOptionsType;
    this.scheduler = this.options.scheduler ?? null;
    this.clock = this.scheduler ?? systemClock;
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

  /**
   * Call `factory` under breaker supervision.  Throws `CircuitBreakerOpenError`
   * when open.
   *
   * `isFailure` classifies *this call's* errors and takes precedence over the
   * instance's {@link CircuitBreakerOptionsType.isFailure}.  It exists because
   * a breaker resolved by id through `CircuitBreakerExtension` is **shared**:
   * the registry hands back the instance that already exists rather than
   * reconfiguring it, so a predicate supplied as a construction option reaches
   * the instance only when its supplier happened to be the first caller.  A
   * classifier that belongs to the protected dependency rather than to one
   * caller therefore has to travel with the call, where no resolution order
   * can drop it (#874).
   *
   * `ignoredErrorNames` is still consulted first and still wins — see there
   * for why the operator's half of the classifier outranks a compiled one,
   * per-call or not.  An excused error is neither a failure nor a success:
   * the consecutive-failure count survives it untouched, so one excused error
   * between every two real ones cannot hold a dead dependency open forever.
   */
  async call<T>(factory: () => Promise<T>, isFailure?: (error: Error) => boolean): Promise<T> {
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
      if (this.countsAsFailure(asErr, isFailure)) this.onFailure();
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
      this._nextProbeAt = this.clock.now() + this.reopenDelayMs();
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
   * over-long wait and not a busy loop.
   *
   * The *growth* is clamped before it is multiplied in, and that half is
   * load-bearing rather than tidy.  A finite `maxResetTimeoutMs` bounds the
   * product but not the factor: `Math.pow` overflows to `Infinity` on its own
   * (2^1024, 10^309), and `0 * Infinity` is `NaN`, which `Math.min` propagates
   * instead of clamping.  A `resetTimeoutMs` of `0` — legal, and the way to
   * say "probe immediately" — with any `backoffFactor > 1` therefore used to
   * schedule `_nextProbeAt = NaN`, and `Date.now() >= NaN` is `false` forever,
   * so the breaker stopped probing a recovered dependency for good (#864).
   * Cutting the growth at the point past which the clamp swallows it anyway
   * keeps `Infinity` out of the multiplication, so no combination of legal
   * options can reach a non-finite window at any open count.
   */
  private reopenDelayMs(): number {
    const factor = this.options.backoffFactor ?? DEFAULT_CIRCUIT_BREAKER_BACKOFF_FACTOR;
    const ceiling = this.options.maxResetTimeoutMs ?? DEFAULT_CIRCUIT_BREAKER_MAX_RESET_TIMEOUT_MS;
    const randomFactor = this.options.randomFactor ?? DEFAULT_CIRCUIT_BREAKER_RANDOM_FACTOR;
    const base = this.options.resetTimeoutMs;
    // A zero base has no useful growth at all — hence the `1` — which is the
    // case that used to produce the `NaN`.
    const maxUsefulGrowth = base > 0 ? ceiling / base : 1;
    const growth = Math.min(Math.pow(factor, this._consecutiveOpens - 1), maxUsefulGrowth);
    const grown = Math.min(base * growth, ceiling);
    return applyJitter(grown, randomFactor, this.options.random ?? Math.random);
  }

  /**
   * Whether `error` counts against the breaker.  The operator's name list is
   * consulted first and short-circuits — see
   * `CircuitBreakerOptionsType.ignoredErrorNames` for why that order and not
   * the other one.
   *
   * Below it, the call's own `isFailure` **replaces** the instance's rather
   * than joining it: the two are the same kind of verdict said by two parties,
   * and the caller is the one that knows what this call means.  Combining them
   * would make a shared instance's option — whose value depends on which
   * caller resolved the id first — silently narrow or widen every other
   * caller's classification.
   */
  private countsAsFailure(error: Error, isFailure: ((error: Error) => boolean) | undefined): boolean {
    if (this.options.ignoredErrorNames?.includes(error.name)) return false;
    return (isFailure ?? this.options.isFailure)?.(error) ?? true;
  }

  private maybeTransitionToHalfOpen(): void {
    if (this._state !== 'open') return;
    if (this.clock.now() >= this._nextProbeAt) this.setState('half-open');
  }

  private applyTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Only where time is virtual, for the reason `ActorRef._virtualScheduler`
      // documents with figures: routing a per-call deadline through a scheduler
      // costs a cancellable and two set operations, and buys nothing when
      // nobody can advance past it (#1424).
      if (this.scheduler !== null && this.scheduler.isVirtual) {
        const armed = this.scheduler.scheduleOnceFunction(
          ms, () => reject(new CircuitBreakerTimeoutError(ms)),
        );
        p.then(
          (v) => { armed.cancel(); resolve(v); },
          (e) => { armed.cancel(); reject(e); },
        );
        return;
      }
      const timer = setTimeout(() => reject(new CircuitBreakerTimeoutError(ms)), ms);
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }
}
