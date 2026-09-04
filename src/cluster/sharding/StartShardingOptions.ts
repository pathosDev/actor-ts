import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { Lease } from '../../coordination/Lease.js';
import type { AllocationStrategy } from './AllocationStrategy.js';
import type { CoordinatorStateStore } from './CoordinatorState.js';
import type { RememberEntitiesStore } from './RememberEntitiesStore.js';
import { ShardingOptionsBuilder, ShardingOptionsValidator } from './ShardingOptions.js';
import type { EntityRecoveryStrategy, ShardingOptionsType } from './ShardingOptions.js';

/**
 * Built-in default for {@link StartShardingOptionsType.shardRegionQueryTimeoutMs}
 * — how long {@link ClusterSharding.shards} and
 * {@link ClusterSharding.shardRefFor} wait when the caller names no timeout
 * (#849).  Mirrors `actor-ts.sharding.shard-region-query-timeout`.
 *
 * Deliberately **not** the region's `asksTtlMs`, which is the GC lifetime of a
 * correlation for a remote entity `ask` and is measured in minutes.  Binding
 * this key to that one would silently discard the reply to every cross-node
 * ask outliving the query timeout, including one at the framework's own
 * `DEFAULT_ASK_TIMEOUT_MS`.
 */
export const DEFAULT_SHARD_REGION_QUERY_TIMEOUT_MS = 5_000;

/**
 * Plain options-object shape accepted by {@link ClusterSharding.start} —
 * the region-side {@link ShardingOptionsType} plus the coordinator-side
 * fields (allocation, rebalance, lease, persistence backends).
 */
export interface StartShardingOptionsType<TMessage> extends ShardingOptionsType<TMessage> {
  /** Strategy the coordinator uses to allocate and rebalance shards. */
  readonly allocationStrategy?: AllocationStrategy;
  /** Gap between coordinator-driven rebalance passes. */
  readonly rebalanceIntervalMs?: number;
  /** Time to wait for HandOffComplete before force-reallocating. */
  readonly handOffTimeoutMs?: number;
  /**
   * Flat ceiling on shards a rebalance may have **in flight**.  `0` = no
   * absolute ceiling.  See `ShardCoordinatorOptionsType.rebalanceRelativeLimit`
   * for how the two compose (#850).
   */
  readonly rebalanceAbsoluteLimit?: number;
  /**
   * Ceiling on shards in flight as a fraction of `numShards`, floored at one.
   * `0` = no relative ceiling; `0` for both leaves the rebalance uncapped
   * (#850).
   */
  readonly rebalanceRelativeLimit?: number;
  /**
   * Optional split-brain protection for the coordinator.  When set,
   * the elected leader's coordinator must hold the lease before it
   * processes shard messages — under a network partition that
   * produces two leader views, only the side that successfully
   * acquires the lease ever issues `AllocateShard` / `HandOff`
   * directives.  See `ShardCoordinatorOptionsType.lease`.
   */
  readonly lease?: Lease;
  /** Retry interval for `lease.acquire()` after a failed attempt.  Default: 5 s. */
  readonly acquireRetryIntervalMs?: number;
  /**
   * Optional persistence backend for the entity registry — relevant
   * only when `rememberEntities: true`.  When omitted (and
   * `rememberEntities: true`), the default
   * `JournalRememberEntitiesStore` is auto-instantiated using the
   * Journal from the system's `PersistenceExtension`, so a full
   * cluster cold-start no longer loses the registry.  Set to a
   * custom impl to plug in a separate store.
   *
   * Pass `null` to opt out of persistence entirely (registry stays
   * in-memory only — the v1 behaviour).
   */
  readonly rememberEntitiesStore?: RememberEntitiesStore | null;
  /**
   * Optional persistence backend for the coordinator's allocation
   * state (`regions` + `shardHome`).  When set, a new leader
   * elected after the previous leader's failure can seed its
   * coordinator from the snapshot instead of running
   * `tryAllocate` from scratch — saves a brief reallocation storm
   * at thousands-of-shards scale.
   *
   * Unlike `rememberEntitiesStore`, ClusterSharding does NOT
   * auto-instantiate this — the user must explicitly pass a store
   * (typically `new DistributedDataCoordinatorStateStore(dd, ...)`).
   * Without it, the v1 rebuild-from-Register behaviour is preserved.
   */
  readonly coordinatorStateStore?: CoordinatorStateStore;
  /**
   * Default timeout, in ms, for {@link ClusterSharding.shards} and
   * {@link ClusterSharding.shardRefFor} on this type (#849).  Default: 5000.
   *
   * A start-time option rather than a region field, because it configures how
   * *this node queries* the region rather than anything the region itself
   * does.  An explicit `timeoutMs` argument at the call still wins, so the
   * precedence a caller sees is **argument > option > HOCON > 5 s**.
   */
  readonly shardRegionQueryTimeoutMs?: number;
}

