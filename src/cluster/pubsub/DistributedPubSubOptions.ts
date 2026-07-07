import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Cluster } from '../Cluster.js';
import type { DistributedPubSubSettings } from './DistributedPubSubMediator.js';

/**
 * Fluent builder for {@link DistributedPubSubSettings}.  The mediator is
 * normally spawned by the {@link DistributedPubSub} extension, which
 * injects the cluster and forwards the operator's gossip-interval choice.
 */
export class DistributedPubSubOptions extends OptionsBuilder<DistributedPubSubSettings> {
  /** Start a fresh builder. */
  static create(): DistributedPubSubOptions {
    return new DistributedPubSubOptions();
  }

  /** The cluster this mediator lives in — drives membership + gossip peers. */
  withCluster(cluster: Cluster): this {
    return this.set('cluster', cluster);
  }

  /** Gossip interval in ms between anti-entropy pushes.  Default gossip interval. */
  withGossipIntervalMs(ms: number): this {
    return this.set('gossipIntervalMs', ms);
  }
}
