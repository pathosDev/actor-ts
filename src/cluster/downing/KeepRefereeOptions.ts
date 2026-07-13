import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

/** Plain options-object shape accepted by {@link KeepReferee}. */
export interface KeepRefereeOptionsType {
  /**
   * Fixed "referee" address; whichever partition contains it survives.
   * Must match the address format returned by `NodeAddress.toString()`.
   */
  readonly refereeAddress: string;
  /** Additional quorum a.k.a. down-all-if-referee-reachable-but-too-few. */
  readonly downAllIfBelowQuorum?: number;
}

/**
 * Fluent builder for {@link KeepRefereeOptionsType}:
 *
 *     new KeepReferee(
 *       KeepRefereeOptions.create().withRefereeAddress('sys@10.0.0.1:2551'),
 *     );
 */
export class KeepRefereeOptionsBuilder extends OptionsBuilder<KeepRefereeOptionsType> {
  /** Start a fresh builder. */
  static create(): KeepRefereeOptionsBuilder {
    return new KeepRefereeOptionsBuilder();
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

/** Validates resolved {@link KeepRefereeOptionsType} settings. */
export class KeepRefereeOptionsValidator extends OptionsValidator<KeepRefereeOptionsType> {
  constructor() {
    super('KeepRefereeOptions');
  }
  protected rules(s: Partial<KeepRefereeOptionsType>): void {
    if (s.refereeAddress === undefined) this.fail('refereeAddress', 'is required');
    this.nonEmptyString('refereeAddress');
    this.positiveInt('downAllIfBelowQuorum');
  }
}

/**
 * Accepted input for the {@link KeepReferee} constructor: the fluent
 * {@link KeepRefereeOptionsBuilder} OR a plain {@link KeepRefereeOptionsType}
 * object.
 */
export type KeepRefereeOptions = KeepRefereeOptionsBuilder | Partial<KeepRefereeOptionsType>;
/** Value alias so `KeepRefereeOptions.create()` / `new KeepRefereeOptions()` resolve to the builder. */
export const KeepRefereeOptions = KeepRefereeOptionsBuilder;
