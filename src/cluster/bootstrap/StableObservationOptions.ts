import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { SeedProvider } from '../../discovery/SeedProvider.js';
import type { NodeAddress } from '../NodeAddress.js';

/** Poll cadence while waiting for the contact-point set to settle. */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** How long the contact-point set must stay unchanged before it counts. */
export const DEFAULT_STABLE_MARGIN_MS = 5_000;

/** Total budget for reaching a stable observation before giving up. */
export const DEFAULT_MAX_WAIT_MS = 60_000;

/**
 * How long the elected initial seed waits for a peer to promote it before it
 * forms a new cluster on its own.
 *
 * An order of magnitude above the join round-trip it has to outlast — seed
 * contact, one gossip tick at the seed (default 1 s), the leader's promotion,
 * one gossip tick back — with the default 3 s seed retry fitting three times
 * inside it.  The cost of being generous is a one-off delay on a genuine cold
 * start; the cost of being tight is a second cluster.
 */
export const DEFAULT_SELF_ELECTION_GRACE_MS = 10_000;

/**
 * Fewest contact points an observation must contain before it is allowed to
 * be stable.  `1` — the value that keeps a single-node deployment working
 * without configuration.  Raise it to the expected replica count wherever
 * that is known: it is the only defence against discovery that is *stably*
 * wrong, which a margin measured over time cannot detect.
 */
export const DEFAULT_REQUIRED_CONTACT_POINTS = 1;

/** Plain options-object shape accepted by {@link StableObservation}. */
export type StableObservationOptionsType = {
  /**
   * Where the contact points come from.  Any `SeedProvider` — the DNS, K8s
   * and config providers all work; the observation only cares that repeated
   * `lookup()` calls converge.
   */
  readonly seedProvider: SeedProvider;
  /**
   * This node's own address — both a contact point in its own right and the
   * value the address-ordered election compares against.
   *
   * It must be the address peers would dial, not a bind address: an election
   * ordered on `0.0.0.0` puts every node first (see #944), so
   * {@link StableObservation} refuses to run on a wildcard.
   */
  readonly selfAddress: NodeAddress;
  /** How long the observed set must stay unchanged.  Default: 5 000 ms. */
  readonly stableMarginMs?: number;
  /** Cadence of the `lookup()` polls.  Default: 1 000 ms. */
  readonly pollIntervalMs?: number;
  /** Total budget before the observation throws.  Default: 60 000 ms. */
  readonly maxWaitMs?: number;
  /** Fewest contact points a stable observation may contain.  Default: 1. */
  readonly requiredContactPoints?: number;
  /**
   * Millisecond grace handed to the elected initial seed as its
   * `ClusterOptions.selfElection`.  Default: 10 000 ms.
   */
  readonly selfElectionGraceMs?: number;
  /** Where progress and reset lines go.  Default: discarded. */
  readonly log?: (message: string) => void;
};

/**
 * The tuning half of {@link StableObservationOptionsType} — everything except
 * the two values a caller that already owns the node's identity supplies
 * itself.  `bootstrapCluster` derives `seedProvider` from `discovery` /
 * `seeds` and `selfAddress` from `host` / `port`, so its own
 * `stableObservation` field accepts exactly this.
 */
export type StableObservationTuning =
  Omit<StableObservationOptionsType, 'seedProvider' | 'selfAddress'>;

/**
 * Fluent builder for {@link StableObservationOptionsType}.
 *
 *     const observationOptions = StableObservationOptions.create()
 *       .withSeedProvider(seedProvider)
 *       .withSelfAddress(selfAddress)
 *       .withRequiredContactPoints(3);
 *     const observation = new StableObservation(observationOptions);
 */
export class StableObservationOptionsBuilder extends OptionsBuilder<StableObservationOptionsType> {
  /** Start a fresh builder.  Equivalent to `new StableObservationOptionsBuilder()`. */
  static create(): StableObservationOptionsBuilder {
    return new StableObservationOptionsBuilder();
  }

  /** Where the contact points come from. */
  withSeedProvider(seedProvider: SeedProvider): this {
    return this.set('seedProvider', seedProvider);
  }

  /** This node's advertised address — the value the election orders on. */
  withSelfAddress(selfAddress: NodeAddress): this {
    return this.set('selfAddress', selfAddress);
  }

  /** How long the observed set must stay unchanged.  Default: 5 000 ms. */
  withStableMarginMs(ms: number): this {
    return this.set('stableMarginMs', ms);
  }

  /** Cadence of the `lookup()` polls.  Default: 1 000 ms. */
  withPollIntervalMs(ms: number): this {
    return this.set('pollIntervalMs', ms);
  }

  /** Total budget before the observation throws.  Default: 60 000 ms. */
  withMaxWaitMs(ms: number): this {
    return this.set('maxWaitMs', ms);
  }

  /** Fewest contact points a stable observation may contain.  Default: 1. */
  withRequiredContactPoints(count: number): this {
    return this.set('requiredContactPoints', count);
  }

  /** Grace handed to the elected initial seed.  Default: 10 000 ms. */
  withSelfElectionGraceMs(ms: number): this {
    return this.set('selfElectionGraceMs', ms);
  }

