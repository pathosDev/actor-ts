import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { mergeOptions, stripUndefined } from '../util/OptionsMerge.js';
import type { FailureDetectorOptionsType } from './FailureDetectorOptions.js';
import type { Transport } from './Transport.js';
import type { DowningProvider } from './downing/DowningProvider.js';

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
    // A positive integer, not port() [1..65535]: with InMemoryTransport the
    // port is a synthetic node-address discriminator (tests use e.g. 89001),
    // and validation here is transport-agnostic — the TCP range is TcpTransport's
    // concern, not the cluster's.
    this.positiveInt('port');
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
 * The slice of cluster settings HOCON can supply — `actor-ts.cluster.*`
 * plus the bind address and wire cap under `actor-ts.remote.*`.
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
  'host' | 'port' | 'gossipIntervalMs' | 'seedRetryIntervalMs' | 'failureDetector' | 'maxFrameBytes'
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
 * `Cluster.join` harder to reason about than it needs to be.
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
  if (config.hasPath(remote.tcp.port)) out.port = config.getInt(remote.tcp.port);
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
  const failureDetector = readFailureDetectorFromConfig(config);
  if (Object.keys(failureDetector).length > 0) out.failureDetector = failureDetector;
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
 * Only an explicit `true` counts.  `reference.conf` ships the key with
 * `false`, so the path is always present once the reference layer is loaded,
 * and a config file that spells the default out must behave like one that
 * omits it — the rule `tombstone.min-retention` already follows (#841).
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
