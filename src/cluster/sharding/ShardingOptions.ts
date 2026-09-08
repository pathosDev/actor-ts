import type { ActorClassOrFactory } from '../../Actor.js';
import type { ActorOptions } from '../../ActorOptions.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

/**
 * Built-in default for {@link ShardingOptionsType.numShards} — the shard
 * count used when a sharded type does not pick one.  Mirrors
 * `actor-ts.sharding.number-of-shards = 64` in `reference.conf`.
 */
export const DEFAULT_NUM_SHARDS = 64;

/**
 * Built-in default for {@link ShardingOptionsType.passivationIdleMs} — how
 * long an entity may sit idle before the region passivates it.  `0` disables
 * the sweep.
 *
 * Kept in lockstep with `passivation-idle` in `reference.conf`: HOCON only
 * reaches a region that came through `ClusterSharding.start`, while a
 * directly-constructed one falls back to this constant, and the two
 * disagreeing would make the same options mean different things depending on
 * which door they came through.
 */
export const DEFAULT_PASSIVATION_IDLE_MS = 300_000;

/**
 * Which resident entity a region at `maxEntities` gives up to make room for a
 * new one (#848).
 *
 *   - `least-recently-used` — the entity untouched for longest.  What every
 *     release before this one did, and still the default.
 *   - `segmented-least-recently-used` — a probationary segment for entities
 *     seen once and a protected one for entities seen again, evicting from
 *     probation first.  The policy the composite exists for: plain LRU cannot
 *     tell "touched once, ever" from "touched constantly until a moment ago",
 *     so a scan over cold ids evicts a hot working set one entity at a time.
 *   - `least-frequently-used` — the entity accessed fewest times, with every
 *     count halved periodically so the ranking follows recent traffic rather
 *     than a lifetime total.
 *
 * `most-recently-used` is deliberately absent.  It appears in no acceptance
 * criterion of #848, has no caller anywhere in the tree, and its one real use —
 * a workload that will never revisit what it just read — is the case where a
 * sharded entity should not have been created at all.  Adding a value to this
 * union later is not a breaking change; removing one is, so the narrow set is
 * the reversible choice.
 */
export type EntityReplacementPolicy =
  | 'least-recently-used'
  | 'segmented-least-recently-used'
  | 'least-frequently-used';

/** Every accepted {@link EntityReplacementPolicy} — the set the validator checks against. */
export const ENTITY_REPLACEMENT_POLICIES: readonly EntityReplacementPolicy[] = [
  'least-recently-used',
  'segmented-least-recently-used',
  'least-frequently-used',
];

/**
 * Whether a newcomer has to earn its place against the entity it would displace
 * (#848).
 *
 *   - `off` — it does not; the replacement policy alone decides.
 *   - `frequency-sketch` — a count-min sketch of how often each entity id has
 *     been touched decides, so an id seen once cannot displace one seen many
 *     times.  The sketch remembers ids the region no longer holds, which is
 *     precisely the history a cache cannot keep for the entities it evicted.
 *
 * Requires {@link ShardingOptionsType.passivationAdmissionWindowProportion} to
 * be greater than zero — see that field for why the filter has nothing to
 * decide without a window.
 */
export type EntityAdmissionFilter = 'off' | 'frequency-sketch';

/** Every accepted {@link EntityAdmissionFilter} — the set the validator checks against. */
export const ENTITY_ADMISSION_FILTERS: readonly EntityAdmissionFilter[] = [
  'off',
  'frequency-sketch',
];

/**
 * Built-in default for {@link ShardingOptionsType.passivationReplacement}
 * (#848).  Mirrors `actor-ts.sharding.passivation.replacement`.
 *
 * Plain LRU on purpose: this is pre-1.0 and a hard cut is allowed, but silently
 * reordering every capped deployment's evictions is not a cut anyone asked for.
 * The composite costs nothing until a policy is named, because a region without
 * a cap builds no strategy at all.
 */
export const DEFAULT_PASSIVATION_REPLACEMENT: EntityReplacementPolicy = 'least-recently-used';

/**
 * Built-in default for
 * {@link ShardingOptionsType.passivationSegmentedProtectedProportion} (#848).
 * Mirrors `actor-ts.sharding.passivation.segmented-protected-proportion`.
 *
 * Four fifths protected, one fifth probation — the split the segmented-LRU
 * literature settles on, and the one the shape of the problem argues for: the
 * probationary segment only has to be large enough that a newcomer gets a
 * second chance before the next one arrives, while everything that has proven
 * itself belongs on the other side of the line.
 *
 * Inert unless `passivationReplacement` is `segmented-least-recently-used`.
 */
export const DEFAULT_PASSIVATION_SEGMENTED_PROTECTED_PROPORTION = 0.8;

