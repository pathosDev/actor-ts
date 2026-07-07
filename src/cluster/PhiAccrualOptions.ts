import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { PhiAccrualSettings } from './PhiAccrualFailureDetector.js';

/**
 * Fluent builder for {@link PhiAccrualSettings}.  Unset fields fall
 * through to {@link defaultPhiAccrualSettings} in the constructor, so a
 * bare `PhiAccrualOptions.create()` yields the defaults.
 *
 *     new PhiAccrualFailureDetector(
 *       PhiAccrualOptions.create().withUnreachableThreshold(10).withDownThreshold(16),
 *     )
 */
export class PhiAccrualOptions extends OptionsBuilder<PhiAccrualSettings> {
  /** Start a fresh builder.  Equivalent to `new PhiAccrualOptions()`. */
  static create(): PhiAccrualOptions {
    return new PhiAccrualOptions();
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
