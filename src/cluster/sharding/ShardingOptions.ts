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