/**
 * Built-in default for
 * {@link ShardingOptionsType.passivationAdmissionWindowProportion} (#848).
 * Mirrors `actor-ts.sharding.passivation.admission-window-proportion`.
 *
 * `0` — no window, which is the shape every release before this one had.  A
 * window costs a slot of the cap for every entity in it and only pays for
 * itself once something is filtering at its far end, so it ships off and is
 * turned on together with `passivationAdmissionFilter`.
 */
export const DEFAULT_PASSIVATION_ADMISSION_WINDOW_PROPORTION = 0;

/**
 * Built-in default for {@link ShardingOptionsType.passivationAdmissionFilter}
 * (#848).  Mirrors `actor-ts.sharding.passivation.admission-filter`.
 */
export const DEFAULT_PASSIVATION_ADMISSION_FILTER: EntityAdmissionFilter = 'off';

/**
 * Built-in default for {@link ShardingOptionsType.passivationStopTimeoutMs} —
 * how long a passivating entity may take to stop before the shard stops it
 * outright (#848).  Mirrors `actor-ts.sharding.passivation.stop-timeout`.
 *
 * **Off**, and that is the compatibility decision rather than a taste in
 * numbers.  `Passivate`'s stop-message is a *request*: the entity is told what
 * to send itself and decides when to act on it, and an entity mid-drain — a
 * long flush, a slow final write — is entitled to take as long as the drain
 * takes.  A backstop that is on by default turns that into a deadline for every
 * deployment that upgrades, including ones that never heard of the key, and the
 * forced stop abandons the flush.  #848 shipped it at `10s` and claimed a
 * deployment configuring nothing was unaffected; both could not be true.
 *
 * So an operator opts in, which is also what keeps the key orthogonal to
 * `maxEntities`: it arms on its own value, with or without a cap.  Gating it on
 * the cap instead would have narrowed the silent change rather than removed it
 * — a deployment that already set `max-entities` would still have gained the
 * forced stop — and would have left a configured `stop-timeout` silently doing
 * nothing, which is the shape `admission-filter` is rejected for.
 */
export const DEFAULT_PASSIVATION_STOP_TIMEOUT_MS = 0;

/**
 * Built-in default for {@link ShardingOptionsType.bufferSize} — how many
 * messages one region may hold, across every shard, while their homes are
 * unknown or in transition (#849, #461).  Mirrors
 * `actor-ts.sharding.buffer-size` in `reference.conf`.
 *
 * Large enough that an ordinary rebalance never reaches it — buffering is the
 * mechanism that makes a handoff loss-free, and a cap that trips during one
 * would turn a routine event into message loss.  Bounded at all because the
 * states that fill the buffer (no leader, an unacquirable lease, a refused
 * registration) do not necessarily end: unbounded, the region's answer to a
 * coordinator that never replies is to consume the heap.
 */
export const DEFAULT_SHARD_REGION_BUFFER_SIZE = 100_000;

/**
 * Built-in default for {@link ShardingOptionsType.registerRetryIntervalMs} —
 * how often a region re-sends an unacknowledged `Register` to the coordinator
 * (#849).  Mirrors `actor-ts.sharding.register-retry-interval`.
 *
 * Short on purpose: the retry exists because `Register` is fire-and-forget at
 * a path that need not exist yet, and every message for the type buffers until
 * the coordinator answers.  Raising it lengthens exactly that window.
 */
export const DEFAULT_REGISTER_RETRY_INTERVAL_MS = 500;

/**
 * How a region brings *remembered* entities back once it is handed a shard
 * (#851).
 *
 *   - `all` — start every remembered entity the moment the registry arrives.
 *     Back to full service fastest, and what every release before this one
 *     did unconditionally.  A node handed thousands of remembered entities
 *     spawns them in one synchronous burst, and each spawn that is a
 *     persistent entity opens a journal replay.
 *   - `constant-rate` — start at most
 *     {@link ShardingOptionsType.entityRecoveryConstantRateNumberOfEntities}
 *     of them every
 *     {@link ShardingOptionsType.entityRecoveryConstantRateFrequencyMs} ms,
 *     counted **across every shard this region owns**, until the backlog is
 *     drained.
 *
 * What `constant-rate` bounds is the **start rate**, not the number of
 * replays in flight: a replay is asynchronous, so one that outlasts the
 * window still overlaps the next batch.  Bounding concurrent recoveries is a
 * separate mechanism in the persistence layer (#1383); this one spreads the
 * arrivals that feed it.
 */
export type EntityRecoveryStrategy = 'all' | 'constant-rate';

/** Every accepted {@link EntityRecoveryStrategy} — the set the validator checks against. */
export const ENTITY_RECOVERY_STRATEGIES: readonly EntityRecoveryStrategy[] = [
  'all',
  'constant-rate',
];

/**
 * Built-in default for {@link ShardingOptionsType.entityRecoveryStrategy}
 * (#851).  Mirrors `actor-ts.sharding.entity-recovery.strategy`.
 *
 * `all` on purpose: pacing changes *when* an entity comes back, and a
 * default that delayed recovery would alter the observable behaviour of every
 * deployment that never asked for it.  Turning it on is a decision about a
 * particular journal's capacity, which nothing here can guess.
 */
