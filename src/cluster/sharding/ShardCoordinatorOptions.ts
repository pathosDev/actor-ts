import type { ActorRef } from '../../ActorRef.js';
import type { Lease } from '../../coordination/Lease.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Cluster } from '../Cluster.js';
import type { AllocationStrategy } from './AllocationStrategy.js';
import type { CoordinatorStateStore } from './CoordinatorState.js';
import type { RememberEntitiesStore } from './RememberEntitiesStore.js';

/**
 * Built-in default for {@link ShardCoordinatorOptionsType.rebalanceIntervalMs}.
 * Mirrors `actor-ts.sharding.rebalance-interval = 2s` in `reference.conf`.
 */
export const DEFAULT_REBALANCE_INTERVAL_MS = 2_000;

/**
 * Built-in default for {@link ShardCoordinatorOptionsType.handOffTimeoutMs} —
 * how long a hand-off may stall before the coordinator gives up on the old
 * owner and reallocates the shard.  Mirrors
 * `actor-ts.sharding.hand-off-timeout = 10s` in `reference.conf`.
 */
export const DEFAULT_HAND_OFF_TIMEOUT_MS = 10_000;

/**
 * Built-in default for {@link ShardCoordinatorOptionsType.rebalanceAbsoluteLimit}
 * — a flat ceiling on shards in flight, off by default so the relative one
 * (which scales with `numShards`) decides alone.  Mirrors
 * `actor-ts.sharding.rebalance-absolute-limit = 0` (#850).
 */
export const DEFAULT_REBALANCE_ABSOLUTE_LIMIT = 0;

/**
 * Built-in default for {@link ShardCoordinatorOptionsType.rebalanceRelativeLimit}
 * — the ceiling as a fraction of `numShards`, so it scales with the entity
 * space rather than pinning one number to every deployment.  Mirrors
 * `actor-ts.sharding.rebalance-relative-limit = 0.1` (#850).
 *
 * `0.1` is borrowed from Akka's key of the same name rather than measured here,
 * and it is a real behaviour change: at the shipped `number-of-shards = 64` a
 * 2 → 3 node join moved 42 shards in one 2 s tick and now moves 6 at a time.
 * The quantity that should actually set it is what a journal absorbs per
 * rebalance round — that needs a run against a real backend, and until one
 * exists a borrowed bound beats no bound.  Set the leaf to `0` to restore the
 * unbounded behaviour exactly.
 */
export const DEFAULT_REBALANCE_RELATIVE_LIMIT = 0.1;

/**
 * Built-in default for {@link ShardCoordinatorOptionsType.acquireRetryIntervalMs}
 * — how long the coordinator waits before re-`acquire()`ing a lease it failed to
 * take.  Mirrors `actor-ts.sharding.acquire-retry-interval = 5s` (#847).
 *
 * Only reachable where a {@link Lease} was passed in code, since HOCON has no
 * way to name one.  It is still configurable because the retry cadence is the
 * whole recovery latency of a partition that heals: until an acquire succeeds
 * the coordinator issues no `AllocateShard`, and everything routed for the type
 * buffers in the regions meanwhile.
 */
export const DEFAULT_ACQUIRE_RETRY_INTERVAL_MS = 5_000;

/**
 * Built-in default for {@link ShardCoordinatorOptionsType.regionStaleAfterMs} —
 * how long a registered region may stay silent before the coordinator declares
 * it gone and re-homes its shards (#853).  Mirrors
 * `actor-ts.sharding.stale-region-detection.stale-after = 20s`.
 *
 * Four missed beats at the shipped
 * {@link DEFAULT_REGION_HEARTBEAT_INTERVAL_MS} of 5 s.  A single missed beat
 * would make one dropped datagram evict a healthy region, and the eviction is
 * destructive — every entity under every shard it holds is re-created
 * elsewhere — so the threshold is deliberately several intervals rather than
 * one.  It is not a *node*-liveness figure and should not be compared with
 * `actor-ts.cluster.failure-detector.down-after`: a dead node is already
 * removed in ~5 s by the failure detector, and this covers only the case that
 * detector cannot see — a region gone on a node that is still up.
 *
 * The sweep rides the existing rebalance tick (2 s), so the effective latency
 * is this plus at most one tick.  There is deliberately no `check-interval`
 * key: a second timer would give an operator two dials that both mean "how
 * often does the coordinator look at the shard map".
 */
