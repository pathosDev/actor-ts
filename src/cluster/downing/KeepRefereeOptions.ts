import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { KeepRefereeSettings } from './KeepReferee.js';

/**
 * Fluent builder for {@link KeepRefereeSettings}:
 *
 *     new KeepReferee(
 *       KeepRefereeOptions.create().withRefereeAddress('sys@10.0.0.1:2551'),
 *     );
 */
export class KeepRefereeOptions extends OptionsBuilder<KeepRefereeSettings> {
  /** Start a fresh builder. */
  static create(): KeepRefereeOptions {
    return new KeepRefereeOptions();
  }

  /** Fixed referee address; the partition containing it survives. */
  withRefereeAddress(refereeAddress: string): this {
    return this.set('refereeAddress', refereeAddress);
  }

  /** Down everyone if the referee side has fewer than this many members. */
  withDownAllIfBelowQuorum(count: number): this {
    return this.set('downAllIfBelowQuorum', count);
  }
}