export const DEFAULT_ENTITY_RECOVERY_STRATEGY: EntityRecoveryStrategy = 'all';

/**
 * Built-in default for
 * {@link ShardingOptionsType.entityRecoveryConstantRateFrequencyMs} — the gap
 * between two recovery batches, in ms (#851).  Mirrors
 * `actor-ts.sharding.entity-recovery.constant-rate.frequency`.
 *
 * Inert until `entityRecoveryStrategy` is `constant-rate`, so the value is a
 * starting point rather than a measurement: nothing in this repository
 * measures entity-spawn or replay cost, and the right pace is a property of
 * the journal behind the entities, not of the sharding layer.  Together with
 * the count below it reads as "50 entity starts a second, node-wide".
 */
export const DEFAULT_ENTITY_RECOVERY_CONSTANT_RATE_FREQUENCY_MS = 100;

/**
 * Built-in default for
 * {@link ShardingOptionsType.entityRecoveryConstantRateNumberOfEntities} —
 * how many entities one recovery batch starts (#851).  Mirrors
 * `actor-ts.sharding.entity-recovery.constant-rate.number-of-entities`.
 */
export const DEFAULT_ENTITY_RECOVERY_CONSTANT_RATE_NUMBER_OF_ENTITIES = 5;

/**
 * Built-in default for {@link ShardingOptionsType.regionHeartbeatIntervalMs} —
 * how often a region tells the coordinator it is still there (#853).  Mirrors
 * `actor-ts.sharding.stale-region-detection.heartbeat-interval = 5s`.
 *
 * Inert unless {@link ShardingOptionsType.staleRegionDetection} is on, which it
 * is not by default, so nothing beats on an upgrade that changes no config.
 *
 * The number is chosen against the *count* of beats rather than against any
 * measurement.  The beat is **per sharded type**, not per node — each type has
 * its own region and its own coordinator — so N types on a node cost N frames
 * per interval on top of the cluster's own full-mesh heartbeats, which #1174
 * already flags as O(n²) with no documented ceiling.  At 5 s the backstop adds
 * a frame every five seconds per type, and the detection latency that buys is
 * bounded by {@link ShardCoordinatorOptionsType.regionStaleAfterMs}, not by
 * this.
 */
export const DEFAULT_REGION_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Plain options-object shape for a sharded region.  Consumed by
 * {@link ShardRegion.settingsToConfig} and extended by
 * {@link StartShardingOptionsType} — the coordinator-side superset that
 * {@link ClusterSharding.start} accepts.
 */
