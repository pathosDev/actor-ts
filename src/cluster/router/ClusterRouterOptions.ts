import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Cluster } from '../Cluster.js';
import type { ClusterRouterSettings, ClusterRouterType } from './ClusterRouter.js';

/**
 * Fluent builder for {@link ClusterRouterSettings}:
 *
 *     ClusterRouter.props(
 *       ClusterRouterOptions.create<Cmd>()
 *         .withCluster(cluster)
 *         .withRouterType('consistent-hashing')
 *         .withRouteePath('/user/worker')
 *         .withExtractKey((m) => m.id),
 *     );
 */
export class ClusterRouterOptions<TMsg> extends OptionsBuilder<ClusterRouterSettings<TMsg>> {
  /** Start a fresh builder. */
  static create<TMsg>(): ClusterRouterOptions<TMsg> {
    return new ClusterRouterOptions<TMsg>();
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
  withExtractKey(extractKey: (message: TMsg) => string): this {
    return this.set('extractKey', extractKey);
  }
}
