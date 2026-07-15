import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/** Plain options-object shape accepted by {@link ClusterClientReceptionist.start}. */
export interface ClusterClientReceptionistOptionsType {
  /**
   * Default ask timeout (ms) when a client envelope carries an `askId`.
   * Default: 5_000.
   */
  readonly askTimeoutMs?: number;
}

/**
 * Fluent builder for {@link ClusterClientReceptionistOptionsType}:
 *
 *     receptionist.start(
 *       cluster,
 *       ClusterClientReceptionistOptions.create().withAskTimeoutMs(3_000),
 *     );
 */
export class ClusterClientReceptionistOptionsBuilder extends OptionsBuilder<ClusterClientReceptionistOptionsType> {
  /** Start a fresh builder. */
  static create(): ClusterClientReceptionistOptionsBuilder {
    return new ClusterClientReceptionistOptionsBuilder();
  }

  /** Default ask timeout (ms) for client envelopes carrying an `askId`.  Default 5 s. */
  withAskTimeoutMs(ms: number): this {
    return this.set('askTimeoutMs', ms);
  }
}

/** Validates resolved {@link ClusterClientReceptionistOptionsType} settings. */
export class ClusterClientReceptionistOptionsValidator extends OptionsValidator<ClusterClientReceptionistOptionsType> {
  constructor() {
    super('ClusterClientReceptionistOptions');
  }
  protected rules(_s: Partial<ClusterClientReceptionistOptionsType>): void {
    this.positiveNumber('askTimeoutMs');
  }
}

/**
 * Accepted input for {@link ClusterClientReceptionist.start}: the fluent
 * {@link ClusterClientReceptionistOptionsBuilder} OR a plain
 * {@link ClusterClientReceptionistOptionsType} object.
 */
export type ClusterClientReceptionistOptions =
  | ClusterClientReceptionistOptionsBuilder
  | Partial<ClusterClientReceptionistOptionsType>;
/** Value alias so `ClusterClientReceptionistOptions.create()` / `new ClusterClientReceptionistOptions()` resolve to the builder. */
export const ClusterClientReceptionistOptions = ClusterClientReceptionistOptionsBuilder;
