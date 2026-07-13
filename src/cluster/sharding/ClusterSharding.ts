import type { ActorRef } from '../../ActorRef.js';
import type { ActorSystem } from '../../ActorSystem.js';
import { PersistenceExtensionId } from '../../persistence/PersistenceExtension.js';
import { Props } from '../../Props.js';
import type { Cluster } from '../Cluster.js';
import type { EnvelopeMessage } from '../Protocol.js';
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
    cluster._setEnvelopeHandler((env: EnvelopeMessage) => this.dispatchEnvelope(env));
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
   *   StartShardingOptions.create<CartMessage>().withExtractEntityId((msg) => msg.entityId));
   *
   * // Full-form: explicit Props + all options via the builder.
   * sharding.start(
   *   StartShardingOptions.create<CounterMessage>()
   *     .withTypeName('counter')
   *     .withEntityProps(Props.create(() => new CounterEntity()))
   *     .withExtractEntityId((msg) => msg.id),
   * );
   * ```
   */
  start<TMessage>(options: StartShardingOptions<TMessage>): ActorRef<TMessage>;
  start<TMessage>(
    typeName: string,
    entity: (new () => import('../../Actor.js').Actor<TMessage>) | (() => import('../../Actor.js').Actor<TMessage>),
    options?: StartShardingOptions<TMessage>,
  ): ActorRef<TMessage>;
  start<TMessage>(
    arg1: string | StartShardingOptions<TMessage>,
    arg2?: (new () => import('../../Actor.js').Actor<TMessage>) | (() => import('../../Actor.js').Actor<TMessage>),
    arg3?: StartShardingOptions<TMessage>,
  ): ActorRef<TMessage> {
    const options = typeof arg1 === 'string'
      ? this.buildOptionsFromShorthand(arg1, arg2!, arg3 ?? {})
      : arg1 as StartShardingOptionsType<TMessage>;

    this.ensureCoordinator(options as StartShardingOptionsType<unknown>);
    const existing = this.findRegionByType(options.typeName);
    if (existing) return existing as ActorRef<TMessage>;

    const cfg = ShardRegion.settingsToConfig(
      options,
      this.cluster,
      (path: string) => this.regionsByPath.get(path) ?? null,
    );
    const ref = this.system.spawn(
      // ShardRegion internally handles extra envelope types; cast to Actor<TMessage>
      // so the returned ref presents the user-facing signature.
      Props.create<TMessage>(() => new ShardRegion<TMessage>(cfg) as unknown as import('../../Actor.js').Actor<TMessage>),
      `sharding-${options.typeName}`,
    );
    this.regionsByPath.set(ref.path.toString(), ref as ActorRef<unknown>);
    return ref;
  }

  /** @internal — wrap the shorthand entity arg into a Props + assemble full options. */
  private buildOptionsFromShorthand<TMessage>(
    typeName: string,
    entity: (new () => import('../../Actor.js').Actor<TMessage>) | (() => import('../../Actor.js').Actor<TMessage>),
    options: StartShardingOptions<TMessage>,
  ): StartShardingOptionsType<TMessage> {
    const opts = (options as Partial<StartShardingOptionsType<TMessage>>);
    // Classes have a `.prototype` whose `constructor` === the class itself.
    // Arrow functions don't have `prototype`; regular non-class functions do
    // (with `.prototype.constructor === fn`), so we treat anything that's
    // `new`-able the same way classes are.  The closure form (arrow `() =>
    // new X()`) falls into the factory branch.
    const isClass =
      typeof entity === 'function' &&
      typeof (entity as { prototype?: { constructor?: unknown } }).prototype === 'object' &&
      (entity as { prototype?: { constructor?: unknown } }).prototype?.constructor === entity;
    const factory: () => import('../../Actor.js').Actor<TMessage> = isClass
      ? () => new (entity as new () => import('../../Actor.js').Actor<TMessage>)()
      : (entity as () => import('../../Actor.js').Actor<TMessage>);
    return {
      ...opts,
      typeName,
      entityProps: Props.create<TMessage>(factory),
    } as StartShardingOptionsType<TMessage>;
  }

  /**
   * Start a proxy region — routes to the cluster but never hosts entities.
   * Takes the same builder as {@link start}; `proxy` is forced on internally,
   * so any `withProxy(...)` on the passed builder is overridden.
   */
  startProxy<TMessage>(options: StartShardingOptions<TMessage>): ActorRef<TMessage> {
    // Force `proxy: true` regardless of what the caller passed.  Resolve to a
    // plain options object first so both builder and plain-object inputs are
    // handled uniformly (a `Partial<StartShardingOptionsType>` has no `.withProxy`).
    const resolvedOptions: Partial<StartShardingOptionsType<TMessage>> = { ...(options as Partial<StartShardingOptionsType<TMessage>>), proxy: true };
    return this.start(resolvedOptions);
  }

  /* ------------------------------- Internal -------------------------------- */

  private ensureCoordinator(options: StartShardingOptionsType<unknown>): void {
    if (this.coordinators.has(options.typeName)) return;
    const coordinatorOptions = ShardCoordinatorOptions.create()
      .withTypeName(options.typeName)
      .withCluster(this.cluster)
      .withAllocationStrategy(options.allocationStrategy ?? new HashAllocationStrategy())
      .withLocalResolver((path) =>
        this.regionsByPath.get(path)
        ?? this.coordinators.get(this.typeNameFromCoordinatorPath(path) ?? '')
        ?? null);
    if (options.role !== undefined) coordinatorOptions.withRole(options.role);
    if (options.rebalanceIntervalMs !== undefined) coordinatorOptions.withRebalanceIntervalMs(options.rebalanceIntervalMs);
    if (options.handOffTimeoutMs !== undefined) coordinatorOptions.withHandOffTimeoutMs(options.handOffTimeoutMs);
    if (options.rememberEntities !== undefined) coordinatorOptions.withRememberEntities(options.rememberEntities);
    const store = this.resolveRememberEntitiesStore(options);
    if (store !== undefined) coordinatorOptions.withRememberEntitiesStore(store);
    if (options.coordinatorStateStore !== undefined) coordinatorOptions.withCoordinatorStateStore(options.coordinatorStateStore);
    if (options.lease !== undefined) coordinatorOptions.withLease(options.lease);
    if (options.acquireRetryIntervalMs !== undefined) coordinatorOptions.withAcquireRetryIntervalMs(options.acquireRetryIntervalMs);
    const ref = this.system.spawn(
      Props.create(() => new ShardCoordinator(coordinatorOptions)),
      `sharding-coordinator-${options.typeName}`,
    );
    this.coordinators.set(options.typeName, ref as ActorRef<unknown>);
    this.regionsByPath.set(
      coordinatorPath(this.system.name, options.typeName),
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
    options: StartShardingOptionsType<unknown>,
  ): RememberEntitiesStore | undefined {
    if (!options.rememberEntities) return undefined;
    if (options.rememberEntitiesStore === null) return undefined;
    if (options.rememberEntitiesStore) return options.rememberEntitiesStore;
    const journal = this.system.extension(PersistenceExtensionId).journal;
    return new JournalRememberEntitiesStore(journal);
  }

  private typeNameFromCoordinatorPath(path: string): string | null {
    const match = path.match(/\/sharding-coordinator-([^/]+)$/);
    return match ? match[1]! : null;
  }

  private findRegionByType(typeName: string): ActorRef<unknown> | null {
    const suffix = `/user/sharding-${typeName}`;
    for (const [path, ref] of this.regionsByPath) {
      if (path.endsWith(suffix)) return ref;
    }
    return null;
  }

  private dispatchEnvelope(env: EnvelopeMessage): void {
    const ref = this.regionsByPath.get(env.to);
    if (!ref) {
      this.system.log.warn(`[sharding] no region/coordinator registered for ${env.to}`);
      return;
    }
    ref.tell(env.body as never);
  }
}

export { isShardingMessage };
