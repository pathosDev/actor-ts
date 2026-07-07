import type { ActorRef } from '../../ActorRef.js';
import type { Lease } from '../../coordination/Lease.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Cluster } from '../Cluster.js';
import type { AllocationStrategy } from './AllocationStrategy.js';
import type { CoordinatorStateStore } from './CoordinatorState.js';
import type { RememberEntitiesStore } from './RememberEntitiesStore.js';
import type { ShardCoordinatorSettings } from './ShardCoordinator.js';

/**
 * Fluent builder for {@link ShardCoordinatorSettings}.  Consumed by
 * {@link ClusterSharding} when it spawns the per-type coordinator; the
 * `cluster` / `localResolver` wiring fields are supplied by the
 * extension, the rest surface the user-tunable coordinator settings.
 *
 * The polymorphic fields — `allocationStrategy` ({@link AllocationStrategy}),
 * `lease` ({@link Lease}), `rememberEntitiesStore`, `coordinatorStateStore`,
 * and the `cluster` / `localResolver` wiring — are passed whole via a
 * single `withX(value)`.
 */
export class ShardCoordinatorOptions extends OptionsBuilder<ShardCoordinatorSettings> {
  /** Start a fresh builder.  Equivalent to `new ShardCoordinatorOptions()`. */
  static create(): ShardCoordinatorOptions {
    return new ShardCoordinatorOptions();
  }

  /** Logical name of the sharded type this coordinator governs. */
  withTypeName(typeName: string): this {
    return this.set('typeName', typeName);
  }

  /** The cluster this coordinator observes for leader/membership changes. */
  withCluster(cluster: Cluster): this {
    return this.set('cluster', cluster);
  }

  /** Strategy used to allocate and rebalance shards across regions. */
  withAllocationStrategy(allocationStrategy: AllocationStrategy): this {
    return this.set('allocationStrategy', allocationStrategy);
  }

  /** Only members carrying this role are candidates for hosting shards. */
  withRole(role: string): this {
    return this.set('role', role);
  }

  /** Gap between coordinator-driven rebalance passes.  Default: 2 s. */
  withRebalanceIntervalMs(rebalanceIntervalMs: number): this {
    return this.set('rebalanceIntervalMs', rebalanceIntervalMs);
  }

  /** Time to wait for HandOffComplete before force-reallocating.  Default: 10 s. */
  withHandOffTimeoutMs(handOffTimeoutMs: number): this {
    return this.set('handOffTimeoutMs', handOffTimeoutMs);
  }

  /** Track entity lifecycle so entities can be re-created on the new owner. */
  withRememberEntities(rememberEntities = true): this {
    return this.set('rememberEntities', rememberEntities);
  }

  /** Resolver for local actor paths — used when coordinator and region share a node. */
  withLocalResolver(localResolver: (path: string) => ActorRef | null): this {
    return this.set('localResolver', localResolver);
  }

  /** Optional split-brain protection — coordinator must hold the lease before acting. */
  withLease(lease: Lease): this {
    return this.set('lease', lease);
  }

  /** Retry interval for `lease.acquire()` after a failed attempt.  Default: 5 s. */
  withAcquireRetryIntervalMs(acquireRetryIntervalMs: number): this {
    return this.set('acquireRetryIntervalMs', acquireRetryIntervalMs);
  }

  /** Persistence backend for the entity registry (only used when `rememberEntities`). */
  withRememberEntitiesStore(rememberEntitiesStore: RememberEntitiesStore): this {
    return this.set('rememberEntitiesStore', rememberEntitiesStore);
  }

  /** Persistence backend for the allocation state (`regions` + `shardHome`). */
  withCoordinatorStateStore(coordinatorStateStore: CoordinatorStateStore): this {
    return this.set('coordinatorStateStore', coordinatorStateStore);
  }
}
