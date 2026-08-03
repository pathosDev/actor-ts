import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { mergeOptions, stripUndefined } from '../util/OptionsMerge.js';
import type { FailureDetectorOptionsType } from './FailureDetectorOptions.js';
import type { Transport } from './Transport.js';
import type { DowningProvider } from './downing/DowningProvider.js';

/** Plain options-object shape accepted by {@link Cluster.join}. */
export type ClusterOptionsType = {
  readonly host: string;
  readonly port: number;
  /** Other nodes this node should try to contact on startup. */
  readonly seeds?: string[];
  /** Role tags exposed to other members — used to constrain sharding placement. */
  readonly roles?: string[];
  /** Failure detector thresholds. */
  readonly failureDetector?: Partial<FailureDetectorOptionsType>;
  /** Override the transport (e.g. InMemoryTransport for tests). */
  readonly transport?: Transport;
  /** How often gossip is pushed to a random reachable peer. */
  readonly gossipIntervalMs?: number;
  /** How often to resend the initial join gossip to seeds until self is Up. */
  readonly seedRetryIntervalMs?: number;
  /**
   * How long to keep a `removed` tombstone in the local members map
   * before pruning it.  Tombstones exist so stale gossip from a slow
   * peer can't resurrect a definitively-removed address; the TTL
   * caps their accumulation in long-running clusters with frequent
   * node churn (#75).  Default 24 h — comfortably above any
   * realistic gossip-propagation lag.
   */
  readonly tombstoneTtlMs?: number;
  /**
   * How often the tombstone-prune pass runs.  Default 5 min — small
   * enough that a freshly-expired tombstone disappears within one
   * pruning window, large enough to be negligible CPU.
   */
  readonly tombstonePruneIntervalMs?: number;
  /**
   * Minimum age before a tombstone is eligible for pruning, regardless
   * of {@link tombstoneTtlMs}.  Defaults to `6 × downAfterMs`, which
   * gives a few failure-detector rounds of breathing room so peers
   * that haven't fully converged still see the tombstone before it
   * vanishes.  Mostly relevant for tests that set a very low TTL.
   */
  readonly tombstoneMinRetentionMs?: number;
  /**
   * Auto-promote a `joining` member to `weakly-up` after this many ms if
   * convergence (leader + `up` transition) hasn't happened yet.  Set to 0
   * to disable.  Default: 0 (disabled — opt-in only).
   */
  readonly weaklyUpAfterMs?: number;
  /**
   * Optional split-brain resolver.  When provided, the cluster invokes
   * `provider.decide(view)` whenever a member transitions to / from
   * `unreachable`, and force-downs every address in the returned set
   * (regardless of failure-detector state).  Without a provider, the
   * cluster relies solely on the failure detector's elapsed-time
   * `unreachable → down → removed` cascade — fine for unilateral
   * crashes, weak under network partitions.
   *
   * See `src/cluster/downing/` for the bundled strategies (KeepMajority,
   * KeepOldest, KeepReferee, StaticQuorum, LeaseMajority).
   */
  readonly downing?: DowningProvider;
  /**
   * Per-frame cap on the cluster wire, in bytes.  Frames whose
   * length-prefix exceeds it are rejected before any payload is
   * buffered, so it bounds what one peer can make this node hold.
   *
   * Only applies to the transport the cluster builds for itself — an
   * explicit {@link transport} carries its own cap, set where it is
   * constructed.  Default: 16 MiB (`DEFAULT_MAX_FRAME_BYTES`); lower it
   * on a network that crosses a semi-trusted boundary.
   */
  readonly maxFrameBytes?: number;
};

/**
 * Fluent builder for {@link ClusterOptionsType} — the sole input to
 * {@link Cluster.join}.  `host` + `port` are required; every other knob
 * is optional.  Polymorphic / whole-value fields (`transport`,
 * `downing`, `failureDetector`, `roles`, `seeds`) are passed as-is via a
 * single `withX(value)` — no nested builders.
 *
 *     await Cluster.join(
 *       system,
 *       ClusterOptions.create()
 *         .withHost('127.0.0.1')
 *         .withPort(2552)
 *         .withSeeds(['sys@127.0.0.1:2551']),
 *     );
 */