/**
 * Fluent builder for {@link StartShardingOptionsType} — the argument to
 * {@link ClusterSharding.start}.  Extends {@link ShardingOptionsBuilder} so it
 * carries every region-side `withX` (typeName, entityActor, extractors,
 * numShards, role, proxy, rememberEntities, …) and adds the
 * coordinator-side fields on top.
 *
 * The polymorphic fields are passed whole via a single `withX(value)`:
 * `allocationStrategy` ({@link AllocationStrategy}), `lease`
 * ({@link Lease}), `rememberEntitiesStore`, and `coordinatorStateStore`.
 */
export class StartShardingOptionsBuilder<TMessage> extends ShardingOptionsBuilder<TMessage, StartShardingOptionsType<TMessage>> {
  /** Start a fresh builder.  Equivalent to `new StartShardingOptionsBuilder<TMessage>()`. */
  static create<TMessage>(): StartShardingOptionsBuilder<TMessage> {
    return new StartShardingOptionsBuilder<TMessage>();
  }

  /** Strategy the coordinator uses to allocate and rebalance shards. */
  withAllocationStrategy(allocationStrategy: AllocationStrategy): this {
    return this.set('allocationStrategy', allocationStrategy);
  }

  /** Gap between coordinator-driven rebalance passes. */
  withRebalanceIntervalMs(rebalanceIntervalMs: number): this {
    return this.set('rebalanceIntervalMs', rebalanceIntervalMs);
  }

  /** Time to wait for HandOffComplete before force-reallocating. */
  withHandOffTimeoutMs(handOffTimeoutMs: number): this {
    return this.set('handOffTimeoutMs', handOffTimeoutMs);
  }

  /** Flat ceiling on shards in flight during a rebalance.  `0` disables it.  Default: 0. */
  withRebalanceAbsoluteLimit(rebalanceAbsoluteLimit: number): this {
    return this.set('rebalanceAbsoluteLimit', rebalanceAbsoluteLimit);
  }

  /** Ceiling on shards in flight as a fraction of `numShards`.  `0` disables it.  Default: 0.1. */
  withRebalanceRelativeLimit(rebalanceRelativeLimit: number): this {
    return this.set('rebalanceRelativeLimit', rebalanceRelativeLimit);
  }

  /** Optional split-brain protection for the coordinator (a {@link Lease}). */
  withLease(lease: Lease): this {
    return this.set('lease', lease);
  }

  /** Retry interval for `lease.acquire()` after a failed attempt.  Default: 5 s. */
  withAcquireRetryIntervalMs(acquireRetryIntervalMs: number): this {
    return this.set('acquireRetryIntervalMs', acquireRetryIntervalMs);
  }

  /**
   * Persistence backend for the entity registry (only when `rememberEntities`).
   * Pass `null` to keep the registry in-memory only (opt out of persistence).
   */
  withRememberEntitiesStore(rememberEntitiesStore: RememberEntitiesStore | null): this {
    return this.set('rememberEntitiesStore', rememberEntitiesStore);
  }

  /** Persistence backend for the coordinator's allocation state. */
  withCoordinatorStateStore(coordinatorStateStore: CoordinatorStateStore): this {
    return this.set('coordinatorStateStore', coordinatorStateStore);
  }

