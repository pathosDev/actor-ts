import type { ActorRef } from '../../ActorRef.js';
import type { ActorSystem } from '../../ActorSystem.js';
import type { Lease } from '../../coordination/Lease.js';
import { PersistenceExtensionId } from '../../persistence/PersistenceExtension.js';
import { Props } from '../../Props.js';
import type { Cluster } from '../Cluster.js';
import type { EnvelopeMsg } from '../Protocol.js';
import { AllocationStrategy, HashAllocationStrategy } from './AllocationStrategy.js';
import type { CoordinatorStateStore } from './CoordinatorState.js';
import {
  JournalRememberEntitiesStore,
  type RememberEntitiesStore,
} from './RememberEntitiesStore.js';
import {
  ShardRegion,
  coordinatorPath,
  type ShardingSettings,
} from './ShardRegion.js';
import { ShardCoordinator, type ShardCoordinatorSettings } from './ShardCoordinator.js';
import { isShardingMessage } from './ShardingProtocol.js';

export interface StartSettings<TMsg> extends ShardingSettings<TMsg> {
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
   * directives.  See `ShardCoordinatorSettings.lease`.
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
 * User-facing entry point.  Attaches to an ActorSystem + Cluster pair and
 * lets you start a sharded region for each entity type.  A `ShardCoordinator`
 * is spawned lazily on every node; only the one hosted by the current
 * cluster leader is active — the rest act as warm standbys.
 */
export class ClusterSharding {
  private readonly regionsByPath = new Map<string, ActorRef<unknown>>();
  private readonly coordinators = new Map<string, ActorRef<unknown>>();

  private constructor(
    public readonly system: ActorSystem,
    public readonly cluster: Cluster,
  ) {
    cluster._setEnvelopeHandler((env: EnvelopeMsg) => this.dispatchEnvelope(env));
  }

  private static instances = new WeakMap<ActorSystem, ClusterSharding>();

  static get(system: ActorSystem, cluster: Cluster): ClusterSharding {
    const existing = ClusterSharding.instances.get(system);
    if (existing) return existing;
    const created = new ClusterSharding(system, cluster);
    ClusterSharding.instances.set(system, created);
    return created;
  }

  /** Start a sharded region for a type. Returns the local region ActorRef. */
  start<TMsg>(settings: StartSettings<TMsg>): ActorRef<TMsg> {
    this.ensureCoordinator(settings as StartSettings<unknown>);
    const existing = this.findRegionByType(settings.typeName);
    if (existing) return existing as ActorRef<TMsg>;

    const cfg = ShardRegion.settingsToConfig(
      settings,
      this.cluster,
      (path: string) => this.regionsByPath.get(path) ?? null,
    );
    const ref = this.system.spawn(
      // ShardRegion internally handles extra envelope types; cast to Actor<TMsg>
      // so the returned ref presents the user-facing signature.
      Props.create<TMsg>(() => new ShardRegion<TMsg>(cfg) as unknown as import('../../Actor.js').Actor<TMsg>),
      `sharding-${settings.typeName}`,
    );
    this.regionsByPath.set(ref.path.toString(), ref as ActorRef<unknown>);
    return ref;
  }

  /** Start a proxy region — routes to the cluster but never hosts entities. */
  startProxy<TMsg>(settings: Omit<StartSettings<TMsg>, 'proxy'>): ActorRef<TMsg> {
    return this.start({ ...settings, proxy: true });
  }

  /* ------------------------------- Internal -------------------------------- */

  private ensureCoordinator(settings: StartSettings<unknown>): void {
    if (this.coordinators.has(settings.typeName)) return;
    const coordinatorSettings: ShardCoordinatorSettings = {
      typeName: settings.typeName,
      cluster: this.cluster,
      allocationStrategy: settings.allocationStrategy ?? new HashAllocationStrategy(),
      role: settings.role,
      rebalanceIntervalMs: settings.rebalanceIntervalMs,
      handOffTimeoutMs: settings.handOffTimeoutMs,
      rememberEntities: settings.rememberEntities,
      rememberEntitiesStore: this.resolveRememberEntitiesStore(settings),
      coordinatorStateStore: settings.coordinatorStateStore,
      lease: settings.lease,
      acquireRetryIntervalMs: settings.acquireRetryIntervalMs,
      localResolver: (path) => this.regionsByPath.get(path) ?? this.coordinators.get(this.typeNameFromCoordinatorPath(path) ?? '') ?? null,
    };
    const ref = this.system.spawn(
      Props.create(() => new ShardCoordinator(coordinatorSettings)),
      `sharding-coordinator-${settings.typeName}`,
    );
    this.coordinators.set(settings.typeName, ref as ActorRef<unknown>);
    this.regionsByPath.set(
      coordinatorPath(this.system.name, settings.typeName),
      ref as ActorRef<unknown>,
    );
  }

  /**
   * Resolve the `rememberEntitiesStore` for a sharded type:
   *
   *   - User passed `null`           → keep registry in-memory only.
   *   - User passed an instance      → use it as-is.
   *   - rememberEntities=false       → no persistence regardless.
   *   - rememberEntities=true (default path) → auto-instantiate
   *     `JournalRememberEntitiesStore` from the system's persistence
   *     extension so the registry survives cluster cold-starts
   *     without the user wiring anything up.
   */
  private resolveRememberEntitiesStore(
    settings: StartSettings<unknown>,
  ): RememberEntitiesStore | undefined {
    if (!settings.rememberEntities) return undefined;
    if (settings.rememberEntitiesStore === null) return undefined;
    if (settings.rememberEntitiesStore) return settings.rememberEntitiesStore;
    const journal = this.system.extension(PersistenceExtensionId).journal;
    return new JournalRememberEntitiesStore(journal);
  }

  private typeNameFromCoordinatorPath(path: string): string | null {
    const m = path.match(/\/sharding-coordinator-([^/]+)$/);
    return m ? m[1]! : null;
  }

  private findRegionByType(typeName: string): ActorRef<unknown> | null {
    const suffix = `/user/sharding-${typeName}`;
    for (const [path, ref] of this.regionsByPath) {
      if (path.endsWith(suffix)) return ref;
    }
    return null;
  }

  private dispatchEnvelope(env: EnvelopeMsg): void {
    const ref = this.regionsByPath.get(env.to);
    if (!ref) {
      this.system.log.warn(`[sharding] no region/coordinator registered for ${env.to}`);
      return;
    }
    ref.tell(env.body as never);
  }
}

export { isShardingMessage };