export type ShardingOptionsType<TMessage> = {
  readonly typeName: string;
  /**
   * The entity actor — its class, or a factory when it needs dependencies.
   * Distinct from {@link ActorOptionsType.entity}, which is the *identity*
   * `ClusterSharding` stamps onto each entity it spawns.
   */
  readonly entityActor: ActorClassOrFactory<TMessage>;
  /** Spawn options applied to every entity of this type. */
  readonly entityOptions?: ActorOptions<TMessage>;
  readonly extractEntityId: (message: TMessage) => string;
  readonly extractEntityMessage?: (message: TMessage) => unknown;
  readonly numShards?: number;
  /** Members must carry this role to be candidates for hosting shards. */
  readonly role?: string;
  /** Run as a proxy — route messages but never host entities locally. */
  readonly proxy?: boolean;
  /** Track entity lifecycle so entities can be re-created on the new owner. */
  readonly rememberEntities?: boolean;
  /**
   * Passivate an entity after it has been idle this many ms.
   *
   * Default: 5 minutes (`passivation-idle` in `reference.conf`).  `0`
   * disables the sweep and keeps every entity resident until something
   * else stops it.
   *
   * Two consequences worth knowing before turning it down or off.  An
   * entity that holds state in memory and does not rebuild it in
   * `preStart` loses that state when it passivates — persistent entities
   * recover, plain ones do not.  And under `rememberEntities` a
   * passivation is a *forget*: the region relays `EntityStopped` to the
   * coordinator, which drops the entity from the registry, so it is no
   * longer among those revived after a node failure.
   */
  readonly passivationIdleMs?: number;
  /**
   * Stop a shard once it has stood empty this many ms — the shard-level
   * counterpart to {@link passivationIdleMs} (#892).
   *
   * A shard actor appears when the coordinator allocates the shard to this
   * node and, without this, is only ever stopped again by a handoff.  So once
   * its last entity passivates it stays resident holding an empty map; and
   * since entity ids spread over the hash space, a long-running node ends up
   * with one such shard per `numShards`.
   *
   * Unset, it follows `passivationIdleMs`: a shard stands empty precisely
   * because its entities went idle, so the same window applies one level up.
   * Set it to decouple the two — a larger value trades memory for fewer
   * re-creations, `0` keeps empty shards resident while entities still
   * passivate.
   *
   * Only an *empty* shard is ever stopped, and the region keeps ownership, so
   * the next message re-creates it transparently.
   */
  readonly shardPassivationIdleMs?: number;
  /**
   * Cap the number of locally-hosted entities (#82).  When the region
   * is about to spawn a new entity and the existing count is already
   * `maxEntities`, the entity with the oldest `lastActivity` is
   * passivated — same code path users invoke manually via
   * {@link Passivate}.  Useful for unbounded entity sets (per-user
   * sessions, IoT devices, …) where a memory cap per node matters
   * more than keeping every cold entity resident.
   *
   * Default: `0` (no cap).  Eviction runs only when `> 0`.
   *
   * Note: passivation is asynchronous, so during the brief window
   * between "stop the LRU" and "Terminated arrives" the region may
   * hold `maxEntities + 1` entities; the cap is a steady-state
   * upper bound rather than a strict instantaneous one.
   */
  readonly maxEntities?: number;
  /**
   * Which resident entity the cap gives up when a new one arrives (#848).
   * Default: `'least-recently-used'`.  Inert while `maxEntities` is `0`.
   *
   * Nested under `passivation` in HOCON and flat here, the translation
   * `entity-recovery.*` and `stale-region-detection.*` already make: `mergeOptions`
   * is a shallow spread, so a nested field would let a caller who sets one knob
   * blow away everything the config file supplied beside it.
   */
  readonly passivationReplacement?: EntityReplacementPolicy;
  /**
   * Share of the cap held by the *protected* segment under
   * `'segmented-least-recently-used'` (#848).  Default: `0.8`; the remainder is
   * the probationary segment.  Ignored under every other policy.
   *
   * A scalar rather than a list of level proportions, and #848 asked the
   * question explicitly: two levels is what "keep what has proven itself, evict
   * what has not" needs, an N-level split has no caller here, and a list would
   * be the first array leaf in `reference.conf` with no matching reader kind in
   * the documented-defaults guard.  A list can be added beside this later; a
   * shipped key cannot be renamed.
   */
  readonly passivationSegmentedProtectedProportion?: number;
  /**
   * Share of the cap held as a probationary *admission window* in front of the
   * replacement policy (#848).  Default: `0` — no window.
   *
   * The window is what makes an admission filter expressible at all.  A region
   * cannot refuse the entity a message has just arrived for, because it is
   * being created to receive that message; with a window it does not have to.
   * The newcomer enters the window, and the candidate judged against the
   * incumbent is whatever falls out of the window's far end — an entity that
   * arrived some time ago and can be passivated like any other.
   */
  readonly passivationAdmissionWindowProportion?: number;
  /**
   * Whether a candidate leaving the admission window has to out-rank the entity
   * it would displace (#848).  Default: `'off'`.
   *
   * `'frequency-sketch'` requires `passivationAdmissionWindowProportion > 0`;
   * `ShardingOptionsValidator` rejects the pair rather than degrading silently
   * to no filter, which would be a configuration that reads as armed and is not.
   */
  readonly passivationAdmissionFilter?: EntityAdmissionFilter;
  /**
   * How long an entity that was sent its `Passivate` stop-message may take to
   * stop before the shard stops it outright, in ms (#848).  Default: `0` — wait
   * forever, which is what every release before #848 did.
   *
   * The stop-message path is cooperative by design — the entity chooses when to
   * finish — and without a backstop it is cooperative with no bound: an entity
   * that never acts on the message never terminates, `EntityStopped` never
   * reaches the region, and its slot is held against `maxEntities` for the
   * lifetime of the node.  Setting this bounds that, at the price of a stop
   * that can land while the entity is still draining, so it is the operator who
   * knows the drain who picks the number.
   *
   * Independent of `maxEntities`: a positive value arms the backstop whether or
   * not a cap is configured.
   */
  readonly passivationStopTimeoutMs?: number;
  /**
   * Cap the region's routing buffer — the messages it holds while a shard's
   * home is unknown or in transition (#849, #461).
   *
   * Default: `100000`.  **A region-wide total, not a per-shard one**: the
   * buffer is keyed by shard id, and a per-queue cap would multiply by
   * `numShards` into a bound no operator picked.
   *
   * `0` means **never buffer** — every message that cannot be routed right
   * now goes straight to dead letters.  Note the polarity against
   * {@link maxEntities} in the same block, where `0` means *no* cap: here `0`
   * is the tightest setting there is, not the loosest.
   *
   * On overflow the *newest* message is dropped, not the oldest, and it is
   * dead-lettered with its sender.  Evicting from the front would hand the
   * shard a torn prefix of what a caller sent, which is the one property the
   * buffer exists to preserve.
   */
  readonly bufferSize?: number;
  /**
   * How often an unacknowledged region registration is re-sent to the
   * coordinator, in ms (#849).
   *
   * Default: `500`.  The retry is what makes a lost `Register` recoverable —
   * the frame is fire-and-forget at a path that need not exist yet — and
   * everything routed for the type buffers until the coordinator answers, so
   * this interval is also the granularity of that stall.  Raise it only if the
   * frames themselves are a cost you have measured.
   */
  readonly registerRetryIntervalMs?: number;
  /**
   * How remembered entities are brought back after this region is handed a
   * shard (#851).  Default: `'all'` — every remembered entity at once.
   *
   * The burst is the reason to change it.  A region that is handed a shard
   * under `rememberEntities` receives the whole registry for it and, under
   * `'all'`, spawns every entity in one synchronous pass; a node restart or a
   * rebalance does that for every shard it is given.  When those entities are
   * event-sourced, each spawn opens a journal replay, and the resulting fan of
   * concurrent reads lands on the store all at once.
   *
   * `'constant-rate'` spreads it — see {@link EntityRecoveryStrategy} for what
   * that does and does not bound.
   */
  readonly entityRecoveryStrategy?: EntityRecoveryStrategy;
  /**
   * Gap between two `'constant-rate'` recovery batches, in ms (#851).
   * Default: `100`.  Ignored under `'all'`.
   */
  readonly entityRecoveryConstantRateFrequencyMs?: number;
  /**
   * Entities one `'constant-rate'` batch starts (#851).  Default: `5`.
   * Ignored under `'all'`.
   *
   * **A region-wide budget, not a per-shard one.**  The queue is fed by every
   * shard this region owns, and one batch is taken from its front regardless
   * of which shards those entities belong to — so the node starts this many
   * entities per window, full stop.  Read per shard it would silently mean
   * `numShards ×` itself, which is the same conflation `maxEntities` is kept
   * region-wide to avoid.
   */
  readonly entityRecoveryConstantRateNumberOfEntities?: number;
  /**
   * Opt into stale-region detection: the region beats to the coordinator, and
   * the coordinator evicts a region that stops (#853).  Default: `false`.
   *
   * One switch drives both halves on purpose.  It is a deployment-wide fact
   * rather than a per-node one — the coordinator moves with the leader, so a
   * node that beats today is the node that sweeps tomorrow — and gating the
   * *beat* on it as well is what keeps the frame cost at exactly zero for
   * everyone who has not asked for the mechanism.
   *
   * Off by default because eviction is destructive and this is a backstop for
   * a rare frame loss: the node-level case is already covered, and far faster,
   * by the failure detector.  What it adds is the region-level one — a region
   * that is gone or wedged on a node that is still up and gossiping, whose
   * `RegionTerminated` never arrived.
   */
  readonly staleRegionDetection?: boolean;
  /**
   * How often this region tells the coordinator it is still there, in ms
   * (#853).  Default: `5000`.  Inert while {@link staleRegionDetection} is off.
   *
   * Must be shorter than
   * {@link StartShardingOptionsType.regionStaleAfterMs} — the coordinator
   * evicts on silence, so a beat slower than the threshold evicts a healthy
   * region every cycle.  `StartShardingOptionsValidator` checks the pair
   * against their *resolved* values, so setting one cannot silently cross the
   * other's default.
   */
  readonly regionHeartbeatIntervalMs?: number;
};

