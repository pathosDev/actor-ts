import { OptionsBuilder } from '../util/OptionsBuilder.js';

/** Plain options-object shape accepted by a {@link PhiAccrualFailureDetector}. */
export interface PhiAccrualOptionsType {
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
}

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
}

/**
 * Accepted input for any PhiAccrual-configurable constructor: the fluent
 * {@link PhiAccrualOptionsBuilder} OR a plain {@link PhiAccrualOptionsType}
 * object.
 */
export type PhiAccrualOptions = PhiAccrualOptionsBuilder | Partial<PhiAccrualOptionsType>;
/** Value alias so `PhiAccrualOptions.create()` / `new PhiAccrualOptions()` resolve to the builder. */
export const PhiAccrualOptions = PhiAccrualOptionsBuilder;
