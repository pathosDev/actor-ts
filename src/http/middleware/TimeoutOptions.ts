/** Options for the {@link requestTimeout} middleware.  Options-only. */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { HttpRequest, HttpResponse } from '../types.js';

/** Plain settings shape for the request-timeout middleware. */
export interface TimeoutOptionsType {
  /** Deadline in milliseconds.  Default 30000. */
  readonly ms?: number;
  /** Response produced on timeout.  Default 503 `{ error: 'request timed out' }`. */
  readonly onTimeout?: (req: HttpRequest) => HttpResponse;
}

/** Fluent builder for {@link TimeoutOptionsType}. */
export class TimeoutOptionsBuilder extends OptionsBuilder<TimeoutOptionsType> {
  static create(): TimeoutOptionsBuilder {
    return new TimeoutOptionsBuilder();
  }
  withMs(ms: number): this {
    return this.set('ms', ms);
  }
  withOnTimeout(fn: (req: HttpRequest) => HttpResponse): this {
    return this.set('onTimeout', fn);
  }
}

/** Accepted input: the builder or a plain object. */
export type TimeoutOptions = TimeoutOptionsBuilder | Partial<TimeoutOptionsType>;
export const TimeoutOptions = TimeoutOptionsBuilder;

/**
 * Validates resolved {@link TimeoutOptionsType} settings — a timeout
 * deadline (`ms`) must be a positive finite number.  Runs from any input
 * path (bare number, plain object, builder) since it checks the resolved bag.
 */
export class TimeoutOptionsValidator extends OptionsValidator<TimeoutOptionsType> {
  constructor() {
    super('TimeoutOptions');
  }
  protected rules(_s: Partial<TimeoutOptionsType>): void {
    this.positiveNumber('ms');
  }
}