  /** Where progress and reset lines go.  Default: discarded. */
  withLog(log: (message: string) => void): this {
    return this.set('log', log);
  }
}

/** Validates resolved {@link StableObservationOptionsType} settings. */
export class StableObservationOptionsValidator
  extends OptionsValidator<StableObservationOptionsType> {
  constructor() {
    super('StableObservationOptions');
  }

  protected rules(s: Partial<StableObservationOptionsType>): void {
    this.positiveNumber('pollIntervalMs');
    this.positiveNumber('maxWaitMs');
    this.positiveInt('requiredContactPoints');
    this.positiveNumber('selfElectionGraceMs');
    // Non-negative: `0` is a meaningful margin — "act on the first repeated
    // observation" — which is what the tests and a deployment with a
    // trustworthy registry want.
    this.nonNegativeNumber('stableMarginMs');
    // Cross-field: an observation cannot become stable after the budget it is
    // measured against has already run out, so this combination can only ever
    // throw.  Caught here rather than 60 s later at the call site.
    if (s.maxWaitMs !== undefined && s.stableMarginMs !== undefined
      && s.maxWaitMs <= s.stableMarginMs) {
      this.fail(
        'maxWaitMs',
        `must exceed stableMarginMs (${s.stableMarginMs}) — otherwise the budget `
        + 'expires before any observation can become stable',
        s.maxWaitMs,
      );
    }
    // The election is address-ordered, so a self address that is not an
    // identity makes it meaningless rather than merely inaccurate: every node
    // that took a wildcard fallback sorts identically, so every node believes
    // it won and every node forms its own cluster (#944).  Rejected at
    // construction, where the remedy is still one option away.
    if (s.selfAddress !== undefined && isWildcardHost(s.selfAddress.host)) {
      this.fail(
        'selfAddress',
        'must be the address peers dial, not a wildcard bind address — set '
        + 'ClusterBootstrapOptions.withHost(...) (or the CLUSTER_HOST / POD_IP env var) '
        + "to this node's routable host",
        s.selfAddress.toString(),
      );
    }
  }
}

/**
 * Whether a host is a bind wildcard rather than an identity.
 *
 * Deliberately not a general "is this routable" test: `localhost` and
 * `127.0.0.1` are perfectly good identities for several processes on one
 * machine, which is how the in-process suites form clusters.  What is refused
 * is only the set of spellings that mean *"every interface"* — those are the
 * ones every node resolves to the same string.
 */
export function isWildcardHost(host: string): boolean {
  const normalized = host.trim().replace(/^\[|\]$/g, '');
  return normalized === ''
    || normalized === '*'
    || normalized === '0.0.0.0'
    || normalized === '::'
    || normalized === '::0'
    || normalized === '0:0:0:0:0:0:0:0';
}

/**
 * The slice of stable-observation settings HOCON can supply —
 * `actor-ts.cluster.bootstrap.*`.
 *
 * `seedProvider`, `selfAddress` and `log` are absent because they are objects
 * HOCON cannot express; what remains is timing, which is exactly what an
 * operator tunes per environment (a slow DNS refresh, a large replica set)
 * without touching code.
 */
export type StableObservationConfigDefaults = Partial<Pick<
  StableObservationOptionsType,
  'stableMarginMs' | 'pollIntervalMs' | 'maxWaitMs'
  | 'requiredContactPoints' | 'selfElectionGraceMs'
>>;

/**
 * Read the bootstrap block into the shape {@link bootstrapCluster} merges
 * under the caller's tuning.  Only keys actually present are returned, so an
 * absent one falls through to the built-in default instead of landing as an
 * explicit `undefined`.
 */
export function readStableObservationOptionsFromConfig(
  config: Config,
): StableObservationConfigDefaults {
  const keys = ConfigKeys.cluster.bootstrap;
  // Mutable while being filled; consumers see the readonly shape.
  const out: {
    -readonly [K in keyof StableObservationConfigDefaults]:
    StableObservationConfigDefaults[K]
  } = {};
  if (config.hasPath(keys.stableMargin)) out.stableMarginMs = config.getDuration(keys.stableMargin);
  if (config.hasPath(keys.pollInterval)) out.pollIntervalMs = config.getDuration(keys.pollInterval);
  if (config.hasPath(keys.maxWait)) out.maxWaitMs = config.getDuration(keys.maxWait);
  if (config.hasPath(keys.requiredContactPoints)) {
    out.requiredContactPoints = config.getInt(keys.requiredContactPoints);
  }
  if (config.hasPath(keys.selfElectionGrace)) {
    out.selfElectionGraceMs = config.getDuration(keys.selfElectionGrace);
  }
  return out;
}

/**
 * Accepted input for {@link StableObservation}: the fluent
 * {@link StableObservationOptionsBuilder} OR a plain
 * {@link StableObservationOptionsType} object.
 */
export type StableObservationOptions =
  StableObservationOptionsBuilder | Partial<StableObservationOptionsType>;
/** Value alias so `StableObservationOptions.create()` resolves to the builder. */
export const StableObservationOptions = StableObservationOptionsBuilder;
