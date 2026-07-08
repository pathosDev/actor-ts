import type { ActorRef } from '../../ActorRef.js';
import type { ActorSystem } from '../../ActorSystem.js';
import { PersistenceExtensionId } from '../../persistence/PersistenceExtension.js';
import { Props } from '../../Props.js';
import type { Cluster } from '../Cluster.js';
import type { EnvelopeMsg } from '../Protocol.js';
import { HashAllocationStrategy } from './AllocationStrategy.js';
import {
  JournalRememberEntitiesStore,
  type RememberEntitiesStore,
} from './RememberEntitiesStore.js';
import {
  ShardRegion,
  coordinatorPath,
} from './ShardRegion.js';
import { ShardCoordinator } from './ShardCoordinator.js';
import { ShardCoordinatorOptions } from './ShardCoordinatorOptions.js';
import type { StartShardingOptions, StartShardingOptionsType } from './StartShardingOptions.js';
import { ShardingOptionsValidator } from './ShardingOptions.js';
import { isShardingMessage } from './ShardingProtocol.js';

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

  /**
   * Start a sharded region for a type.  Three calling shapes:
   *
   * ```ts
   * // Shorthand: pass the entity class.  Framework wraps it with Props.create.
   * sharding.start('counter', CounterEntity, {
   *   extractEntityId: (msg) => msg.id,
   * });
   *
   * // Shorthand: pass a factory.  Useful for closures / DI / no-arg new.
   * sharding.start('cart', () => new CartEntity(deps),
   *   StartShardingOptions.create<CartMsg>().withExtractEntityId((msg) => msg.entityId));
   *
   * // Full-form: explicit Props + all settings via the builder.
   * sharding.start(
   *   StartShardingOptions.create<CounterMsg>()
   *     .withTypeName('counter')
   *     .withEntityProps(Props.create(() => new CounterEntity()))
   *     .withExtractEntityId((msg) => msg.id),
   * );
   * ```
   */
  start<TMsg>(options: StartShardingOptions<TMsg>): ActorRef<TMsg>;
  start<TMsg>(
    typeName: string,
    entity: (new () => import('../../Actor.js').Actor<TMsg>) | (() => import('../../Actor.js').Actor<TMsg>),
    options?: StartShardingOptions<TMsg>,
  ): ActorRef<TMsg>;
  start<TMsg>(
    arg1: string | StartShardingOptions<TMsg>,
    arg2?: (new () => import('../../Actor.js').Actor<TMsg>) | (() => import('../../Actor.js').Actor<TMsg>),
    arg3?: StartShardingOptions<TMsg>,
  ): ActorRef<TMsg> {
    const settings = typeof arg1 === 'string'
      ? this.buildSettingsFromShorthand(arg1, arg2!, arg3 ?? {})
      : arg1 as StartShardingOptionsType<TMsg>;
    new ShardingOptionsValidator<TMsg>().validate(settings);

    this.ensureCoordinator(settings as StartShardingOptionsType<unknown>);
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

  /** @internal — wrap the shorthand entity arg into a Props + assemble full settings. */
  private buildSettingsFromShorthand<TMsg>(
    typeName: string,
    entity: (new () => import('../../Actor.js').Actor<TMsg>) | (() => import('../../Actor.js').Actor<TMsg>),
    options: StartShardingOptions<TMsg>,
  ): StartShardingOptionsType<TMsg> {
    const opts = (options as Partial<StartShardingOptionsType<TMsg>>);
    // Classes have a `.prototype` whose `constructor` === the class itself.
    // Arrow functions don't have `prototype`; regular non-class functions do
    // (with `.prototype.constructor === fn`), so we treat anything that's
    // `new`-able the same way classes are.  The closure form (arrow `() =>
    // new X()`) falls into the factory branch.
    const isClass =
      typeof entity === 'function' &&
      typeof (entity as { prototype?: { constructor?: unknown } }).prototype === 'object' &&
      (entity as { prototype?: { constructor?: unknown } }).prototype?.constructor === entity;
    const factory: () => import('../../Actor.js').Actor<TMsg> = isClass
      ? () => new (entity as new () => import('../../Actor.js').Actor<TMsg>)()
      : (entity as () => import('../../Actor.js').Actor<TMsg>);
    return {
      ...opts,
      typeName,
      entityProps: Props.create<TMsg>(factory),
    } as StartShardingOptionsType<TMsg>;
  }

  /**
   * Start a proxy region — routes to the cluster but never hosts entities.
   * Takes the same builder as {@link start}; `proxy` is forced on internally,
   * so any `withProxy(...)` on the passed builder is overridden.
   */
  startProxy<TMsg>(options: StartShardingOptions<TMsg>): ActorRef<TMsg> {
    // Force `proxy: true` regardless of what the caller passed.  Resolve to a
    // plain settings object first so both builder and plain-object inputs are
    // handled uniformly (a `Partial<StartShardingOptionsType>` has no `.withProxy`).
    const settings: Partial<StartShardingOptionsType<TMsg>> = { ...(options as Partial<StartShardingOptionsType<TMsg>>), proxy: true };
    return this.start(settings);
  }

  /* ------------------------------- Internal -------------------------------- */

  private ensureCoordinator(settings: StartShardingOptionsType<unknown>): void {
    if (this.coordinators.has(settings.typeName)) return;
    const coordinatorOptions = ShardCoordinatorOptions.create()
      .withTypeName(settings.typeName)
      .withCluster(this.cluster)
      .withAllocationStrategy(settings.allocationStrategy ?? new HashAllocationStrategy())
      .withLocalResolver((path) =>
        this.regionsByPath.get(path)
        ?? this.coordinators.get(this.typeNameFromCoordinatorPath(path) ?? '')
        ?? null);
    if (settings.role !== undefined) coordinatorOptions.withRole(settings.role);
    if (settings.rebalanceIntervalMs !== undefined) coordinatorOptions.withRebalanceIntervalMs(settings.rebalanceIntervalMs);
    if (settings.handOffTimeoutMs !== undefined) coordinatorOptions.withHandOffTimeoutMs(settings.handOffTimeoutMs);
    if (settings.rememberEntities !== undefined) coordinatorOptions.withRememberEntities(settings.rememberEntities);
    const store = this.resolveRememberEntitiesStore(settings);
    if (store !== undefined) coordinatorOptions.withRememberEntitiesStore(store);
    if (settings.coordinatorStateStore !== undefined) coordinatorOptions.withCoordinatorStateStore(settings.coordinatorStateStore);
    if (settings.lease !== undefined) coordinatorOptions.withLease(settings.lease);
    if (settings.acquireRetryIntervalMs !== undefined) coordinatorOptions.withAcquireRetryIntervalMs(settings.acquireRetryIntervalMs);
    const ref = this.system.spawn(
      Props.create(() => new ShardCoordinator(coordinatorOptions)),
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
    settings: StartShardingOptionsType<unknown>,
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