/**
 * Fluent builder for {@link ShardingOptionsType}.  Base of the builder
 * inheritance chain: {@link StartShardingOptionsBuilder} (in
 * `StartShardingOptions`) extends this and adds the coordinator-side
 * fields.  Each concrete `withX` records exactly one field so unset
 * fields fall through to HOCON / built-in defaults when the options are
 * normalised by {@link ShardRegion.settingsToConfig}.
 *
 * The whole-object fields — `entityActor`, `entityOptions`, and the
 * `extractEntityId` / `extractEntityMessage` extractors — are passed
 * as-is via a single `withX(value)`; no nested builders.
 */
export class ShardingOptionsBuilder<
  TMessage,
  S extends ShardingOptionsType<TMessage> = ShardingOptionsType<TMessage>,
> extends OptionsBuilder<S> {
  /** Start a fresh builder.  Equivalent to `new ShardingOptionsBuilder<TMessage>()`. */
  static create<TMessage>(): ShardingOptionsBuilder<TMessage> {
    return new ShardingOptionsBuilder<TMessage>();
  }

  /** Logical name of the sharded type. */
  withTypeName(typeName: string): this {
    return this.set('typeName', typeName);
  }

  /** The actor each entity instance is built from. */
  withEntityActor(entityActor: ActorClassOrFactory<TMessage>): this {
    return this.set('entityActor', entityActor);
  }

  /** Spawn options applied to every entity of this type. */
  withEntityOptions(entityOptions: ActorOptions<TMessage>): this {
    return this.set('entityOptions', entityOptions);
  }

  /** Derive the stable entity id from an incoming message. */
  withExtractEntityId(extractEntityId: (message: TMessage) => string): this {
    return this.set('extractEntityId', extractEntityId);
  }

  /** Unwrap the payload actually delivered to the entity.  Default: identity. */
  withExtractEntityMessage(extractEntityMessage: (message: TMessage) => unknown): this {
    return this.set('extractEntityMessage', extractEntityMessage);
  }

  /** Number of shards to spread entities across.  Default: 64. */
  withNumShards(numShards: number): this {
    return this.set('numShards', numShards);
  }

  /** Members must carry this role to be candidates for hosting shards. */
  withRole(role: string): this {
    return this.set('role', role);
  }

  /** Run as a proxy — route messages but never host entities locally. */
  withProxy(proxy = true): this {
    return this.set('proxy', proxy);
  }

  /** Track entity lifecycle so entities can be re-created on the new owner. */
  withRememberEntities(rememberEntities = true): this {
    return this.set('rememberEntities', rememberEntities);
  }

  /** Passivate an entity after it has been idle this many ms.  Default: 5 min; `0` disables. */
  withPassivationIdleMs(passivationIdleMs: number): this {
    return this.set('passivationIdleMs', passivationIdleMs);
  }

  /** Stop a shard once it has stood empty this many ms.  Default: follows `passivationIdleMs`. */
  withShardPassivationIdleMs(shardPassivationIdleMs: number): this {
    return this.set('shardPassivationIdleMs', shardPassivationIdleMs);
  }

  /** Cap the number of locally-hosted entities; LRU-passivate on overflow.  Default: 0 (no cap). */
  withMaxEntities(maxEntities: number): this {
    return this.set('maxEntities', maxEntities);
  }

  /** Which resident entity the cap gives up on overflow.  Default: `'least-recently-used'`. */
  withPassivationReplacement(passivationReplacement: EntityReplacementPolicy): this {
    return this.set('passivationReplacement', passivationReplacement);
  }

  /** Share of the cap held by the protected segment under segmented LRU.  Default: 0.8. */
  withPassivationSegmentedProtectedProportion(passivationSegmentedProtectedProportion: number): this {
    return this.set('passivationSegmentedProtectedProportion', passivationSegmentedProtectedProportion);
  }

  /** Share of the cap held as a probationary admission window.  Default: 0 (no window). */
  withPassivationAdmissionWindowProportion(passivationAdmissionWindowProportion: number): this {
    return this.set('passivationAdmissionWindowProportion', passivationAdmissionWindowProportion);
  }

  /** Make a candidate leaving the window out-rank what it displaces.  Default: `'off'`. */
  withPassivationAdmissionFilter(passivationAdmissionFilter: EntityAdmissionFilter): this {
    return this.set('passivationAdmissionFilter', passivationAdmissionFilter);
  }

  /** Force-stop an entity that ignored its stop-message after this long, in ms.  Default: 0 (never). */
  withPassivationStopTimeoutMs(passivationStopTimeoutMs: number): this {
    return this.set('passivationStopTimeoutMs', passivationStopTimeoutMs);
  }

  /**
   * Cap the region-wide routing buffer; the newest message is dead-lettered on
   * overflow.  Default: 100000.  `0` = never buffer.
   */
  withBufferSize(bufferSize: number): this {
    return this.set('bufferSize', bufferSize);
  }

  /** Re-send an unacknowledged region registration this often, in ms.  Default: 500. */
  withRegisterRetryIntervalMs(registerRetryIntervalMs: number): this {
    return this.set('registerRetryIntervalMs', registerRetryIntervalMs);
  }

  /** How remembered entities come back: all at once, or paced.  Default: `'all'`. */
  withEntityRecoveryStrategy(entityRecoveryStrategy: EntityRecoveryStrategy): this {
    return this.set('entityRecoveryStrategy', entityRecoveryStrategy);
  }

  /** Gap between two paced recovery batches, in ms.  Default: 100. */
  withEntityRecoveryConstantRateFrequencyMs(entityRecoveryConstantRateFrequencyMs: number): this {
    return this.set('entityRecoveryConstantRateFrequencyMs', entityRecoveryConstantRateFrequencyMs);
  }

  /** Entities one paced recovery batch starts, region-wide.  Default: 5. */
  withEntityRecoveryConstantRateNumberOfEntities(entityRecoveryConstantRateNumberOfEntities: number): this {
    return this.set('entityRecoveryConstantRateNumberOfEntities', entityRecoveryConstantRateNumberOfEntities);
  }

  /** Beat to the coordinator and let it evict a region that stops.  Default: off (#853). */
  withStaleRegionDetection(staleRegionDetection = true): this {
    return this.set('staleRegionDetection', staleRegionDetection);
  }

  /** How often this region beats to the coordinator, in ms.  Default: 5000. */
  withRegionHeartbeatIntervalMs(regionHeartbeatIntervalMs: number): this {
    return this.set('regionHeartbeatIntervalMs', regionHeartbeatIntervalMs);
  }
}

