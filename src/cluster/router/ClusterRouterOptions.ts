import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Cluster } from '../Cluster.js';
import type { ClusterRouterType } from './ClusterRouter.js';

/** Plain options-object shape consumed by {@link ClusterRouter.props}. */
export interface ClusterRouterOptionsType<TMessage> {
  /** The cluster the router lives in.  Used for membership + transport. */
  readonly cluster: Cluster;
  /** Restrict routees to up-members carrying this role.  Omit for "any node". */
  readonly role?: string;
  /** Strategy.  See {@link ClusterRouterType}. */
  readonly routerType: ClusterRouterType;
  /**
   * The path the routee actor lives under on each routee node — usually
   * `/user/<actorName>`.  The same path must exist on every targeted
   * node; the router doesn't probe for liveness beyond the cluster
   * membership state.
   */
  readonly routeePath: string;
  /**
   * Required for `routerType: 'consistent-hashing'`, ignored otherwise.
   * Returns the string key used to pin a message to a routee.  Two
   * messages with the same key always land on the same node (subject
   * to the cluster topology not changing).
   */
  readonly extractKey?: (message: TMessage) => string;
}

/**
 * Fluent builder for {@link ClusterRouterOptionsType}:
 *
 *     ClusterRouter.props(
 *       ClusterRouterOptions.create<Cmd>()
 *         .withCluster(cluster)
 *         .withRouterType('consistent-hashing')
 *         .withRouteePath('/user/worker')
 *         .withExtractKey((m) => m.id),
 *     );
 */
export class ClusterRouterOptionsBuilder<TMessage> extends OptionsBuilder<ClusterRouterOptionsType<TMessage>> {
  /** Start a fresh builder. */
  static create<TMessage>(): ClusterRouterOptionsBuilder<TMessage> {
    return new ClusterRouterOptionsBuilder<TMessage>();
  }

  /** The cluster the router lives in — drives membership + transport. */
  withCluster(cluster: Cluster): this {
    return this.set('cluster', cluster);
  }

  /** Restrict routees to up-members carrying this role.  Omit for "any node". */
  withRole(role: string): this {
    return this.set('role', role);
  }

  /** Routing strategy.  See {@link ClusterRouterType}. */
  withRouterType(routerType: ClusterRouterType): this {
    return this.set('routerType', routerType);
  }

  /** The path the routee actor lives under on each node — usually `/user/<name>`. */
  withRouteePath(routeePath: string): this {
    return this.set('routeePath', routeePath);
  }

  /** Key extractor — required for `consistent-hashing`, ignored otherwise. */
  withExtractKey(extractKey: (message: TMessage) => string): this {
    return this.set('extractKey', extractKey);
  }
}

/**
 * Accepted input for {@link ClusterRouter.props}: the fluent
 * {@link ClusterRouterOptionsBuilder} OR a plain (partial)
 * {@link ClusterRouterOptionsType} object.
 */
export type ClusterRouterOptions<TMessage> =
  | ClusterRouterOptionsBuilder<TMessage>
  | Partial<ClusterRouterOptionsType<TMessage>>;
/** Value alias so `ClusterRouterOptions.create()` / `new ClusterRouterOptions()` resolve to the builder. */
export const ClusterRouterOptions = ClusterRouterOptionsBuilder;