  /** Default timeout for `shards()` / `shardRefFor()` on this type, in ms.  Default: 5000. */
  withShardRegionQueryTimeoutMs(shardRegionQueryTimeoutMs: number): this {
    return this.set('shardRegionQueryTimeoutMs', shardRegionQueryTimeoutMs);
  }
}

/**
 * Validates resolved {@link StartShardingOptionsType} settings — the region-side
 * {@link ShardingOptionsValidator} rules plus the coordinator-side intervals.
 */
export class StartShardingOptionsValidator<TMessage>
  extends ShardingOptionsValidator<TMessage, StartShardingOptionsType<TMessage>> {
  constructor() {
    super('StartShardingOptions');
  }
  protected override rules(s: Partial<StartShardingOptionsType<TMessage>>): void {
    this.commonRules(s);
    this.positiveNumber('rebalanceIntervalMs');
    this.positiveNumber('handOffTimeoutMs');
    this.positiveNumber('acquireRetryIntervalMs');
    this.positiveNumber('shardRegionQueryTimeoutMs');
    // `0` is a real value on both — it switches that ceiling off — so neither
    // is a `positive*` rule.  The relative one is a fraction and not a count:
    // `nonNegativeInt` would reject the 0.1 that ships (#850).
    this.nonNegativeInt('rebalanceAbsoluteLimit');
    this.numberInRange('rebalanceRelativeLimit', 0, 1);
  }
}

/**
 * The slice of sharding settings HOCON can supply.  All of them are plain
 * scalars, so the type carries no entity-message parameter — deliberately,
 * since the config file is read once per node and cannot know the type it
 * will be layered under.
 *
 * The polymorphic fields (`entityActor`, the extractors, `allocationStrategy`,
 * `lease`, the stores) are absent by nature: HOCON has no way to express a
 * class or a closure, so those stay code-only.
 *
 * `role` is the one member here that is placement rather than tuning, and it is
 * in on purpose: *which* role hosts a type is uniform across a deployment,
 * while *which* roles a node carries is per-node identity and stays code-only
 * (`ClusterOptions.roles` has no leaf, see `ConfigKeys.sharding`).  `proxy` is
 * the counter-example and stays out: it is per-node topology, a second `start`
 * disagreeing about it throws, and a deployment-wide `proxy = on` would leave
 * nothing hosting anything (#847).
 */
export type ShardingConfigDefaults = Pick<
  StartShardingOptionsType<unknown>,
  | 'numShards'
  | 'role'
  | 'rememberEntities'
  | 'passivationIdleMs'
  | 'shardPassivationIdleMs'
  | 'maxEntities'
  | 'bufferSize'
  | 'registerRetryIntervalMs'
  | 'rebalanceIntervalMs'
  | 'handOffTimeoutMs'
  | 'rebalanceAbsoluteLimit'
  | 'rebalanceRelativeLimit'
  | 'acquireRetryIntervalMs'
  | 'shardRegionQueryTimeoutMs'
  | 'entityRecoveryStrategy'
  | 'entityRecoveryConstantRateFrequencyMs'
  | 'entityRecoveryConstantRateNumberOfEntities'
>;

/**
 * Read the `actor-ts.sharding.*` block into the shape
 * {@link ClusterSharding.start} merges under the caller's options.
 *
 * Only keys actually present are returned.  That is the whole point of the
 * `hasPath` guards: a key read unconditionally would come back `undefined`
 * and, once spread, shadow the built-in default it was supposed to fall
 * through to.
 */
