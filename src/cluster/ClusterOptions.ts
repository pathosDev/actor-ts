import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { mergeOptions, stripUndefined } from '../util/OptionsMerge.js';
import type { FailureDetectorImplementation } from './FailureDetector.js';
import type { FailureDetectorOptionsType } from './FailureDetectorOptions.js';
import type { PhiAccrualOptionsType } from './PhiAccrualOptions.js';
import type { Transport } from './Transport.js';
import type { DowningProvider } from './downing/DowningProvider.js';

/**
 * Built-in default for {@link ClusterOptionsType.failureDetectorImplementation}
 * — the elapsed-time detector every cluster ran before #840 made the choice
 * expressible at all.
 *
 * The default is "no change": φ-accrual is opt-in, so wiring the selector
 * moves nothing for a deployment that does not ask for it.
 */
export const DEFAULT_FAILURE_DETECTOR_IMPLEMENTATION: FailureDetectorImplementation = 'simple';

/**
 * Built-in default for {@link ClusterOptionsType.seedRetryIntervalMs} — how
 * long a node waits before re-attempting a failed `Cluster.join`.  3 s
 * balances "give the seed node time to start" with "fail fast on a missing
 * peer".
 */
export const DEFAULT_SEED_RETRY_INTERVAL_MS = 3_000;

/**
 * Built-in default for {@link ClusterOptionsType.maxVersionSkewMs} — how far
 * ahead of the local wall-clock a gossiped member version may be.  The full
 * reasoning for both the rule and the number is on `Cluster.admitsVersion`
 * (#114).
 *
 * Distinct from the 24 h wall-clock cap in `Cluster.ts`, which the two
 * deliberately do not share: that one bounds *timestamps*, this one bounds
 * *versions*, and they happen to be different quantities with different
 * justifications.
 */
export const DEFAULT_MAX_VERSION_SKEW_MS = 5 * 60 * 1_000;

/**
 * Built-in default for {@link ClusterOptionsType.maxMembers} — the cap on
 * **live** entries in the member map (#138).
 *
 * The number is chosen against the failure mode that actually bites, which is
 * not an out-of-memory kill.  Gossip carries the whole member list, so at
 * roughly 110 000 entries this node's own frame outgrows the 16 MiB wire cap
 * and every peer terminates the connection on the length prefix — the node
 * removes itself from the cluster while still running.  1000 sits two orders
 * of magnitude below that, and comfortably above any cluster this framework
 * is built for.
 */
export const DEFAULT_MAX_MEMBERS = 1_000;

/**
 * Built-in default for {@link ClusterOptionsType.maxTombstones} — the cap on
 * `removed` tombstones in the member map (#138).
 *
 * Ten times {@link DEFAULT_MAX_MEMBERS} because tombstones are the entries
 * that legitimately outnumber live members — every node that ever left leaves
 * one for {@link ClusterOptionsType.tombstoneTtlMs}.  That same property is
 * why this is the cap that matters: a phantom in an active status is reclaimed
 * by the failure detector within `downAfterMs`, a gossiped tombstone is not
 * reclaimed by anything for a day.
 */
export const DEFAULT_MAX_TOMBSTONES = 10_000;

/**
 * Built-in default for {@link ClusterOptionsType.tombstoneTtlMs} — how long a
 * removed member's tombstone is retained.  24 h gives slow or partitioned
 * peers a generous window to converge after a member is removed; once
 * expired, peers can re-mint the address without resurrecting the tombstone.
 * See `Cluster.ts` + #75 for the full lifecycle.
 */
export const DEFAULT_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Built-in default for
 * {@link ClusterOptionsType.tombstonePruneIntervalMs} — the cadence of the
 * tombstone-pruning sweep.  5 min gives a useful safety margin around the
 * 24 h TTL without busy-looping.
 */
