import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { ClusterClientReceptionistSettings } from './ClusterClientReceptionist.js';

/**
 * Fluent builder for {@link ClusterClientReceptionistSettings}:
 *
 *     receptionist.start(
 *       cluster,
 *       ClusterClientReceptionistOptions.create().withAskTimeoutMs(3_000),
 *     );
 */
export class ClusterClientReceptionistOptions extends OptionsBuilder<ClusterClientReceptionistSettings> {
  /** Start a fresh builder. */
  static create(): ClusterClientReceptionistOptions {
    return new ClusterClientReceptionistOptions();
  }

  /** Default ask timeout (ms) for client envelopes carrying an `askId`.  Default 5 s. */
  withAskTimeoutMs(ms: number): this {
    return this.set('askTimeoutMs', ms);
  }
}
