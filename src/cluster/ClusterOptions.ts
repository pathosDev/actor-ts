import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { FailureDetectorOptionsType } from './FailureDetectorOptions.js';
import type { Transport } from './Transport.js';
import type { DowningProvider } from './downing/DowningProvider.js';

/** Plain options-object shape accepted by {@link Cluster.join}. */
export interface ClusterOptionsType {
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
}

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
  }
}

/**
 * Accepted input for {@link Cluster.join}: the fluent
 * {@link ClusterOptionsBuilder} OR a plain {@link ClusterOptionsType} object.
 */
export type ClusterOptions = ClusterOptionsBuilder | Partial<ClusterOptionsType>;
/** Value alias so `ClusterOptions.create()` / `new ClusterOptions()` resolve to the builder. */
export const ClusterOptions = ClusterOptionsBuilder;
