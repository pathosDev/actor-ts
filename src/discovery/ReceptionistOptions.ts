import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { Cluster } from '../cluster/Cluster.js';
import type { ReceptionistSettings } from './Receptionist.js';

/**
 * Fluent builder for {@link ReceptionistSettings}.  Normally you don't
 * touch this directly — `system.extension(ReceptionistId).start(cluster,
 * options)` supplies the `cluster` positionally and only the tunables
 * (`withGossipIntervalMs`) come through the builder.
 */
export class ReceptionistOptions extends OptionsBuilder<ReceptionistSettings> {
  /** Start a fresh builder.  Equivalent to `new ReceptionistOptions()`. */
  static create(): ReceptionistOptions {
    return new ReceptionistOptions();
  }

  /** The cluster this receptionist gossips over.  `null` = single-node (no gossip). */
  withCluster(cluster: Cluster | null): this {
    return this.set('cluster', cluster);
  }

  /** Interval between gossip pushes in milliseconds.  Default: cluster gossip interval. */
  withGossipIntervalMs(gossipIntervalMs: number): this {
    return this.set('gossipIntervalMs', gossipIntervalMs);
  }
}
