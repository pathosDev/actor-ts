import type { Lease } from '../../coordination/Lease.js';
import type { AllocationStrategy } from './AllocationStrategy.js';
import type { StartSettings } from './ClusterSharding.js';
import type { CoordinatorStateStore } from './CoordinatorState.js';
import type { RememberEntitiesStore } from './RememberEntitiesStore.js';
import { ShardingOptions } from './ShardingOptions.js';

/**
 * Fluent builder for {@link StartSettings} — the argument to
 * {@link ClusterSharding.start}.  Extends {@link ShardingOptions} so it
 * carries every region-side `withX` (typeName, entityProps, extractors,
 * numShards, role, proxy, rememberEntities, …) and adds the
 * coordinator-side fields on top.
 *
 * The polymorphic fields are passed whole via a single `withX(value)`:
 * `allocationStrategy` ({@link AllocationStrategy}), `lease`
 * ({@link Lease}), `rememberEntitiesStore`, and `coordinatorStateStore`.
 */
export class StartShardingOptions<TMsg> extends ShardingOptions<TMsg, StartSettings<TMsg>> {
  /** Start a fresh builder.  Equivalent to `new StartShardingOptions<TMsg>()`. */
  static create<TMsg>(): StartShardingOptions<TMsg> {
    return new StartShardingOptions<TMsg>();
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