export class ClusterOptionsBuilder extends OptionsBuilder<ClusterOptionsType> {
  /** Start a fresh builder.  Equivalent to `new ClusterOptionsBuilder()`. */
  static create(): ClusterOptionsBuilder {
    return new ClusterOptionsBuilder();
  }

  /** Bind host. */
  withHost(host: string): this {
    return this.set('host', host);
  }

  /** Bind port. */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /** Other nodes this node should try to contact on startup. */
  withSeeds(seeds: string[]): this {
    return this.set('seeds', seeds);
  }

  /** Role tags exposed to other members — constrain sharding placement. */
  withRoles(roles: string[]): this {
    return this.set('roles', roles);
  }

  /** Failure-detector thresholds (merged over the built-in defaults). */
  withFailureDetector(failureDetector: Partial<FailureDetectorOptionsType>): this {
    return this.set('failureDetector', failureDetector);
  }

  /** Override the transport (e.g. `InMemoryTransport` for tests). */
  withTransport(transport: Transport): this {
    return this.set('transport', transport);
  }

  /** How often gossip is pushed to a random reachable peer. */
  withGossipIntervalMs(ms: number): this {
    return this.set('gossipIntervalMs', ms);
  }

  /** How often to resend the initial join gossip to seeds until self is Up. */
  withSeedRetryIntervalMs(ms: number): this {
    return this.set('seedRetryIntervalMs', ms);
  }

  /** How long to keep a `removed` tombstone before pruning it.  Default 24 h. */
  withTombstoneTtlMs(ms: number): this {
    return this.set('tombstoneTtlMs', ms);
  }

  /** How often the tombstone-prune pass runs.  Default 5 min. */
  withTombstonePruneIntervalMs(ms: number): this {
    return this.set('tombstonePruneIntervalMs', ms);
  }

  /** Minimum age before a tombstone is eligible for pruning.  Default `6 × downAfterMs`. */
  withTombstoneMinRetentionMs(ms: number): this {
    return this.set('tombstoneMinRetentionMs', ms);
  }

  /** Auto-promote `joining` → `weakly-up` after this many ms.  0 disables (default). */
  withWeaklyUpAfterMs(ms: number): this {
    return this.set('weaklyUpAfterMs', ms);
  }

  /** Optional split-brain resolver (KeepMajority, KeepOldest, …). */
  withDowning(downing: DowningProvider): this {
    return this.set('downing', downing);
  }

  /** Per-frame wire cap for the cluster's own transport.  Default: 16 MiB. */
  withMaxFrameBytes(maxFrameBytes: number): this {
    return this.set('maxFrameBytes', maxFrameBytes);
  }
}

/** Validates resolved {@link ClusterOptionsType} settings. */
export class ClusterOptionsValidator extends OptionsValidator<ClusterOptionsType> {
  constructor() {
    super('ClusterOptions');
  }
  protected rules(_s: Partial<ClusterOptionsType>): void {
    this.nonEmptyString('host');
    // A positive integer, not port() [1..65535]: with InMemoryTransport the
    // port is a synthetic node-address discriminator (tests use e.g. 89001),
    // and validation here is transport-agnostic — the TCP range is TcpTransport's
    // concern, not the cluster's.
    this.positiveInt('port');
    this.positiveNumber('gossipIntervalMs');
    this.positiveNumber('seedRetryIntervalMs');
    this.positiveNumber('tombstoneTtlMs');
    this.positiveNumber('tombstonePruneIntervalMs');
    this.positiveNumber('tombstoneMinRetentionMs');
    this.nonNegativeNumber('weaklyUpAfterMs'); // 0 disables auto weakly-up
    this.positiveInt('maxFrameBytes');
  }
}

/**
 * The slice of cluster settings HOCON can supply — `actor-ts.cluster.*`
 * plus the bind address and wire cap under `actor-ts.remote.*`.
 *
 * `seeds`, `roles`, `transport` and `downing` are absent on purpose:
 * the last two are objects HOCON cannot express, and the first two are
 * per-deployment identity rather than tuning — they belong at the join
 * site where the node knows who it is.
 */