export function readShardingOptionsFromConfig(config: Config): ShardingConfigDefaults {
  const keys = ConfigKeys.sharding;
  // Mutable while being filled; consumers see the readonly shape.
  const out: { -readonly [K in keyof ShardingConfigDefaults]: ShardingConfigDefaults[K] } = {};
  if (config.hasPath(keys.numberOfShards)) out.numShards = config.getInt(keys.numberOfShards);
  if (config.hasPath(keys.role)) {
    // `""` is how a HOCON file says "no opinion" for a string whose absence is
    // the real default — the same shape `dead-letters.persistence-id` uses.
    // `reference.conf` merges under everything, so the shipped placeholder makes
    // `hasPath` true forever; read unguarded it would put `role: ''` into every
    // merged options object on every node that configured nothing.
    const role = config.getString(keys.role);
    if (role.length > 0) out.role = role;
  }
  if (config.hasPath(keys.rememberEntities)) out.rememberEntities = config.getBoolean(keys.rememberEntities);
  if (config.hasPath(keys.passivationIdle)) out.passivationIdleMs = config.getDuration(keys.passivationIdle);
  // Absent from reference.conf on purpose, so this stays genuinely optional:
  // leaving it out is what lets the shard window fall through to the entity one.
  if (config.hasPath(keys.shardPassivationIdle)) {
    out.shardPassivationIdleMs = config.getDuration(keys.shardPassivationIdle);
  }
  if (config.hasPath(keys.maxEntities)) out.maxEntities = config.getInt(keys.maxEntities);
  if (config.hasPath(keys.bufferSize)) out.bufferSize = config.getInt(keys.bufferSize);
  if (config.hasPath(keys.registerRetryInterval)) {
    out.registerRetryIntervalMs = config.getDuration(keys.registerRetryInterval);
  }
  if (config.hasPath(keys.rebalanceInterval)) out.rebalanceIntervalMs = config.getDuration(keys.rebalanceInterval);
  if (config.hasPath(keys.handOffTimeout)) out.handOffTimeoutMs = config.getDuration(keys.handOffTimeout);
  if (config.hasPath(keys.rebalanceAbsoluteLimit)) {
    out.rebalanceAbsoluteLimit = config.getInt(keys.rebalanceAbsoluteLimit);
  }
  if (config.hasPath(keys.rebalanceRelativeLimit)) {
    // `getNumber`, not `getInt`: the leaf is a fraction of `numShards` and
    // `getInt` throws on 0.1 — the shipped default (#850).
    out.rebalanceRelativeLimit = config.getNumber(keys.rebalanceRelativeLimit);
  }
  if (config.hasPath(keys.acquireRetryInterval)) {
    out.acquireRetryIntervalMs = config.getDuration(keys.acquireRetryInterval);
  }
  if (config.hasPath(keys.shardRegionQueryTimeout)) {
    out.shardRegionQueryTimeoutMs = config.getDuration(keys.shardRegionQueryTimeout);
  }
  if (config.hasPath(keys.entityRecoveryStrategy)) {
    // Narrowed rather than cast: HOCON is untyped, so a misspelt strategy would
    // otherwise reach `settingsToConfig` as a value the switch there does not
    // know and be silently treated as `all` — the burst the operator was trying
    // to remove.  Leaving an unrecognised literal in place is what lets
    // `ShardingOptionsValidator` name the field and the bad value instead.
    out.entityRecoveryStrategy = config.getString(keys.entityRecoveryStrategy) as EntityRecoveryStrategy;
  }
  if (config.hasPath(keys.entityRecoveryConstantRateFrequency)) {
    out.entityRecoveryConstantRateFrequencyMs =
      config.getDuration(keys.entityRecoveryConstantRateFrequency);
  }
  if (config.hasPath(keys.entityRecoveryConstantRateNumberOfEntities)) {
    out.entityRecoveryConstantRateNumberOfEntities =
      config.getInt(keys.entityRecoveryConstantRateNumberOfEntities);
  }
  return out;
}

/**
 * Accepted input for {@link ClusterSharding.start}: the fluent
 * {@link StartShardingOptionsBuilder} OR a plain (partial)
 * {@link StartShardingOptionsType} object.
 */
export type StartShardingOptions<TMessage> =
  | StartShardingOptionsBuilder<TMessage>
  | Partial<StartShardingOptionsType<TMessage>>;
/** Value alias so `StartShardingOptions.create()` / `new StartShardingOptions()` resolve to the builder. */
export const StartShardingOptions = StartShardingOptionsBuilder;
