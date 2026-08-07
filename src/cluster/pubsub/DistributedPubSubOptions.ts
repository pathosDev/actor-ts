import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { Config } from '../../config/Config.js';
import type { Cluster } from '../Cluster.js';

/** Plain options-object shape consumed by a {@link DistributedPubSubMediator}. */
export type DistributedPubSubOptionsType = {
  readonly cluster: Cluster;
  readonly gossipIntervalMs?: number;
  /**
   * Most local subscribers one topic may hold.  A `Subscribe` beyond it is
   * answered with `SubscribeRejected` instead of growing the set.
   */
  readonly maxSubscribersPerTopic?: number;
  /**
   * Most distinct topics this mediator may track.  Bounds both axes a peer
   * can push on: local `Subscribe` messages and gossiped topic names.
   */
  readonly maxTopics?: number;
  /** Most remote nodes that may claim subscribers for a single topic. */
  readonly maxRemoteNodesPerTopic?: number;
  /**
   * Route a `Publish` that reached nobody to `system.deadLetters` instead of
   * discarding it.  On by default — an unrouted publish is a bug worth
   * seeing, and dead letters are the framework's channel for exactly that.
   */
  readonly sendToDeadLettersWhenNoSubscribers?: boolean;
};

/**
 * Fluent builder for {@link DistributedPubSubOptionsType}.  The mediator is
 * normally spawned by the {@link DistributedPubSub} extension, which
 * injects the cluster and forwards the operator's tuning choices.
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

  /** Cap on the local subscribers a single topic may hold. */
  withMaxSubscribersPerTopic(maxSubscribersPerTopic: number): this {
    return this.set('maxSubscribersPerTopic', maxSubscribersPerTopic);
  }

  /** Cap on the distinct topics this mediator tracks. */
  withMaxTopics(maxTopics: number): this {
    return this.set('maxTopics', maxTopics);
  }

  /** Cap on the remote nodes that may claim subscribers for one topic. */
  withMaxRemoteNodesPerTopic(maxRemoteNodesPerTopic: number): this {
    return this.set('maxRemoteNodesPerTopic', maxRemoteNodesPerTopic);
  }

  /** Send a publish that reached no subscriber to `system.deadLetters`. */
  withSendToDeadLettersWhenNoSubscribers(sendToDeadLettersWhenNoSubscribers: boolean): this {
    return this.set('sendToDeadLettersWhenNoSubscribers', sendToDeadLettersWhenNoSubscribers);
  }
}

/** Validates resolved {@link DistributedPubSubOptionsType} settings. */
export class DistributedPubSubOptionsValidator extends OptionsValidator<DistributedPubSubOptionsType> {
  constructor() {
    super('DistributedPubSubOptions');
  }
  protected rules(_s: Partial<DistributedPubSubOptionsType>): void {
    this.positiveNumber('gossipIntervalMs');
    this.positiveInt('maxSubscribersPerTopic');
    this.positiveInt('maxTopics');
    this.positiveInt('maxRemoteNodesPerTopic');
  }
}

/**
 * Read `actor-ts.cluster.pub-sub.*` into the shape the extension layers
 * under the caller's options.  Only keys actually present are returned, so
 * an absent one falls through to the built-in default instead of landing as
 * an explicit `undefined` — the rule `mergeOptions` encodes.
 *
 * `cluster` has no leaf here on purpose: it is wiring, not a tunable, and it
 * is an object HOCON cannot express.
 */
export function readDistributedPubSubOptionsFromConfig(
  config: Config,
): Partial<DistributedPubSubOptionsType> {
  const keys = ConfigKeys.cluster.pubSub;
  const out: {
    -readonly [K in keyof DistributedPubSubOptionsType]?: DistributedPubSubOptionsType[K]
  } = {};
  if (config.hasPath(keys.gossipInterval)) out.gossipIntervalMs = config.getDuration(keys.gossipInterval);
  if (config.hasPath(keys.maxSubscribersPerTopic)) {
    out.maxSubscribersPerTopic = config.getInt(keys.maxSubscribersPerTopic);
  }
  if (config.hasPath(keys.maxTopics)) out.maxTopics = config.getInt(keys.maxTopics);
  if (config.hasPath(keys.maxRemoteNodesPerTopic)) {
    out.maxRemoteNodesPerTopic = config.getInt(keys.maxRemoteNodesPerTopic);
  }
  if (config.hasPath(keys.sendToDeadLettersWhenNoSubscribers)) {
    out.sendToDeadLettersWhenNoSubscribers = config.getBoolean(keys.sendToDeadLettersWhenNoSubscribers);
  }
  return out;
}

/**
 * Accepted input for a {@link DistributedPubSubMediator}: the fluent
 * {@link DistributedPubSubOptionsBuilder} OR a plain (partial)
 * {@link DistributedPubSubOptionsType} object.
 */
export type DistributedPubSubOptions = DistributedPubSubOptionsBuilder | Partial<DistributedPubSubOptionsType>;
/** Value alias so `DistributedPubSubOptions.create()` resolves to the builder. */
export const DistributedPubSubOptions = DistributedPubSubOptionsBuilder;
