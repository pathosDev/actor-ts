import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/** Plain options-object shape accepted by a {@link FailureDetector}. */
export interface FailureDetectorOptionsType {
  /** How often the detector samples and decides membership health. */
  readonly heartbeatIntervalMs: number;
  /** Time without heartbeat after which a peer is marked unreachable. */
  readonly unreachableAfterMs: number;
  /** Additional time after which an unreachable peer is declared down. */
  readonly downAfterMs: number;
}

/**
 * Fluent builder for {@link FailureDetectorOptionsType}.  Unset fields fall
 * through to {@link defaultFailureDetectorOptions} in the consumer, so a
 * bare `FailureDetectorOptions.create()` yields the defaults.
 *
 *     new FailureDetector(
 *       FailureDetectorOptions.create().withUnreachableAfterMs(3_000),
 *     )
 */
export class FailureDetectorOptionsBuilder extends OptionsBuilder<FailureDetectorOptionsType> {
  /** Start a fresh builder.  Equivalent to `new FailureDetectorOptionsBuilder()`. */
  static create(): FailureDetectorOptionsBuilder {
    return new FailureDetectorOptionsBuilder();
  }

  /** How often the detector samples and decides membership health. */
  withHeartbeatIntervalMs(ms: number): this {
    return this.set('heartbeatIntervalMs', ms);
  }

  /** Time without heartbeat after which a peer is marked unreachable. */
  withUnreachableAfterMs(ms: number): this {
    return this.set('unreachableAfterMs', ms);
  }

  /** Additional time after which an unreachable peer is declared down. */
  withDownAfterMs(ms: number): this {
    return this.set('downAfterMs', ms);
  }
}

/**
 * Validates resolved {@link FailureDetectorOptionsType} settings — every
 * threshold is a positive duration.  (`downAfterMs` is additive time on top
 * of `unreachableAfterMs`, not an absolute deadline, so the two are not
 * ordered against each other.)
 */
export class FailureDetectorOptionsValidator extends OptionsValidator<FailureDetectorOptionsType> {
  constructor() {
    super('FailureDetectorOptions');
  }
  protected rules(_s: Partial<FailureDetectorOptionsType>): void {
    this.positiveNumber('heartbeatIntervalMs');
    this.positiveNumber('unreachableAfterMs');
    this.positiveNumber('downAfterMs');
  }
}

/**
 * Accepted input for any FailureDetector-configurable constructor: the
 * fluent {@link FailureDetectorOptionsBuilder} OR a plain
 * {@link FailureDetectorOptionsType} object.
 */
export type FailureDetectorOptions = FailureDetectorOptionsBuilder | Partial<FailureDetectorOptionsType>;
/** Value alias so `FailureDetectorOptions.create()` / `new FailureDetectorOptions()` resolve to the builder. */
export const FailureDetectorOptions = FailureDetectorOptionsBuilder;
