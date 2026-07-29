import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/** Plain options-object shape accepted by a {@link FailureDetector}. */
export interface FailureDetectorOptionsType {
  /** How often the detector samples and decides membership health. */
  readonly heartbeatIntervalMs: number;
  /** Time without heartbeat after which a peer is marked unreachable. */
  readonly unreachableAfterMs: number;
  /**
   * Time without heartbeat after which a peer is declared down.  Measured
   * from the last heartbeat like {@link unreachableAfterMs}, *not* added on
   * top of it — so it must be the larger of the two, and the peer spends
   * `downAfterMs - unreachableAfterMs` in the `unreachable` state before
   * being declared down.
   */
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

  /**
   * Time without heartbeat after which a peer is declared down — measured
   * from the last heartbeat, so it must exceed `unreachableAfterMs`.
   */
  withDownAfterMs(ms: number): this {
    return this.set('downAfterMs', ms);
  }
}

/**
 * Validates resolved {@link FailureDetectorOptionsType} settings — every
 * threshold is a positive duration, and `downAfterMs` must exceed
 * `unreachableAfterMs`.
 *
 * The ordering rule is not cosmetic.  `FailureDetector.decide` tests `down`
 * before `unreachable`, both against the time since the last heartbeat, so
 * `downAfterMs <= unreachableAfterMs` makes the `unreachable` branch
 * unreachable code: the peer jumps straight from healthy to down, skipping
 * the state that exists to let a transient network blip recover. Nothing
 * used to reject that configuration.
 */
export class FailureDetectorOptionsValidator extends OptionsValidator<FailureDetectorOptionsType> {
  constructor() {
    super('FailureDetectorOptions');
  }
  protected rules(s: Partial<FailureDetectorOptionsType>): void {
    this.positiveNumber('heartbeatIntervalMs');
    this.positiveNumber('unreachableAfterMs');
    this.positiveNumber('downAfterMs');
    // Cross-field, so it is spelled out rather than delegated to a helper —
    // and only checked when both are present, since an unset optional must
    // still pass and fall through to the defaults.
    if (
      typeof s.unreachableAfterMs === 'number' &&
      typeof s.downAfterMs === 'number' &&
      s.downAfterMs <= s.unreachableAfterMs
    ) {
      this.fail(
        'downAfterMs',
        `must be greater than unreachableAfterMs (${s.unreachableAfterMs}) — it is measured from the last heartbeat, not added to it, so an equal or smaller value would never let a peer be reported unreachable`,
        s.downAfterMs,
      );
    }
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
