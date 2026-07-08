import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { Cluster } from '../Cluster.js';

/** Plain settings-object shape consumed by a {@link DistributedPubSubMediator}. */
export interface DistributedPubSubOptionsType {
  readonly cluster: Cluster;
  readonly gossipIntervalMs?: number;
}

/**
 * Fluent builder for {@link DistributedPubSubOptionsType}.  The mediator is
 * normally spawned by the {@link DistributedPubSub} extension, which
 * injects the cluster and forwards the operator's gossip-interval choice.
 */
export class DistributedPubSubOptionsBuilder extends OptionsBuilder<DistributedPubSubOptionsType> {
  /** Start a fresh builder. */
  static create(): DistributedPubSubOptionsBuilder {
    return new DistributedPubSubOptionsBuilder();
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

/** Validates resolved {@link DistributedPubSubOptionsType} settings. */
export class DistributedPubSubOptionsValidator extends OptionsValidator<DistributedPubSubOptionsType> {
  constructor() {
    super('DistributedPubSubOptions');
  }
  protected rules(_s: Partial<DistributedPubSubOptionsType>): void {
    this.positiveNumber('gossipIntervalMs');
  }
}

/**
 * Accepted input for a {@link DistributedPubSubMediator}: the fluent
 * {@link DistributedPubSubOptionsBuilder} OR a plain (partial)
 * {@link DistributedPubSubOptionsType} object.
 */
export type DistributedPubSubOptions = DistributedPubSubOptionsBuilder | Partial<DistributedPubSubOptionsType>;
/** Value alias so `DistributedPubSubOptions.create()` resolves to the builder. */
export const DistributedPubSubOptions = DistributedPubSubOptionsBuilder;