export const DEFAULT_REGION_STALE_AFTER_MS = 20_000;

/** Plain options-object shape consumed by a {@link ShardCoordinator}. */
export type ShardCoordinatorOptionsType = {
  readonly typeName: string;
  readonly cluster: Cluster;
  readonly allocationStrategy: AllocationStrategy;
  /**
   * Number of shards for this entity type — the bound the coordinator checks
   * an incoming `GetShardHome` against.
   *
   * A shard id is `hash(entityId) % numShards`, so no honest region can ever
   * ask for one outside `0 .. numShards - 1`.  Without the bound the
   * coordinator allocated, recorded and *persisted* whatever id it was asked
   * for, and the allocation map is durable state that is replayed at every
   * coordinator start — so a peer could grow it without limit and the growth
   * survived restarts (#583).
   */
  readonly numShards: number;
  readonly role?: string;
  readonly rebalanceIntervalMs?: number;
  readonly handOffTimeoutMs?: number;
  /**
   * Flat ceiling on shards a rebalance may have **in flight**.  `0` = no
   * absolute ceiling.  See {@link rebalanceRelativeLimit} for how the two
   * compose.
   */
  readonly rebalanceAbsoluteLimit?: number;
  /**
   * Ceiling on shards in flight as a fraction of `numShards`, floored at one
   * shard so a small cluster still rebalances.  `0` = no relative ceiling; `0`
   * for both leaves the rebalance uncapped, which is what it was before #850.
   *
   * Where both are set the **lower** wins.  The bound is on shards in flight
   * rather than per tick because a tick fires every `rebalanceIntervalMs` while
   * a hand-off may stand for a whole `handOffTimeoutMs` — at the shipped 2 s and
   * 10 s a per-tick cap of six would permit thirty concurrent hand-offs.
   */
  readonly rebalanceRelativeLimit?: number;
  readonly rememberEntities?: boolean;
  /**
   * Evict a registered region that has gone silent, and re-home its shards
   * (#853).  Default: `false`.
   *
   * The same deployment-wide switch the regions read
   * ({@link ShardingOptionsType.staleRegionDetection}): with it off nothing
   * beats and nothing sweeps, so the mechanism costs nothing at all until it is
   * asked for.  Only a region that has actually beaten at least once is ever a
   * sweep candidate — see `ShardCoordinator.sweepStaleRegions` for why that
   * matters during a rolling deploy.
   */
  readonly staleRegionDetection?: boolean;
  /**
   * Silence after which a region is declared gone, in ms (#853).  Default:
   * `20000`.  Inert while {@link staleRegionDetection} is off.
   *
   * Must exceed {@link ShardingOptionsType.regionHeartbeatIntervalMs}, or the
   * coordinator evicts a healthy region between two of its beats.
   */
  readonly regionStaleAfterMs?: number;
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
};

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

  /** Shard count for this entity type — the bound a `GetShardHome` must fall inside. */
  withNumShards(numShards: number): this {
    return this.set('numShards', numShards);
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

  /** Flat ceiling on shards in flight during a rebalance.  `0` disables it.  Default: 0. */
  withRebalanceAbsoluteLimit(rebalanceAbsoluteLimit: number): this {
    return this.set('rebalanceAbsoluteLimit', rebalanceAbsoluteLimit);
  }

  /** Ceiling on shards in flight as a fraction of `numShards`.  `0` disables it.  Default: 0.1. */
  withRebalanceRelativeLimit(rebalanceRelativeLimit: number): this {
    return this.set('rebalanceRelativeLimit', rebalanceRelativeLimit);
  }

  /** Track entity lifecycle so entities can be re-created on the new owner. */
  withRememberEntities(rememberEntities = true): this {
    return this.set('rememberEntities', rememberEntities);
  }

  /** Evict a registered region that stops beating, and re-home its shards.  Default: off (#853). */
  withStaleRegionDetection(staleRegionDetection = true): this {
    return this.set('staleRegionDetection', staleRegionDetection);
  }

  /** Silence after which a region is declared gone, in ms.  Default: 20000. */
  withRegionStaleAfterMs(regionStaleAfterMs: number): this {
    return this.set('regionStaleAfterMs', regionStaleAfterMs);
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
