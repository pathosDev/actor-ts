import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { FailureDetectorSettings } from './FailureDetector.js';

/**
 * Fluent builder for {@link FailureDetectorSettings}.  Unset fields fall
 * through to {@link defaultFailureDetectorSettings} in the consumer, so a
 * bare `FailureDetectorOptions.create()` yields the defaults.
 *
 *     new FailureDetector(
 *       FailureDetectorOptions.create().withUnreachableAfterMs(3_000),
 *     )
 */
export class FailureDetectorOptions extends OptionsBuilder<FailureDetectorSettings> {
  /** Start a fresh builder.  Equivalent to `new FailureDetectorOptions()`. */
  static create(): FailureDetectorOptions {
    return new FailureDetectorOptions();
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