export const DEFAULT_TOMBSTONE_PRUNE_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * Last resort for {@link ClusterOptionsType.advertisedHost} — the address a
 * node claims when nothing names one (#944).
 *
 * Loopback rather than the `0.0.0.0` this replaces, because the two fail
 * differently and only one of them fails visibly.  A wildcard is not an
 * address: every node that reaches for it advertises the byte-identical
 * `<system>@0.0.0.0:<port>`, so each reads the others' self-announcements as
 * claims about *itself*, `maySpeakFor` refuses them, and every node ends up
 * alone in a member map of one — with nothing in the log that says so.
 * Loopback is a real address that happens to be reachable from one machine, so
 * an unconfigured node states its own limit in every line it logs, and several
 * processes on one host get genuinely distinct identities from their distinct
 * ports.
 *
 * It is a fallback, not a guess at the deployment: {@link resolveAdvertisedHost}
 * consults `CLUSTER_HOST`, `POD_IP` and `HOSTNAME` before reaching it.
 */
export const DEFAULT_ADVERTISED_HOST = '127.0.0.1';

/**
 * Whether — and when — this node may declare itself the first member of a
 * new cluster, moving straight from `joining` to `up` with nobody's
 * agreement.
 *
 *   - `'immediate'` (default) — self-elect at once **iff** the seed list is
 *     empty.  The historical behaviour, and the one that makes single-node
 *     development and the "first node has no seeds" convention work.
 *   - `'never'` — never self-elect.  This node stays `joining` until a peer's
 *     leader promotes it.  Correct for every node that a bootstrap election
 *     did *not* pick: an isolated node then fails to start rather than
 *     quietly becoming a cluster of one.
 *   - a **number of ms** — self-elect only after that long without a peer
 *     having promoted this node, regardless of whether the seed list is
 *     empty.  This is the policy the stable-observation bootstrap hands the
 *     node it elected as initial seed (#148).
 *
 * The delay is what makes an address-ordered election safe against an
 * existing cluster.  A node that wins the election because its address sorts
 * first may still be joining a cluster that is already running — a scale-up
 * or a rolling restart puts new addresses at arbitrary positions in the
 * order.  Because the elected node contacts its seeds like everyone else and
 * only self-elects if that produced nothing, an existing cluster promotes it
 * long before the deadline and no rival cluster is ever formed.  Self-electing
 * *immediately* on winning the election, as the naive reading of "lowest
 * address becomes the seed" suggests, would create exactly the split-brain the
 * election exists to prevent.
 */
export type SelfElectionPolicy = 'immediate' | 'never' | number;

/** Plain options-object shape accepted by {@link Cluster.join}. */
export type ClusterOptionsType = {
  /**
   * The interface this node **binds**.  A wildcard is correct here and is the
   * shipped default (`actor-ts.remote.tcp.host = "0.0.0.0"`): binding every
   * interface is how a container accepts traffic on an address it does not
   * know at start-up.
   *
   * It is *also* what this node advertises, unless {@link advertisedHost} says
   * otherwise — which is the whole reason the two are separate fields.  Naming
   * one routable host here keeps the historical single-value behaviour: bound
   * and advertised alike.
   */
  readonly host: string;
  /**
   * The address peers **dial** — this node's identity, not a bind target
   * (#944).
   *
   * It is what goes into `selfAddress`, and from there into every gossip
   * frame, every heartbeat and every member record, and it is what the
   * bootstrap election orders on.  A wildcard is therefore not a value it can
   * take: {@link ClusterOptionsValidator} refuses one, because an address
   * meaning "all of them" identifies nothing and every node that claimed it
   * would claim the same string.
   *
   * Unset is the normal case — {@link resolveAdvertisedHost} derives it, from
   * {@link host} when that is routable and otherwise from the environment,
   * falling back to {@link DEFAULT_ADVERTISED_HOST}.  Set it explicitly for
   * the deployment the split exists for: bind `0.0.0.0`, advertise the pod IP.
   */
  readonly advertisedHost?: string;
  /**
   * The port this node **binds** — and, unless {@link advertisedPort} says
   * otherwise, the port peers dial.
   */
  readonly port: number;
  /**
   * The port peers **dial**, when it differs from the bound one (#845).
   *
   * The port half of the {@link advertisedHost} split, and it exists for the
   * one deployment that remaps a port: a published container port, where the
   * process listens on 2552 inside the container and the outside world reaches
   * it on whatever `docker run -p 3000:2552` published.  Kubernetes does not
   * need it — pod-to-pod gossip dials the container port directly — which is
   * why the host half shipped first and this one derives rather than resolves.
   *
   * Unset is the normal case and means "the same as {@link port}", which is
   * what {@link resolveAdvertisedPort} answers.  There is no environment chain
   * behind it and no wildcard to refuse: a port is either named or derived from
   * the bound one, and both are dialable by construction.
   */
  readonly advertisedPort?: number;
  /** Other nodes this node should try to contact on startup. */
  readonly seeds?: string[];
  /** Role tags exposed to other members — used to constrain sharding placement. */
  readonly roles?: string[];
  /**
   * Which detection algorithm this node runs — `'simple'` (default) or
   * `'phi'` (#840).
   *
   * A sibling field rather than a `kind` on {@link failureDetector}, because
   * the two detectors do not share a settings shape and the thresholds below
   * are the *simple* one's.  It is additive: an existing
   * `withFailureDetector(…)` call keeps meaning exactly what it meant.
   */
  readonly failureDetectorImplementation?: FailureDetectorImplementation;
  /** Failure detector thresholds — the `'simple'` implementation's. */
  readonly failureDetector?: Partial<FailureDetectorOptionsType>;
  /**
   * φ-accrual tuning, read only when
   * {@link failureDetectorImplementation} is `'phi'`.
   *
   * `heartbeatIntervalMs` is absent from what config can set here and is
   * overwritten by {@link failureDetector}'s: the cadence is the cluster's,
   * not the algorithm's (#1142).
   */
  readonly phiAccrual?: Partial<PhiAccrualOptionsType>;
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
   *
   * `0` means the same thing as leaving it unset — derive the floor from
   * the failure detector — rather than "no floor at all".  The distinction
   * matters because the HOCON leaf ships with `0s` as its documented
   * default, and a config file that spells a default out must behave like
   * one that omits it (#841).
   */
  readonly tombstoneMinRetentionMs?: number;
  /**
   * How far ahead of the local clock a gossiped member version may be — the
   * single cap on the merge path, whether the record introduces an address or
   * updates one already on file.
   *
   * It bounds how far into the future an unauthenticated peer can pre-date a
   * claim.  Without it such a squat out-versions the real node's own record,
   * and the leader promotes the phantom into the active set carrying the
   * attacker's roles — which is what routing, sharding placement, singleton
   * hosting and downing quorums are computed from (#114).
   *
   * It applies to *every* merge because the narrower reading — "only where an
   * address is introduced" — could be stepped around by introducing the
   * address first: two records for it in one frame, or an empty frame that
   * makes the sender fallback file it.  See `Cluster.admitsVersion`.
   *
   * Default: 5 min — comfortably above any NTP-disciplined clock.  A refusal
   * is not exclusion (the sender fallback still records the address, at
   * version 1 without roles), but it is durable: a node whose clock runs
   * further ahead than this stays role-less until its clock comes back.  Raise
   * it for a deployment whose clocks are known to run loose.
   */
  readonly maxVersionSkewMs?: number;
  /**
   * Auto-promote a `joining` member to `weakly-up` after this many ms if
   * convergence (leader + `up` transition) hasn't happened yet.  Set to 0
   * to disable.  Default: 0 (disabled — opt-in only).
   */
  readonly weaklyUpAfterMs?: number;
  /**
   * When this node may declare itself the first member of a new cluster —
   * see {@link SelfElectionPolicy}.  Default: `'immediate'`.
   *
   * Deliberately absent from {@link ClusterConfigDefaults}: it is per-node
   * identity, not tuning, exactly like `seeds` and `roles`.  A HOCON leaf
   * would be applied to every node of a deployment identically, and both
   * uniform answers are wrong — all-`'never'` never starts a cluster, and
   * all-`<delay>` has every node self-elect at the same moment, which is the
   * split brain this option exists to close.
   */
  readonly selfElection?: SelfElectionPolicy;
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
  /**
   * Cap on **live** (non-tombstone) entries in the local member map — the
   * addresses gossip is allowed to introduce.  `0` disables the cap.
   *
   * {@link maxFrameBytes} bounds one frame; this bounds what a sequence of
   * well-formed frames can accumulate.  Membership is filled from
   * unauthenticated gossip, so a peer with standing can name addresses this
   * node has never seen and get an entry allocated for each, with no join
   * involved (#138).  Phantom entries in an active status are reclaimed by
   * the failure detector after `downAfterMs`, which makes this the narrower
   * of the two caps: it bounds the burst, not the residue.
   *
   * Default: 1000 — far above any cluster this framework is built for, and
   * far below the ~110 000 entries at which this node's *own* gossip frame
   * outgrows {@link maxFrameBytes} and its peers start dropping the
   * connection.  Lower it where the legitimate node count is known: a cap
   * set far above real usage bounds very little.
   */
  readonly maxMembers?: number;
  /**
   * Cap on `removed` tombstones in the local member map.  `0` disables it.
   *
   * The load-bearing half of the pair.  A tombstone carries no liveness, so
   * the failure detector never reclaims it — only {@link tombstoneTtlMs}
   * does, a day later.  A peer that gossips `removed` records for addresses
   * this node has never seen therefore parks entries here for 24 h, which is
   * the only variant of #138 that actually accumulates.
   *
   * Refusing one costs nothing: a tombstone for an address with no local
   * record suppresses nothing that exists.  Locally-minted tombstones
   * (`leave`, a downing decision, `down()`) convert an entry that is already
   * present and are never subject to the cap.
   *
   * Default: 10 000.
   */
  readonly maxTombstones?: number;
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

  /**
   * The interface to bind — and, unless {@link withAdvertisedHost} overrides
   * it, the address peers dial.  A wildcard is legal here and only here.
   */
  withHost(host: string): this {
    return this.set('host', host);
  }

  /**
   * The address peers dial, when it differs from the bound interface — the
   * `0.0.0.0`-bind / pod-IP-advertise split.  A wildcard is rejected (#944).
   */
  withAdvertisedHost(advertisedHost: string): this {
    return this.set('advertisedHost', advertisedHost);
  }

  /**
   * The port to bind — and, unless {@link withAdvertisedPort} overrides it,
   * the port peers dial.
   */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /**
   * The port peers dial, when it differs from the bound one — the published
   * container port of a `docker run -p 3000:2552` (#845).
   */
  withAdvertisedPort(advertisedPort: number): this {
    return this.set('advertisedPort', advertisedPort);
  }

  /** Other nodes this node should try to contact on startup. */
  withSeeds(seeds: string[]): this {
    return this.set('seeds', seeds);
  }

  /** Role tags exposed to other members — constrain sharding placement. */
  withRoles(roles: string[]): this {
    return this.set('roles', roles);
  }

  /** Which detection algorithm to run — `'simple'` (default) or `'phi'`. */
  withFailureDetectorImplementation(implementation: FailureDetectorImplementation): this {
    return this.set('failureDetectorImplementation', implementation);
  }

  /** Failure-detector thresholds (merged over the built-in defaults). */
  withFailureDetector(failureDetector: Partial<FailureDetectorOptionsType>): this {
    return this.set('failureDetector', failureDetector);
  }

  /** φ-accrual tuning, used only when the implementation is `'phi'`. */
  withPhiAccrual(phiAccrual: Partial<PhiAccrualOptionsType>): this {
    return this.set('phiAccrual', phiAccrual);
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

  /** Cap on how far ahead of the local clock a gossiped member version may be.  Default 5 min. */
  withMaxVersionSkewMs(ms: number): this {
    return this.set('maxVersionSkewMs', ms);
  }

  /** Auto-promote `joining` → `weakly-up` after this many ms.  0 disables (default). */
  withWeaklyUpAfterMs(ms: number): this {
    return this.set('weaklyUpAfterMs', ms);
  }

  /**
   * When this node may declare itself the first member of a new cluster.
   * `'immediate'` (default), `'never'`, or a millisecond delay — see
   * {@link SelfElectionPolicy}.
   */
  withSelfElection(selfElection: SelfElectionPolicy): this {
    return this.set('selfElection', selfElection);
  }

  /** Optional split-brain resolver (KeepMajority, KeepOldest, …). */
  withDowning(downing: DowningProvider): this {
    return this.set('downing', downing);
  }

  /** Per-frame wire cap for the cluster's own transport.  Default: 16 MiB. */
  withMaxFrameBytes(maxFrameBytes: number): this {
    return this.set('maxFrameBytes', maxFrameBytes);
  }

  /** Cap on live member entries gossip may introduce.  0 disables.  Default: 1000. */
  withMaxMembers(maxMembers: number): this {
    return this.set('maxMembers', maxMembers);
  }

  /** Cap on `removed` tombstones gossip may introduce.  0 disables.  Default: 10000. */
  withMaxTombstones(maxTombstones: number): this {
    return this.set('maxTombstones', maxTombstones);
  }
}

/** Validates resolved {@link ClusterOptionsType} settings. */
export class ClusterOptionsValidator extends OptionsValidator<ClusterOptionsType> {
  constructor() {
    super('ClusterOptions');
  }
  protected rules(s: Partial<ClusterOptionsType>): void {
    this.nonEmptyString('host');
    this.nonEmptyString('advertisedHost');
    // The advertised address is an identity, so a wildcard is not a value it
    // can hold — it names every interface, which is to say none of them, and
    // every node that claimed it would claim the same string (#944).  Refused
    // here rather than left to fail later, because the later failure is a
    // cluster that never converges and says nothing about why: each node reads
    // the others' self-announcements as claims about itself, `maySpeakFor`
    // turns them down, and every member map holds exactly one entry.
    //
    // Only ever reachable from an explicit `advertisedHost`:
    // `resolveAdvertisedHost` cannot produce a wildcard, so a bound `0.0.0.0`
    // arrives here already resolved to something dialable.
    if (s.advertisedHost !== undefined && isWildcardHost(s.advertisedHost)) {
      this.fail(
        'advertisedHost',
        'must be the address peers dial, not a wildcard bind address — bind the '
        + 'wildcard with `host` and name this node\'s routable address here (or in '
        + 'the CLUSTER_HOST / POD_IP env var)',
        s.advertisedHost,
      );
    }
    // A positive integer, not port() [1..65535]: with InMemoryTransport the
    // port is a synthetic node-address discriminator (tests use e.g. 89001),
    // and validation here is transport-agnostic — the TCP range is TcpTransport's
    // concern, not the cluster's.
    this.positiveInt('port');
    // Same helper for the same reason: the advertised port is an identity
    // discriminator, not necessarily a TCP port number (#845).
    this.positiveInt('advertisedPort');
    // Checked here rather than left to `createFailureDetector`, because the
    // value routinely arrives from HOCON: an operator who writes
    // `implementation = phi-accrual` gets the key and the two legal spellings
    // named at startup, instead of a cluster that quietly runs the detector
    // they did not ask for (#840).
    this.oneOf('failureDetectorImplementation', ['simple', 'phi']);
    this.positiveNumber('gossipIntervalMs');
    this.positiveNumber('seedRetryIntervalMs');
    this.positiveNumber('tombstoneTtlMs');
    this.positiveNumber('tombstonePruneIntervalMs');
    // Non-negative, not positive: 0 is the documented HOCON default and reads
    // as "derive the floor from the failure detector", the same thing an unset
    // field means — not as "no floor" (#841).
    this.nonNegativeNumber('tombstoneMinRetentionMs');
    // Positive, with no "0 disables" escape hatch: a version cap has no off
    // switch, and 0 would read as "disabled" while actually meaning "no skew
    // at all tolerated".
    this.positiveInt('maxVersionSkewMs');
    this.nonNegativeNumber('weaklyUpAfterMs'); // 0 disables auto weakly-up
    this.positiveInt('maxFrameBytes');
    // `0 = off` rather than `Infinity`: a count needs an integer opt-out, and
    // `positiveInt` would reject `Infinity` anyway.  Same shape as the
    // sharding entity cap.
    this.nonNegativeInt('maxMembers');
    this.nonNegativeInt('maxTombstones');
    // A keyword-or-duration union, so the field helpers (which are keyed on a
    // single value type) cannot express it — checked by hand, the same shape
    // `ClusterBootstrapOptionsValidator` uses for `awaitReady`.  `0` is
    // rejected rather than read as "immediately": that meaning already has a
    // spelling, and the two differ (`'immediate'` needs an empty seed list,
    // `0` would not), so silently accepting it would make the distinction
    // depend on which of two equivalent-looking values was written.
    const selfElection = s.selfElection;
    if (selfElection !== undefined && selfElection !== 'immediate' && selfElection !== 'never'
      && (typeof selfElection !== 'number' || !Number.isFinite(selfElection) || selfElection <= 0)) {
      this.fail(
        'selfElection',
        "must be 'immediate', 'never', or a positive number of ms",
        selfElection,
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
 * Environment variables {@link resolveAdvertisedHost} consults, in order.
 *
 * Exported so a diagnostic can name exactly what was looked at, rather than
 * repeating the list in prose that then drifts from the code.
 */
export const ADVERTISED_HOST_ENV_VARS = ['CLUSTER_HOST', 'POD_IP', 'HOSTNAME'] as const;

/**
 * The address this node tells its peers to dial — derived once, here, so
 * `Cluster.join` and `bootstrapCluster` cannot answer the question differently
 * (#944).
 *
 * The chain, in order:
 *
 *   1. an explicit {@link ClusterOptionsType.advertisedHost};
 *   2. {@link ClusterOptionsType.host}, **when it is not a wildcard** — one
 *      named routable host still means "bind and advertise this", which is the
 *      historical behaviour and the reason nothing configured correctly today
 *      moves;
 *   3. `CLUSTER_HOST`, `POD_IP`, `HOSTNAME`, first non-empty;
 *   4. {@link DEFAULT_ADVERTISED_HOST}.
 *
 * Stage 3 is an environment layer in a framework whose documented precedence is
 * *explicit options > HOCON > built-in defaults*, and it is deliberately narrow:
 * it applies to this one field, and it is only ever reached when the alternative
 * is advertising a wildcard.  `POD_IP` is the one input that is right by
 * construction — it is the address the platform assigned — and a node that
 * would otherwise gossip `0.0.0.0` is exactly the case worth spending a layer
 * on.  The variables are ordered by how much they mean it: `CLUSTER_HOST` is
 * someone stating this node's address, `POD_IP` is the platform stating it, and
 * `HOSTNAME` is a pod name that resolves only under a StatefulSet with a
 * headless service — and is not exported at all outside a container, since it is
 * a shell variable rather than an environment one.
 *
 * Stages 2 to 4 cannot produce a wildcard, so the only way one comes out is
 * stage 1 — a caller who named it.  That is what lets
 * {@link ClusterOptionsValidator} refuse one without qualification: every
 * refusal is a value someone wrote, never a default they never saw.
 */
export function resolveAdvertisedHost(
  options: { readonly host?: string; readonly advertisedHost?: string },
  /** Pre-mapped env lookup (defaults to `process.env` at call time). */
  env: Record<string, string | undefined> = process.env,
): string {
  // `!== undefined`, not truthiness: an explicit `''` is a configuration
  // error, and handing it back is what lets the validator say so.  Falling
  // through on it instead would silently substitute a working address for one
  // the caller wrote on purpose, which is the failure mode this whole chain
  // exists to remove.
  if (options.advertisedHost !== undefined) return options.advertisedHost;
  if (options.host && !isWildcardHost(options.host)) return options.host;
  for (const name of ADVERTISED_HOST_ENV_VARS) {
    const candidate = (env[name] ?? '').trim();
    if (candidate && !isWildcardHost(candidate)) return candidate;
  }
  return DEFAULT_ADVERTISED_HOST;
}

/**
 * Whether {@link resolveAdvertisedHost} had to look past the options to answer
 * — nothing named an advertised host and the bind host is a wildcard, so the
 * address this node claims came from the environment or from the built-in
 * default rather than from anything the caller wrote.
 *
 * Exists so the diagnostic at the join site can be a lookup rather than a
 * second copy of the chain's conditions, which is how the two drift apart.
 */
export function advertisedHostWasDerived(
  options: { readonly host?: string; readonly advertisedHost?: string },
): boolean {
  return options.advertisedHost === undefined
    && (options.host === undefined || isWildcardHost(options.host));
}

/**
 * The port peers dial — `advertisedPort` when one was named, otherwise the
 * bound {@link ClusterOptionsType.port} (#845).
 *
 * One line, and a named exported function all the same, for the reason
 * {@link resolveAdvertisedHost} is one: `Cluster.join` and `bootstrapCluster`
 * both need this answer *before* the join — the bootstrap election orders on
 * the self address and the seed filter compares against it — and two copies of
 * `?? port` are two places for the policy to drift.
 *
 * There is no environment stage and no refusal to make. A port cannot be a
 * wildcard, so every value that reaches here is dialable; the only question is
 * whether the deployment remapped it.
 */
export function resolveAdvertisedPort(
  options: { readonly port: number; readonly advertisedPort?: number },
): number {
  return options.advertisedPort ?? options.port;
}

/**
 * The slice of cluster settings HOCON can supply — `actor-ts.cluster.*`
 * plus the bind address, the advertised address and the wire cap under
 * `actor-ts.remote.*`.
 *
 * `advertisedHost` is in and `seeds` is out for the same reason, read two
 * ways.  Both are per-node identity, but only one of them is *derivable* from
 * the platform: a Deployment gives every pod the same manifest and a different
 * `POD_IP`, so `advertised-host = ${?POD_IP}` is one line that is correct on
 * every node, where a seed list written once is correct on none of them.
 *
 * `seeds`, `roles`, `selfElection`, `transport` and `downing` are absent on
 * purpose: the last two are objects HOCON cannot express, and the first three
 * are per-deployment identity rather than tuning — they belong at the join
 * site where the node knows who it is.  `selfElection` is the sharpest of the
 * three, because a shared value is not merely useless but actively unsafe —
 * see the field's own doc.
 */
export type ClusterConfigDefaults = Partial<Pick<
  ClusterOptionsType,
  'host' | 'advertisedHost' | 'port' | 'advertisedPort' | 'gossipIntervalMs' | 'seedRetryIntervalMs'
  | 'failureDetectorImplementation' | 'failureDetector' | 'phiAccrual' | 'maxFrameBytes'
  | 'weaklyUpAfterMs' | 'tombstoneTtlMs' | 'tombstonePruneIntervalMs' | 'tombstoneMinRetentionMs'
  | 'maxMembers' | 'maxTombstones'
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
 * `Cluster.join` harder to reason about than it needs to be.  `phiAccrual`
 * is assembled from the `failure-detector.phi` sub-block the same way.
 *
 * The HOCON tree and this shape are deliberately not isomorphic: the
 * housekeeping durations sit under a `tombstone { … }` group because that is
 * how an operator reads them (#841), while the fields stay flat because that
 * is how `Cluster` consumes them.  The same translation already applies to
 * `remote.tcp.host` → `host`.
 */
export function readClusterOptionsFromConfig(config: Config): ClusterConfigDefaults {
  const keys = ConfigKeys.cluster;
  const remote = ConfigKeys.remote;
  // Mutable while being filled; consumers see the readonly shape.
  const out: { -readonly [K in keyof ClusterConfigDefaults]: ClusterConfigDefaults[K] } = {};
  if (config.hasPath(remote.tcp.host)) out.host = config.getString(remote.tcp.host);
  // Absent from `reference.conf` on purpose, so `hasPath` stays false until an
  // operator sets it and "unset means: derive it from `host`" remains
  // expressible — the shape `sharding.shard-passivation-idle` already uses.
  if (config.hasPath(remote.tcp.advertisedHost)) {
    out.advertisedHost = config.getString(remote.tcp.advertisedHost);
  }
  if (config.hasPath(remote.tcp.port)) out.port = config.getInt(remote.tcp.port);
  // Absent from `reference.conf` for the same reason `advertised-host` is: an
  // always-present leaf could not mean "the same as `port`", which is what
  // every deployment that does not remap the port relies on (#845).
  if (config.hasPath(remote.tcp.advertisedPort)) {
    out.advertisedPort = config.getInt(remote.tcp.advertisedPort);
  }
  if (config.hasPath(remote.maxFrameBytes)) out.maxFrameBytes = config.getBytes(remote.maxFrameBytes);
  if (config.hasPath(keys.gossipInterval)) out.gossipIntervalMs = config.getDuration(keys.gossipInterval);
  if (config.hasPath(keys.seedRetryInterval)) {
    out.seedRetryIntervalMs = config.getDuration(keys.seedRetryInterval);
  }
  if (config.hasPath(keys.weaklyUpAfter)) out.weaklyUpAfterMs = config.getDuration(keys.weaklyUpAfter);
  if (config.hasPath(keys.maxMembers)) out.maxMembers = config.getInt(keys.maxMembers);
  if (config.hasPath(keys.maxTombstones)) out.maxTombstones = config.getInt(keys.maxTombstones);
  const tombstone = keys.tombstone;
  if (config.hasPath(tombstone.timeToLive)) out.tombstoneTtlMs = config.getDuration(tombstone.timeToLive);
  if (config.hasPath(tombstone.pruneInterval)) {
    out.tombstonePruneIntervalMs = config.getDuration(tombstone.pruneInterval);
  }
  if (config.hasPath(tombstone.minRetention)) {
    out.tombstoneMinRetentionMs = config.getDuration(tombstone.minRetention);
  }
  const failureDetectorKeys = keys.failureDetector;
  if (config.hasPath(failureDetectorKeys.implementation)) {
    // Cast rather than validated here: `ClusterOptionsValidator` checks the
    // merged settings once, at consume time, and it is the one place that sees
    // an explicit option and a HOCON value in the same shape.  Narrowing here
    // as well would report the same typo from two places with two messages.
    out.failureDetectorImplementation =
      config.getString(failureDetectorKeys.implementation) as FailureDetectorImplementation;
  }
  const failureDetector = readFailureDetectorFromConfig(config);
  if (Object.keys(failureDetector).length > 0) out.failureDetector = failureDetector;
  const phiAccrual = readPhiAccrualFromConfig(config);
  if (Object.keys(phiAccrual).length > 0) out.phiAccrual = phiAccrual;
  return out;
}

/**
 * Whether the config asks for an encrypted cluster wire —
 * `actor-ts.remote.tls.enabled`.
 *
 * Deliberately **not** part of {@link ClusterConfigDefaults}: there is no
 * `ClusterOptionsType` field to merge it into, because nothing honours it yet
 * (#941).  It exists so `Cluster` can say out loud that the flag is set and
 * the socket is still plaintext — an operator who configures encryption and
 * gets neither encryption nor a word about it is the whole defect (#591).
 *
 * Only a true value counts — `true`, `on` or `yes`, the three spellings HOCON
 * gives a boolean.  `reference.conf` ships the key with `false`, so the path
 * is always present once the reference layer is loaded, and a config file that
 * spells the default out must behave like one that omits it — the rule
 * `tombstone.min-retention` already follows (#841).
 *
 * A value that is neither — `enabled = maybe`, or a numeric `1` — throws
 * `ConfigError` out of `getBoolean` and takes the node's startup with it.
 * That is deliberate, and it is what every other typed key in the framework
 * already does.  Guessing is the worse failure here: both readings of a
 * malformed *security* toggle are defensible ("they obviously meant on" /
 * "it is not the literal `true`"), and the tolerant one hands the operator a
 * plaintext wire they believe is encrypted — the exact outcome #591 exists to
 * prevent, re-entered through the back door.  Refusing to start names the key
 * and what was wrong with its value, at the one moment someone is watching.
 */
export function isRemoteTlsRequested(config: Config): boolean {
  const remote = ConfigKeys.remote;
  return config.hasPath(remote.tls.enabled) && config.getBoolean(remote.tls.enabled);
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
 *
 * `phiAccrual` needs the same pass for the same reason, one block over — an
 * explicit `{ downThreshold: 16 }` must not blank the file's other four
 * φ settings (#840).
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
  const phiAccrual = {
    ...fromConfig.phiAccrual,
    ...stripUndefined(options.phiAccrual ?? {}),
  };
  const withNested: ClusterOptionsType = Object.keys(failureDetector).length > 0
    ? { ...merged, failureDetector }
    : merged;
  return Object.keys(phiAccrual).length > 0 ? { ...withNested, phiAccrual } : withNested;
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
 * The `failure-detector.phi` sub-block — a sibling of
 * {@link readFailureDetectorFromConfig}, not an extension of it, because the
 * two detectors are configured by two different shapes and a single reader
 * would have to return both (#840).
 *
 * There is no `heartbeat-interval` leaf here on purpose: the cadence is read
 * once from `failure-detector.heartbeat-interval` and imposed on whichever
 * detector is installed (#1142), so the returned shape never carries
 * `heartbeatIntervalMs`.
 *
 * The two thresholds are read with `getNumber`, not `getInt`: φ is a
 * continuous suspicion value and `unreachable-threshold = 8.5` is an ordinary
 * tuning move, which `getInt` would reject outright.
 */
function readPhiAccrualFromConfig(config: Config): Partial<PhiAccrualOptionsType> {
  const keys = ConfigKeys.cluster.failureDetector.phi;
  const out: { -readonly [K in keyof PhiAccrualOptionsType]?: PhiAccrualOptionsType[K] } = {};
  if (config.hasPath(keys.unreachableThreshold)) {
    out.unreachableThreshold = config.getNumber(keys.unreachableThreshold);
  }
  if (config.hasPath(keys.downThreshold)) {
    out.downThreshold = config.getNumber(keys.downThreshold);
  }
  if (config.hasPath(keys.maxSampleSize)) {
    out.maxSampleSize = config.getInt(keys.maxSampleSize);
  }
  if (config.hasPath(keys.minStdDeviation)) {
    out.minStdDeviationMs = config.getDuration(keys.minStdDeviation);
  }
  if (config.hasPath(keys.acceptableHeartbeatPause)) {
    out.acceptableHeartbeatPauseMs = config.getDuration(keys.acceptableHeartbeatPause);
  }
  return stripUndefined(out);
}

/**
 * Accepted input for {@link Cluster.join}: the fluent
 * {@link ClusterOptionsBuilder} OR a plain {@link ClusterOptionsType} object.
 */
export type ClusterOptions = ClusterOptionsBuilder | Partial<ClusterOptionsType>;
/** Value alias so `ClusterOptions.create()` / `new ClusterOptions()` resolve to the builder. */
export const ClusterOptions = ClusterOptionsBuilder;
