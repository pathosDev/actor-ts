import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/** Plain options-object shape accepted by a {@link PhiAccrualFailureDetector}. */
export type PhiAccrualOptionsType = {
  /** Intended heartbeat cadence.  Used to keep `interval` compatible with FailureDetector. */
  readonly heartbeatIntervalMs: number;
  /** Phi value above which the peer is flagged unreachable.  Typical 8–12. */
  readonly unreachableThreshold: number;
  /** Phi value above which the peer is flagged down.  Must be > unreachableThreshold. */
  readonly downThreshold: number;
  /** How many recent intervals to keep in the sliding window. */
  readonly maxSampleSize: number;
  /** Minimum stddev floor — avoids over-eager flagging for very stable peers. */
  readonly minStdDeviationMs: number;
  /**
   * Grace period added to the most recent heartbeat — heartbeats that
   * arrive up to `acceptableHeartbeatPauseMs` late do not raise phi.
   */
  readonly acceptableHeartbeatPauseMs: number;
  /**
   * The inter-arrival time φ assumes before a peer has a history: the mean
   * of its estimate on first contact, with a deviation of a quarter of it
   * (never below {@link minStdDeviationMs}).  It judges a peer from its first
   * frame until real heartbeat intervals wash the estimate out.
   *
   * `'auto'` is {@link heartbeatIntervalMs} — the cadence the cluster imposes
   * on the detector — so a heartbeat-interval tuned in HOCON or in code
   * carries the estimate with it, and the cadence stays single-sourced
   * (#1142).  A number decouples the two: a more forgiving first contact,
   * say, without the steady-state cost of a larger pause (#1451).
   */
  readonly expectedResponseAfterMs: number | 'auto';
};

/**
 * Fluent builder for {@link PhiAccrualOptionsType}.  Unset fields fall
 * through to {@link defaultPhiAccrualOptions} in the constructor, so a
 * bare `PhiAccrualOptions.create()` yields the defaults.
 *
 *     new PhiAccrualFailureDetector(
 *       PhiAccrualOptions.create().withUnreachableThreshold(10).withDownThreshold(16),
 *     )
 */
export class PhiAccrualOptionsBuilder extends OptionsBuilder<PhiAccrualOptionsType> {
  /** Start a fresh builder.  Equivalent to `new PhiAccrualOptionsBuilder()`. */
  static create(): PhiAccrualOptionsBuilder {
    return new PhiAccrualOptionsBuilder();
  }

  /** Intended heartbeat cadence — keeps `interval` compatible with FailureDetector. */
  withHeartbeatIntervalMs(ms: number): this {
    return this.set('heartbeatIntervalMs', ms);
  }

  /** Phi value above which the peer is flagged unreachable.  Typical 8–12. */
  withUnreachableThreshold(phi: number): this {
    return this.set('unreachableThreshold', phi);
  }

  /** Phi value above which the peer is flagged down.  Must exceed `unreachableThreshold`. */
  withDownThreshold(phi: number): this {
    return this.set('downThreshold', phi);
  }

  /** How many recent intervals to keep in the sliding window. */
  withMaxSampleSize(n: number): this {
    return this.set('maxSampleSize', n);
  }

  /** Minimum stddev floor — avoids over-eager flagging for very stable peers. */
  withMinStdDeviationMs(ms: number): this {
    return this.set('minStdDeviationMs', ms);
  }

  /** Grace period added to the most recent heartbeat before phi rises. */
  withAcceptableHeartbeatPauseMs(ms: number): this {
    return this.set('acceptableHeartbeatPauseMs', ms);
  }

  /** The inter-arrival time assumed before a peer has a history — `'auto'` follows the cadence. */
  withExpectedResponseAfterMs(ms: number | 'auto'): this {
    return this.set('expectedResponseAfterMs', ms);
  }
}

/**
 * Validates resolved {@link PhiAccrualOptionsType} settings — every field is
 * a positive duration/count, and `downThreshold` must exceed
 * `unreachableThreshold` (a non-strictly-ordered pair would flag peers down
 * before they are ever unreachable).
 */
export class PhiAccrualOptionsValidator extends OptionsValidator<PhiAccrualOptionsType> {
  constructor() {
    super('PhiAccrualOptions');
  }
  protected rules(s: Partial<PhiAccrualOptionsType>): void {
    this.positiveNumber('heartbeatIntervalMs');
    this.positiveNumber('unreachableThreshold');
    this.positiveNumber('downThreshold');
    this.positiveInt('maxSampleSize');
    this.positiveNumber('minStdDeviationMs');
    this.nonNegativeNumber('acceptableHeartbeatPauseMs');
    // `number | 'auto'`, so the field-name helpers can't address it.  Zero is
    // refused with the rest: an estimate of no time at all is a mean of 0 and
    // a deviation at the floor, which flags a new peer some 700 ms after its
    // first frame — the defect this field exists to keep away (#1451).
    const estimate = s.expectedResponseAfterMs;
    if (
      estimate !== undefined && estimate !== 'auto'
      && (typeof estimate !== 'number' || !Number.isFinite(estimate) || estimate <= 0)
    ) {
      this.fail('expectedResponseAfterMs', "must be a positive finite number or 'auto'", estimate);
    }
    if (
      s.downThreshold !== undefined &&
      s.unreachableThreshold !== undefined &&
      s.downThreshold <= s.unreachableThreshold
    ) {
      this.fail('downThreshold', 'must exceed unreachableThreshold', s.downThreshold);
    }
  }
}

/**
 * Accepted input for any PhiAccrual-configurable constructor: the fluent
 * {@link PhiAccrualOptionsBuilder} OR a plain {@link PhiAccrualOptionsType}
 * object.
 */
export type PhiAccrualOptions = PhiAccrualOptionsBuilder | Partial<PhiAccrualOptionsType>;
/** Value alias so `PhiAccrualOptions.create()` / `new PhiAccrualOptions()` resolve to the builder. */
export const PhiAccrualOptions = PhiAccrualOptionsBuilder;
