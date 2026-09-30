/** Options for the {@link requestTimeout} middleware.  Options-only. */
import { MAX_TIMER_DELAY_MS } from '../../pattern/Constants.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { HttpRequest, HttpResponse } from '../Types.js';

/** Plain settings shape for the request-timeout middleware. */
export type TimeoutOptionsType = {
  /** Deadline in milliseconds.  Default 30000. */
  readonly ms?: number;
  /** Response produced on timeout.  Default 503 `{ error: 'request timed out' }`. */
  readonly onTimeout?: (request: HttpRequest) => HttpResponse;
};

/** Fluent builder for {@link TimeoutOptionsType}. */
export class TimeoutOptionsBuilder extends OptionsBuilder<TimeoutOptionsType> {
  static create(): TimeoutOptionsBuilder {
    return new TimeoutOptionsBuilder();
  }
  withMs(ms: number): this {
    return this.set('ms', ms);
  }
  withOnTimeout(onTimeout: (request: HttpRequest) => HttpResponse): this {
    return this.set('onTimeout', onTimeout);
  }
}

/** Accepted input: the builder or a plain object. */
export type TimeoutOptions = TimeoutOptionsBuilder | Partial<TimeoutOptionsType>;
export const TimeoutOptions = TimeoutOptionsBuilder;

/**
 * Validates resolved {@link TimeoutOptionsType} settings — a timeout
 * deadline (`ms`) must be a positive finite number no larger than a timer can
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
    this.positiveNumber('ms');
    if (s.ms !== undefined && s.ms > MAX_TIMER_DELAY_MS) {
      this.fail('ms', `must be at most ${MAX_TIMER_DELAY_MS} — a timer cannot hold a longer delay, and a runtime arms it as 1 ms instead`, s.ms);
    }
  }
}