export type ClusterConfigDefaults = Partial<Pick<
  ClusterOptionsType,
  'host' | 'port' | 'gossipIntervalMs' | 'seedRetryIntervalMs' | 'failureDetector' | 'maxFrameBytes'
>>;

/**
 * Read the cluster block into the shape {@link Cluster.join} merges under
 * the caller's options.  Only keys actually present are returned, so an
 * absent one falls through to the built-in default instead of landing as
 * an explicit `undefined`.
 *
 * `failureDetector` is assembled from its three leaves and omitted
 * entirely when none of them is set — an empty object here would still
 * count as "set" and shadow nothing, but it would make the merge in
 * `Cluster.join` harder to reason about than it needs to be.
 */
export function readClusterOptionsFromConfig(config: Config): ClusterConfigDefaults {
  const keys = ConfigKeys.cluster;
  const remote = ConfigKeys.remote;
  // Mutable while being filled; consumers see the readonly shape.
  const out: { -readonly [K in keyof ClusterConfigDefaults]: ClusterConfigDefaults[K] } = {};
  if (config.hasPath(remote.tcp.host)) out.host = config.getString(remote.tcp.host);
  if (config.hasPath(remote.tcp.port)) out.port = config.getInt(remote.tcp.port);
  if (config.hasPath(remote.maxFrameBytes)) out.maxFrameBytes = config.getBytes(remote.maxFrameBytes);
  if (config.hasPath(keys.gossipInterval)) out.gossipIntervalMs = config.getDuration(keys.gossipInterval);
  if (config.hasPath(keys.seedRetryInterval)) {
    out.seedRetryIntervalMs = config.getDuration(keys.seedRetryInterval);
  }
  const failureDetector = readFailureDetectorFromConfig(config);
  if (Object.keys(failureDetector).length > 0) out.failureDetector = failureDetector;
  return out;
}

/**
 * Layer the cluster config block under the caller's options — the
 * precedence every configurable thing in the framework documents:
 * **explicit options > HOCON > built-in defaults**.
 *
 * `failureDetector` needs the nested pass: it is one field holding three
 * thresholds, so the shallow merge would let an explicit `{ downAfterMs }`
 * drop the other two straight back to the built-in defaults, silently
 * discarding the config file's values for settings the caller never
 * mentioned.  Per-field precedence has to reach inside it.
 */
export function withClusterConfigDefaults(
  config: Config,
  options: ClusterOptionsType,
): ClusterOptionsType {
  const fromConfig = readClusterOptionsFromConfig(config);
  const merged = mergeOptions<ClusterOptionsType>({}, fromConfig, options);
  const failureDetector = {
    ...fromConfig.failureDetector,
    ...stripUndefined(options.failureDetector ?? {}),
  };
  return Object.keys(failureDetector).length > 0 ? { ...merged, failureDetector } : merged;
}

function readFailureDetectorFromConfig(config: Config): Partial<FailureDetectorOptionsType> {
  const keys = ConfigKeys.cluster.failureDetector;
  const out: { -readonly [K in keyof FailureDetectorOptionsType]?: FailureDetectorOptionsType[K] } = {};
  if (config.hasPath(keys.heartbeatInterval)) {
    out.heartbeatIntervalMs = config.getDuration(keys.heartbeatInterval);
  }
  if (config.hasPath(keys.unreachableAfter)) {
    out.unreachableAfterMs = config.getDuration(keys.unreachableAfter);
  }
  if (config.hasPath(keys.downAfter)) out.downAfterMs = config.getDuration(keys.downAfter);
  return stripUndefined(out);
}

/**
 * Accepted input for {@link Cluster.join}: the fluent
 * {@link ClusterOptionsBuilder} OR a plain {@link ClusterOptionsType} object.
 */
export type ClusterOptions = ClusterOptionsBuilder | Partial<ClusterOptionsType>;
/** Value alias so `ClusterOptions.create()` / `new ClusterOptions()` resolve to the builder. */
export const ClusterOptions = ClusterOptionsBuilder;
