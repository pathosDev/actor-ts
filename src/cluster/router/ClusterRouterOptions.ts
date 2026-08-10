import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { Cluster } from '../Cluster.js';
import type { ClusterRouterType } from './ClusterRouter.js';

/** Plain options-object shape consumed by {@link ClusterRouter.factory}. */
export type ClusterRouterOptionsType<TMessage> = {
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
  /**
   * How often, in milliseconds, the router refreshes its cached view of every
   * routee node's mailbox depth.  Read only for
   * `routerType: 'smallest-mailbox'`; ignored otherwise.
   *
   * This is the lag on the router's picture of the cluster, and the rate at
   * which it costs one small envelope per routee.  Shorter tracks a
   * fast-moving load more closely and talks more; longer is cheaper and routes
   * on an older view.  Defaults to
   * {@link DEFAULT_MAILBOX_DEPTH_REFRESH_MS}.
   */
  readonly mailboxDepthRefreshMs?: number;
  /**
   * How long, in milliseconds, a cached depth stays usable.  A routee whose
   * last reading is older is skipped as though it had never answered, so the
   * router routes on silence the way it would on a cold cache — round-robin
   * order — instead of on a number from before a node went quiet.
   *
   * **`0` turns the expiry off**: a reading is then used however old it is.
   * Read only for `routerType: 'smallest-mailbox'`.  Defaults to
   * {@link DEFAULT_MAILBOX_DEPTH_STALE_AFTER_MS}.
   */
  readonly mailboxDepthStaleAfterMs?: number;
};

/**
 * Default refresh interval for `smallest-mailbox`.
 *
 * Chosen against the cost, not against a target accuracy: a refresh is one
 * envelope per routee per tick, so at five ticks a second a 10-node pool
 * carries 50 tiny envelopes a second — noise next to the traffic a router that
 * size is there to spread.  Ten times faster would start to register.
 */
export const DEFAULT_MAILBOX_DEPTH_REFRESH_MS = 200;

/**
 * Default staleness bound — five refresh intervals.
 *
 * Wide enough that a single dropped envelope does not make a healthy node
 * invisible to the router, narrow enough that a node which has actually
 * stopped answering drops out within a second.
 */
export const DEFAULT_MAILBOX_DEPTH_STALE_AFTER_MS = 1_000;

/**
 * Fluent builder for {@link ClusterRouterOptionsType}:
 *
 *     const routerOptions = ClusterRouterOptions.create<Command>()
 *       .withCluster(cluster)
 *       .withRouterType('consistent-hashing')
 *       .withRouteePath('/user/worker')
 *       .withExtractKey((m) => m.id);
 *     ClusterRouter.factory(routerOptions);
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

  /** Refresh interval for the cached mailbox depths — `smallest-mailbox` only. */
  withMailboxDepthRefreshMs(mailboxDepthRefreshMs: number): this {
    return this.set('mailboxDepthRefreshMs', mailboxDepthRefreshMs);
  }

  /** Age at which a cached depth stops counting; `0` disables the expiry. */
  withMailboxDepthStaleAfterMs(mailboxDepthStaleAfterMs: number): this {
    return this.set('mailboxDepthStaleAfterMs', mailboxDepthStaleAfterMs);
  }
}

/**
 * Validates resolved {@link ClusterRouterOptionsType} settings — a known
 * `routerType`, a non-empty `routeePath`, sane mailbox-depth timings, and the
 * cross-field rules that consistent-hashing needs an `extractKey` and that a
 * staleness bound must outlive the refresh that feeds it.
 */
export class ClusterRouterOptionsValidator<TMessage> extends OptionsValidator<ClusterRouterOptionsType<TMessage>> {
  constructor() {
    super('ClusterRouterOptions');
  }
  protected rules(s: Partial<ClusterRouterOptionsType<TMessage>>): void {
    this.oneOf('routerType', ['round-robin', 'random', 'consistent-hashing', 'smallest-mailbox', 'broadcast']);
    this.nonEmptyString('routeePath');
    this.positiveInt('mailboxDepthRefreshMs');
    this.nonNegativeInt('mailboxDepthStaleAfterMs');
    if (s.routerType === 'consistent-hashing' && s.extractKey === undefined) {
      this.fail('extractKey', "is required when routerType is 'consistent-hashing'");
    }
    // Checked against the resolved pair rather than only against what was set,
    // so overriding one of the two cannot silently cross the other's default.
    // A window shorter than the interval that refills it expires every reading
    // before its replacement can arrive, which leaves the cache permanently
    // cold and the strategy permanently degraded to round-robin — working, and
    // for no reason anyone would find by reading the config.
    const refreshMs = s.mailboxDepthRefreshMs ?? DEFAULT_MAILBOX_DEPTH_REFRESH_MS;
    const staleAfterMs = s.mailboxDepthStaleAfterMs ?? DEFAULT_MAILBOX_DEPTH_STALE_AFTER_MS;
    if (staleAfterMs > 0 && staleAfterMs < refreshMs) {
      this.fail(
        'mailboxDepthStaleAfterMs',
        `must be 0 (never stale) or >= mailboxDepthRefreshMs (${refreshMs})`,
        staleAfterMs,
      );
    }
  }
}

/**
 * Accepted input for {@link ClusterRouter.factory}: the fluent
 * {@link ClusterRouterOptionsBuilder} OR a plain (partial)
 * {@link ClusterRouterOptionsType} object.
 */
export type ClusterRouterOptions<TMessage> =
  | ClusterRouterOptionsBuilder<TMessage>
  | Partial<ClusterRouterOptionsType<TMessage>>;
/** Value alias so `ClusterRouterOptions.create()` / `new ClusterRouterOptions()` resolve to the builder. */
export const ClusterRouterOptions = ClusterRouterOptionsBuilder;
