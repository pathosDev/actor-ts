import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import type { Config } from '../config/Config.js';
import type { Cluster } from '../cluster/Cluster.js';

/** Built-in default for {@link ReceptionistOptionsType.maxSubscribersPerKey}. */
export const DEFAULT_MAX_SUBSCRIBERS_PER_KEY = 1_000;
/** Built-in default for {@link ReceptionistOptionsType.maxSubscribersTotal}. */
export const DEFAULT_MAX_SUBSCRIBERS_TOTAL = 10_000;

/** Plain options-object shape accepted by a {@link Receptionist}. */
export type ReceptionistOptionsType = {
  readonly cluster?: Cluster | null;
  readonly gossipIntervalMs?: number;
  /**
   * Most subscribers one service key may hold.  A `Subscribe` beyond it is
   * answered with `SubscribeRejected` instead of growing the set.
   */
  readonly maxSubscribersPerKey?: number;
  /** Most subscribers this receptionist may hold across all keys together. */
  readonly maxSubscribersTotal?: number;
};

/**
 * Fluent builder for {@link ReceptionistOptionsType}.  Normally you don't
 * touch this directly — `system.extension(ReceptionistId).start(cluster,
 * options)` supplies the `cluster` positionally and only the tunables
 * (`withGossipIntervalMs`, the two caps) come through the builder.
 */
export class ReceptionistOptionsBuilder extends OptionsBuilder<ReceptionistOptionsType> {
  /** Start a fresh builder.  Equivalent to `new ReceptionistOptionsBuilder()`. */
  static create(): ReceptionistOptionsBuilder {
    return new ReceptionistOptionsBuilder();
  }

  /** The cluster this receptionist gossips over.  `null` = single-node (no gossip). */
  withCluster(cluster: Cluster | null): this {
    return this.set('cluster', cluster);
  }

  /** Interval between gossip pushes in milliseconds.  Default: cluster gossip interval. */
  withGossipIntervalMs(gossipIntervalMs: number): this {
    return this.set('gossipIntervalMs', gossipIntervalMs);
  }

  /** Cap on the subscribers a single service key may hold. */
  withMaxSubscribersPerKey(maxSubscribersPerKey: number): this {
    return this.set('maxSubscribersPerKey', maxSubscribersPerKey);
  }

  /** Cap on the subscribers this receptionist holds across every key. */
  withMaxSubscribersTotal(maxSubscribersTotal: number): this {
    return this.set('maxSubscribersTotal', maxSubscribersTotal);
  }
}

/** Validates resolved {@link ReceptionistOptionsType} settings. */
export class ReceptionistOptionsValidator extends OptionsValidator<ReceptionistOptionsType> {
  constructor() {
    super('ReceptionistOptions');
  }
  protected rules(_s: Partial<ReceptionistOptionsType>): void {
    this.positiveNumber('gossipIntervalMs');
    this.positiveInt('maxSubscribersPerKey');
    this.positiveInt('maxSubscribersTotal');
  }
}

/**
 * Read `actor-ts.cluster.receptionist.*` into the shape the extension layers
 * under the caller's options.  Only keys actually present are returned, so
 * an absent one falls through to the built-in default instead of landing as
 * an explicit `undefined` — the rule `mergeOptions` encodes.
 *
 * `cluster` has no leaf here on purpose: it is wiring, not a tunable, and it
 * is an object HOCON cannot express.
 */
export function readReceptionistOptionsFromConfig(config: Config): Partial<ReceptionistOptionsType> {
  const keys = ConfigKeys.cluster.receptionist;
  const out: { -readonly [K in keyof ReceptionistOptionsType]?: ReceptionistOptionsType[K] } = {};
  if (config.hasPath(keys.gossipInterval)) out.gossipIntervalMs = config.getDuration(keys.gossipInterval);
  if (config.hasPath(keys.maxSubscribersPerKey)) {
    out.maxSubscribersPerKey = config.getInt(keys.maxSubscribersPerKey);
  }
  if (config.hasPath(keys.maxSubscribersTotal)) {
    out.maxSubscribersTotal = config.getInt(keys.maxSubscribersTotal);
  }
  return out;
}

/**
 * Accepted input for the {@link Receptionist} constructor: the fluent
 * {@link ReceptionistOptionsBuilder} OR a plain {@link ReceptionistOptionsType}
 * object.
 */
export type ReceptionistOptions = ReceptionistOptionsBuilder | Partial<ReceptionistOptionsType>;
/** Value alias so `ReceptionistOptions.create()` / `new ReceptionistOptions()` resolve to the builder. */
export const ReceptionistOptions = ReceptionistOptionsBuilder;
