/**
 * Options for the {@link requestTimeout} middleware.
 *
 * `deadlineMs` also has a leaf, `deadline`, in `actor-ts.http.request-timeout`
 * (#1463), merged in when the route tree is compiled: options > HOCON >
 * built-in, then this validator once on the result.  `onTimeout` is a
 * function, so it has no leaf and stays code-only.
 */
import { MAX_TIMER_DELAY_MS } from '../../util/Constants.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { HttpRequest, HttpResponse } from '../Types.js';

/** Built-in handler deadline, 30 s — what `requestTimeout()` holds a handler to when its options name none. */
export const DEFAULT_REQUEST_TIMEOUT_DEADLINE_MS = 30_000;

/** Plain settings shape for the request-timeout middleware. */
export type TimeoutOptionsType = {
  /**
   * How long the handler may take to answer, in milliseconds.  Default
   * {@link DEFAULT_REQUEST_TIMEOUT_DEADLINE_MS} (30000).
   *
   * Named for what it bounds rather than for its unit: the field used to be
   * `ms`, which is nothing but a unit suffix and so left a configuration leaf
   * nothing to be called once the suffix is dropped (#1463).
   */
  readonly deadlineMs?: number;
  /**
   * Response produced on timeout.  Default 503 `{ error: 'request timed out' }`.
   * Code-only: a function has no HOCON spelling.
   */
  readonly onTimeout?: (request: HttpRequest) => HttpResponse;
};

/** Fluent builder for {@link TimeoutOptionsType}. */
export class TimeoutOptionsBuilder extends OptionsBuilder<TimeoutOptionsType> {
  static create(): TimeoutOptionsBuilder {
    return new TimeoutOptionsBuilder();
  }
  withDeadlineMs(deadlineMs: number): this {
    return this.set('deadlineMs', deadlineMs);
  }
  withOnTimeout(onTimeout: (request: HttpRequest) => HttpResponse): this {
    return this.set('onTimeout', onTimeout);
  }
}

/** Accepted input: the builder or a plain object. */
export type TimeoutOptions = TimeoutOptionsBuilder | Partial<TimeoutOptionsType>;
export const TimeoutOptions = TimeoutOptionsBuilder;

/**
 * Validates resolved {@link TimeoutOptionsType} settings — a deadline
 * (`deadlineMs`) must be a positive finite number no larger than a timer can
 * hold.  Runs from any input path (bare number, plain object, builder) since
 * it checks the resolved bag.
 *
 * The upper bound is {@link MAX_TIMER_DELAY_MS}: `setTimeout` arms anything
 * larger as 1 ms, so a deadline written as "effectively never" answered every
 * request 503 almost at once (#1463).
 */
export class TimeoutOptionsValidator extends OptionsValidator<TimeoutOptionsType> {
  constructor() {
    super('TimeoutOptions');
  }
  protected rules(s: Partial<TimeoutOptionsType>): void {
    this.positiveNumber('deadlineMs');
    if (s.deadlineMs !== undefined && s.deadlineMs > MAX_TIMER_DELAY_MS) {
      this.fail('deadlineMs', `must be at most ${MAX_TIMER_DELAY_MS} — a timer cannot hold a longer delay, and a runtime arms it as 1 ms instead`, s.deadlineMs);
    }
  }
}