/**
 * Validates resolved sharding settings.  Generic so
 * {@link StartShardingOptionsValidator} can extend it via {@link commonRules};
 * only present values are checked (unset fields fall through to defaults).
 */
export class ShardingOptionsValidator<
  TMessage,
  S extends ShardingOptionsType<TMessage> = ShardingOptionsType<TMessage>,
> extends OptionsValidator<S> {
  constructor(optionsName = 'ShardingOptions') {
    super(optionsName);
  }
  protected rules(s: Partial<S>): void {
    this.commonRules(s);
  }
  protected commonRules(s: Partial<S>): void {
    const options = s as Partial<ShardingOptionsType<TMessage>>;
    // Required-ness is asserted here rather than through the check helpers,
    // which pass on `undefined` by design.  Without these, a region missing
    // its entity or its extractor validates cleanly and then fails deep inside
    // `settingsToConfig` or on the first message, far from the call that was
    // actually wrong.  A proxy region is exempt: it hosts nothing, so it needs
    // neither.
    if (options.typeName === undefined) this.fail('typeName', 'is required');
    if (!options.proxy) {
      if (options.entityActor === undefined) this.fail('entityActor', 'is required');
      if (options.extractEntityId === undefined) this.fail('extractEntityId', 'is required');
    }
    if (options.typeName !== undefined && (typeof options.typeName !== 'string' || options.typeName.length === 0)) {
      this.fail('typeName', 'must be a non-empty string', options.typeName);
    }
    if (options.numShards !== undefined && (!Number.isInteger(options.numShards) || options.numShards < 1)) {
      this.fail('numShards', 'must be an integer >= 1', options.numShards);
    }
    if (
      options.passivationIdleMs !== undefined &&
      (typeof options.passivationIdleMs !== 'number' || !Number.isFinite(options.passivationIdleMs) || options.passivationIdleMs < 0)
    ) {
      this.fail('passivationIdleMs', 'must be a non-negative finite number', options.passivationIdleMs);
    }
    if (
      options.shardPassivationIdleMs !== undefined &&
      (typeof options.shardPassivationIdleMs !== 'number' || !Number.isFinite(options.shardPassivationIdleMs) || options.shardPassivationIdleMs < 0)
    ) {
      this.fail('shardPassivationIdleMs', 'must be a non-negative finite number', options.shardPassivationIdleMs);
    }
    if (options.maxEntities !== undefined && (!Number.isInteger(options.maxEntities) || options.maxEntities < 0)) {
      this.fail('maxEntities', 'must be an integer >= 0', options.maxEntities);
    }
    if (
      options.passivationReplacement !== undefined
      && !ENTITY_REPLACEMENT_POLICIES.includes(options.passivationReplacement)
    ) {
      this.fail(
        'passivationReplacement',
        `must be one of ${ENTITY_REPLACEMENT_POLICIES.map((policy) => `'${policy}'`).join(', ')}`,
        options.passivationReplacement,
      );
    }
    if (
      options.passivationAdmissionFilter !== undefined
      && !ENTITY_ADMISSION_FILTERS.includes(options.passivationAdmissionFilter)
    ) {
      this.fail(
        'passivationAdmissionFilter',
        `must be one of ${ENTITY_ADMISSION_FILTERS.map((filter) => `'${filter}'`).join(', ')}`,
        options.passivationAdmissionFilter,
      );
    }
    // Both bounds are open at the ends the degenerate cases sit at.  A protected
    // share of `0` or `1` is a segmented policy with one empty segment, which is
    // plain LRU under a longer name; a window of `1` leaves no main region for a
    // candidate to be promoted into.  `0` for the window IS a real value — "no
    // window" — so only that bound is closed below.
    if (
      options.passivationSegmentedProtectedProportion !== undefined
      && (typeof options.passivationSegmentedProtectedProportion !== 'number'
        || !Number.isFinite(options.passivationSegmentedProtectedProportion)
        || options.passivationSegmentedProtectedProportion <= 0
        || options.passivationSegmentedProtectedProportion >= 1)
    ) {
      this.fail(
        'passivationSegmentedProtectedProportion',
        'must be a number in (0, 1)',
        options.passivationSegmentedProtectedProportion,
      );
    }
    if (
      options.passivationAdmissionWindowProportion !== undefined
      && (typeof options.passivationAdmissionWindowProportion !== 'number'
        || !Number.isFinite(options.passivationAdmissionWindowProportion)
        || options.passivationAdmissionWindowProportion < 0
        || options.passivationAdmissionWindowProportion >= 1)
    ) {
      this.fail(
        'passivationAdmissionWindowProportion',
        'must be a number in [0, 1)',
        options.passivationAdmissionWindowProportion,
      );
    }
    // `0` is a real value — wait forever, the pre-#848 behaviour — so this is a
    // non-negative rule rather than a positive one.
    if (
      options.passivationStopTimeoutMs !== undefined
      && (typeof options.passivationStopTimeoutMs !== 'number'
        || !Number.isFinite(options.passivationStopTimeoutMs)
        || options.passivationStopTimeoutMs < 0)
    ) {
      this.fail(
        'passivationStopTimeoutMs',
        'must be a non-negative finite number',
        options.passivationStopTimeoutMs,
      );
    }
    // Cross-field, and checked against the resolved pair so setting only the
    // filter cannot silently cross the window's default.  A filter with no
    // window has nothing to decide: the only candidate would be the entity a
    // message has just arrived for, which the region is not free to refuse.
    // Degrading to "no filter" instead would be a configuration that reads as
    // armed and is not (#848).
    const admissionFilter = options.passivationAdmissionFilter ?? DEFAULT_PASSIVATION_ADMISSION_FILTER;
    const windowProportion =
      options.passivationAdmissionWindowProportion ?? DEFAULT_PASSIVATION_ADMISSION_WINDOW_PROPORTION;
    if (admissionFilter !== 'off' && !(windowProportion > 0)) {
      this.fail(
        'passivationAdmissionFilter',
        `'${admissionFilter}' needs passivationAdmissionWindowProportion > 0 to have a candidate to judge`,
        admissionFilter,
      );
    }
    // `0` is legal and means "never buffer" — the tightest setting, not the
    // absence of one — so the floor is 0 rather than 1.
    if (options.bufferSize !== undefined && (!Number.isInteger(options.bufferSize) || options.bufferSize < 0)) {
      this.fail('bufferSize', 'must be an integer >= 0', options.bufferSize);
    }
    if (
      options.registerRetryIntervalMs !== undefined &&
      (typeof options.registerRetryIntervalMs !== 'number'
        || !Number.isFinite(options.registerRetryIntervalMs)
        || options.registerRetryIntervalMs <= 0)
    ) {
      this.fail('registerRetryIntervalMs', 'must be a positive finite number', options.registerRetryIntervalMs);
    }
    if (
      options.entityRecoveryStrategy !== undefined
      && !ENTITY_RECOVERY_STRATEGIES.includes(options.entityRecoveryStrategy)
    ) {
      this.fail(
        'entityRecoveryStrategy',
        `must be one of ${ENTITY_RECOVERY_STRATEGIES.map((strategy) => `'${strategy}'`).join(', ')}`,
        options.entityRecoveryStrategy,
      );
    }
    // Both bounds are strictly positive: a zero frequency is a busy loop and a
    // zero batch is a queue that never drains — under `constant-rate` either
    // one turns "recover slowly" into "never recover", which is worse than the
    // burst the setting exists to avoid.
    if (
      options.entityRecoveryConstantRateFrequencyMs !== undefined
      && (typeof options.entityRecoveryConstantRateFrequencyMs !== 'number'
        || !Number.isFinite(options.entityRecoveryConstantRateFrequencyMs)
        || options.entityRecoveryConstantRateFrequencyMs <= 0)
    ) {
      this.fail(
        'entityRecoveryConstantRateFrequencyMs',
        'must be a positive finite number',
        options.entityRecoveryConstantRateFrequencyMs,
      );
    }
    if (
      options.entityRecoveryConstantRateNumberOfEntities !== undefined
      && (!Number.isInteger(options.entityRecoveryConstantRateNumberOfEntities)
        || options.entityRecoveryConstantRateNumberOfEntities < 1)
    ) {
      this.fail(
        'entityRecoveryConstantRateNumberOfEntities',
        'must be an integer >= 1',
        options.entityRecoveryConstantRateNumberOfEntities,
      );
    }
    // Strictly positive: `0` here is not "no beat" but a timer that fires as
    // fast as the scheduler will run it, and turning the mechanism off is what
    // `staleRegionDetection` is for (#853).
    if (
      options.regionHeartbeatIntervalMs !== undefined
      && (typeof options.regionHeartbeatIntervalMs !== 'number'
        || !Number.isFinite(options.regionHeartbeatIntervalMs)
        || options.regionHeartbeatIntervalMs <= 0)
    ) {
      this.fail(
        'regionHeartbeatIntervalMs',
        'must be a positive finite number',
        options.regionHeartbeatIntervalMs,
      );
    }
  }
}

/**
 * Accepted input for a sharded-region-configurable API: the fluent
 * {@link ShardingOptionsBuilder} OR a plain {@link ShardingOptionsType} object.
 */
export type ShardingOptions<
  TMessage,
  S extends ShardingOptionsType<TMessage> = ShardingOptionsType<TMessage>,
> = ShardingOptionsBuilder<TMessage, S> | S;
/** Value alias so `ShardingOptions.create()` / `new ShardingOptions()` resolve to the builder. */
export const ShardingOptions = ShardingOptionsBuilder;
