import type { ActorRef } from '../../ActorRef.js';
import type { Lease } from '../../coordination/Lease.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Cluster } from '../Cluster.js';
import type { AllocationStrategy } from './AllocationStrategy.js';
import type { CoordinatorStateStore } from './CoordinatorState.js';
import type { RememberEntitiesStore } from './RememberEntitiesStore.js';

/** Plain options-object shape consumed by a {@link ShardCoordinator}. */
export interface ShardCoordinatorOptionsType {
  readonly typeName: string;
  readonly cluster: Cluster;
  readonly allocationStrategy: AllocationStrategy;
  readonly role?: string;
  readonly rebalanceIntervalMs?: number;
  readonly handOffTimeoutMs?: number;
  readonly rememberEntities?: boolean;
  /** Resolver for local actor paths — used when coordinator lives on the same node as a region. */
  readonly localResolver: (path: string) => ActorRef | null;
  /**
   * Optional split-brain protection.  When set, the elected leader's
   * coordinator must hold the lease before it processes shard
   * messages.  Under a network partition where two nodes converge to
   * "I am the leader" gossip views, only the side that successfully
   * acquires the lease ever issues `AllocateShard` / `HandOff`
   * directives — the other side stays passive and drops messages
   * (regions retry naturally on their next cache miss).
   *
   * Without a lease the coordinator gates only on `isLeader()` —
   * v1 behaviour, no extra coordination.
   */
  readonly lease?: Lease;
  /** Retry interval for `lease.acquire()` after a failed attempt.  Default: 5 s. */
  readonly acquireRetryIntervalMs?: number;
  /**
   * Optional persistence backend for the entity registry.  Only used
   * when `rememberEntities: true`.  Without it, `entitiesPerShard`
   * stays in-memory only and a full cluster restart loses the
   * registry — until messages re-arrive and trigger fresh
   * EntityStarted notifications.  Set to a `JournalRememberEntitiesStore`
   * (or any custom impl) to make the registry survive cold-starts.
   *
   * The `ClusterSharding` extension auto-instantiates the default
   * `JournalRememberEntitiesStore` (using the active Journal) when
   * `rememberEntities: true` and no explicit store is provided —
   * so most users don't need to touch this field.
   */
  readonly rememberEntitiesStore?: RememberEntitiesStore;
  /**
   * Optional persistence backend for the allocation state itself
   * (`regions` + `shardHome`).  Without it, `LeaderChanged` triggers
   * a full rebuild from `Register` gossip — fine for a few hundred
   * shards, painful at thousands.  With it, the new leader loads
   * the last-known snapshot from the store (e.g. `DistributedData`)
   * and skips the reallocation storm.
   *
   * `ClusterSharding` does NOT auto-instantiate this — the user
   * must explicitly start a DistributedData extension first and
   * pass `new DistributedDataCoordinatorStateStore(...)`.  Without
   * that opt-in, `ShardCoordinator` keeps the v1 rebuild-from-
   * Register behaviour (backwards-compat).
   */
  readonly coordinatorStateStore?: CoordinatorStateStore;
}

/**
 * Fluent builder for {@link ShardCoordinatorOptionsType}.  Consumed by
 * {@link ClusterSharding} when it spawns the per-type coordinator; the
 * `cluster` / `localResolver` wiring fields are supplied by the
 * extension, the rest surface the user-tunable coordinator options.
 *
 * The polymorphic fields — `allocationStrategy` ({@link AllocationStrategy}),
 * `lease` ({@link Lease}), `rememberEntitiesStore`, `coordinatorStateStore`,
 * and the `cluster` / `localResolver` wiring — are passed whole via a
 * single `withX(value)`.
 */
export class ShardCoordinatorOptionsBuilder extends OptionsBuilder<ShardCoordinatorOptionsType> {
  /** Start a fresh builder.  Equivalent to `new ShardCoordinatorOptionsBuilder()`. */
  static create(): ShardCoordinatorOptionsBuilder {
    return new ShardCoordinatorOptionsBuilder();
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

/**
 * Accepted input for a {@link ShardCoordinator}: the fluent
 * {@link ShardCoordinatorOptionsBuilder} OR a plain (partial)
 * {@link ShardCoordinatorOptionsType} object.
 */
export type ShardCoordinatorOptions = ShardCoordinatorOptionsBuilder | Partial<ShardCoordinatorOptionsType>;
/** Value alias so `ShardCoordinatorOptions.create()` / `new ShardCoordinatorOptions()` resolve to the builder. */
export const ShardCoordinatorOptions = ShardCoordinatorOptionsBuilder;
