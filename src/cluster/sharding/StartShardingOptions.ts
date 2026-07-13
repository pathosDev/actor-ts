import type { Lease } from '../../coordination/Lease.js';
import type { AllocationStrategy } from './AllocationStrategy.js';
import type { CoordinatorStateStore } from './CoordinatorState.js';
import type { RememberEntitiesStore } from './RememberEntitiesStore.js';
import { ShardingOptionsBuilder, ShardingOptionsValidator } from './ShardingOptions.js';
import type { ShardingOptionsType } from './ShardingOptions.js';

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
}

/**
 * Fluent builder for {@link StartShardingOptionsType} — the argument to
 * {@link ClusterSharding.start}.  Extends {@link ShardingOptionsBuilder} so it
 * carries every region-side `withX` (typeName, entityProps, extractors,
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
}

/**
 * Validates resolved {@link StartShardingOptionsType} settings — the region-side
 * {@link ShardingOptionsValidator} rules plus the coordinator-side intervals.
 */
export class StartShardingOptionsValidator<TMsg>
  extends ShardingOptionsValidator<TMsg, StartShardingOptionsType<TMsg>> {
  constructor() {
    super('StartShardingOptions');
  }
  protected override rules(s: Partial<StartShardingOptionsType<TMsg>>): void {
    this.commonRules(s);
    this.positiveNumber('rebalanceIntervalMs');
    this.positiveNumber('handOffTimeoutMs');
    this.positiveNumber('acquireRetryIntervalMs');
  }
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
