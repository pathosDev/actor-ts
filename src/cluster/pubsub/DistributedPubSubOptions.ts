import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { Config } from '../../config/Config.js';
import type { Cluster } from '../Cluster.js';

/** Built-in default for {@link DistributedPubSubOptionsType.maxSubscribersPerTopic}. */
export const DEFAULT_MAX_SUBSCRIBERS_PER_TOPIC = 10_000;
/** Built-in default for {@link DistributedPubSubOptionsType.maxTopics}. */
export const DEFAULT_MAX_TOPICS = 10_000;
/** Built-in default for {@link DistributedPubSubOptionsType.maxRemoteNodesPerTopic}. */
export const DEFAULT_MAX_REMOTE_NODES_PER_TOPIC = 1_000;
/**
 * Built-in default for {@link DistributedPubSubOptionsType.maxTopicsClaimedPerSender}
 * — the figure #139 proposed: a tenth of {@link DEFAULT_MAX_TOPICS}, so no one
 * peer can fill the topics only peers hold, and above what a node's topic set
 * is in any deployment this was sized against.
 */
export const DEFAULT_MAX_TOPICS_CLAIMED_PER_SENDER = 1_024;

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
   * Most distinct topics this mediator may track **in each of two pools**:
   * topics with a local subscriber, and topics only peers claim (#1074).
   *
   * A local `Subscribe` to a topic with no local subscriber yet is refused
   * once the first pool is full, and a peer's claim to a topic this mediator
   * does not track yet is dropped once the second is.  They used to be one
   * budget, so a peer naming `maxTopics` topics denied every local
   * `Subscribe` to a new one, renewed with each gossip round.  The mediator
   * holds at most twice this many topics.
   */
  readonly maxTopics?: number;
  /** Most remote nodes that may claim subscribers for a single topic. */
  readonly maxRemoteNodesPerTopic?: number;
  /**
   * Most topics one gossip sender may claim (#1074).  Claims past it are
   * dropped and logged, with the sender named, not refused on the wire.
   *
   * What keeps one peer from filling the pool of peer-only topics that
   * {@link maxTopics} bounds: that pool is shared by every peer, and its
   * first occupant would otherwise deny it to the rest.  Raise it on a
   * deployment where one node subscribes to more topics than this, or the
   * topics past it never reach that node from elsewhere.
   */
  readonly maxTopicsClaimedPerSender?: number;
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

  /**
   * Milliseconds between the mediator's periodic pushes of its topic set,
   * each to one random `up` peer.  The mediator runs its own timer: unset,
   * the extension takes `actor-ts.cluster.pub-sub.gossip-interval` (1 s),
   * and it never follows the cluster's gossip interval.
   */
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

  /** Cap on the topics one gossip sender may claim. */
  withMaxTopicsClaimedPerSender(maxTopicsClaimedPerSender: number): this {
    return this.set('maxTopicsClaimedPerSender', maxTopicsClaimedPerSender);
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
    this.positiveInt('maxTopicsClaimedPerSender');
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
  if (config.hasPath(keys.maxTopicsClaimedPerSender)) {
    out.maxTopicsClaimedPerSender = config.getInt(keys.maxTopicsClaimedPerSender);
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
