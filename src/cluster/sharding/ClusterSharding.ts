import type { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { ActorSystem } from '../../ActorSystem.js';
import { actorFactoryOf, type ActorClassOrFactory } from '../../internal/ActorConstruction.js';
import { PersistenceExtensionId } from '../../persistence/PersistenceExtension.js';
import { Props } from '../../Props.js';
import {
  SystemGroups,
  assertSpawnedAt,
  shardCoordinatorName,
  shardRegionName,
} from '../../internal/SystemPaths.js';
import type { Cluster } from '../Cluster.js';
import type { EnvelopeMessage } from '../Protocol.js';
import { HashAllocationStrategy } from './AllocationStrategy.js';
import {
  JournalRememberEntitiesStore,
  type RememberEntitiesStore,
} from './RememberEntitiesStore.js';
import { EntityRef } from './EntityRef.js';
import type { ShardMessage } from './Shard.js';
import type { ShardInfo } from './ShardInfo.js';
import {
  DEFAULT_NUM_SHARDS,
  ShardRegion,
  coordinatorPath,
} from './ShardRegion.js';
import { ShardCoordinator } from './ShardCoordinator.js';
import { ShardCoordinatorOptions } from './ShardCoordinatorOptions.js';
import {
  ShardKey,
  shardKeyOf,
  type ShardEntityClass,
  type ShardKeyedClass,
  type ShardReference,
} from './ShardKey.js';
import { StartShardingOptionsValidator } from './StartShardingOptions.js';
import type { StartShardingOptions, StartShardingOptionsType } from './StartShardingOptions.js';
import { isShardingMessage } from './ShardingProtocol.js';
import type { GetShardLocation, GetShards } from './ShardingProtocol.js';

/**
 * User-facing entry point.  Attaches to an ActorSystem + Cluster pair and
 * lets you start a sharded region for each entity type.  A `ShardCoordinator`
 * is spawned lazily on every node; only the one hosted by the current
 * cluster leader is active — the rest act as warm standbys.
 */
export class ClusterSharding {
  private readonly regionsByPath = new Map<string, ActorRef<unknown>>();
  private readonly coordinators = new Map<string, ActorRef<unknown>>();
  /** Shard count per started type — the entity→shard hash needs it. */
  private readonly numShardsByType = new Map<string, number>();

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
   * Start a sharded region for a type.  Several calling shapes:
   *
   * ```ts
   * // The entity class declares its own key, including how a command names
   * // its entity — nothing left to repeat at the call site.
   * sharding.start(UserActor);
   *
   * // Same, but the entity needs dependencies.
   * sharding.start(CartActor, () => new CartActor(deps));
   *
   * // Shorthand: pass the entity class.  Framework wraps it with Props.create.
   * sharding.start('counter', CounterEntity, {
   *   extractEntityId: (message) => message.id,
   * });
   *
   * // Shorthand: pass a factory.  Useful for closures / DI / no-arg new.
   * sharding.start('cart', () => new CartEntity(deps),
   *   StartShardingOptions.create<CartMessage>().withExtractEntityId((message) => message.entityId));
   *
   * // Full-form: explicit Props + all options via the builder.
   * sharding.start(
   *   StartShardingOptions.create<CounterMessage>()
   *     .withTypeName('counter')
   *     .withEntityProps(Props.create(() => new CounterEntity()))
   *     .withExtractEntityId((message) => message.id),
   * );
   * ```
   */
  start<TMessage>(
    entityClass: ShardEntityClass<TMessage>,
    options?: StartShardingOptions<TMessage>,
  ): ActorRef<TMessage>;
  start<TMessage>(
    entityClass: ShardKeyedClass<TMessage>,
    factory: () => Actor<TMessage>,
    options?: StartShardingOptions<TMessage>,
  ): ActorRef<TMessage>;
  start<TMessage>(
    key: ShardKey<TMessage>,
    entity: ActorClassOrFactory<TMessage>,
    options?: StartShardingOptions<TMessage>,
  ): ActorRef<TMessage>;
  start<TMessage>(options: StartShardingOptions<TMessage>): ActorRef<TMessage>;
  start<TMessage>(
    typeName: string,
    entity: ActorClassOrFactory<TMessage>,
    options?: StartShardingOptions<TMessage>,
  ): ActorRef<TMessage>;
  start<TMessage>(arg1: unknown, arg2?: unknown, arg3?: unknown): ActorRef<TMessage> {
    const options = this.resolveStartOptions<TMessage>(arg1, arg2, arg3);
    new StartShardingOptionsValidator<TMessage>().validate(options);

    this.ensureCoordinator(options as StartShardingOptionsType<unknown>);
    const existing = this.findRegionByType(options.typeName);
    if (existing) return existing as ActorRef<TMessage>;

    const config = ShardRegion.settingsToConfig(
      options,
      this.cluster,
      (path: string) => this.regionsByPath.get(path) ?? null,
    );
    this.numShardsByType.set(options.typeName, config.numShards);
    const ref = this.system._spawnSystemActor(
      // ShardRegion internally handles extra envelope types; cast to Actor<TMessage>
      // so the returned ref presents the user-facing signature.
      Props.create<TMessage>(() => new ShardRegion<TMessage>(config) as unknown as Actor<TMessage>),
      SystemGroups.clusterSharding,
      shardRegionName(options.typeName),
    );
    this.regionsByPath.set(ref.path.toString(), ref as ActorRef<unknown>);
    return ref;
  }

  /**
   * Normalize every calling shape of {@link start} into one options object.
   *
   * The runtime forms are mutually exclusive: a `ShardKey` instance, a string
   * typeName, a function (the entity class), or an object (a builder or a
   * plain options object — both read identically, since a builder *is* its
   * settings).  Each shorthand assembles a COMPLETE options object before
   * validation, so the validator sees one shape whichever door was used.
   */
  private resolveStartOptions<TMessage>(
    arg1: unknown,
    arg2: unknown,
    arg3: unknown,
  ): StartShardingOptionsType<TMessage> {
    if (typeof arg1 === 'string') {
      return this.buildOptionsFromShorthand(
        arg1,
        arg2 as ActorClassOrFactory<TMessage>,
        arg3 as StartShardingOptions<TMessage> | undefined,
      );
    }
    if (arg1 instanceof ShardKey) {
      return this.buildOptionsFromShorthand(
        arg1 as ShardKey<TMessage>,
        arg2 as ActorClassOrFactory<TMessage>,
        arg3 as StartShardingOptions<TMessage> | undefined,
      );
    }
    if (typeof arg1 === 'function') {
      const key = (arg1 as Partial<ShardKeyedClass<TMessage>>).shard;
      if (!(key instanceof ShardKey)) {
        throw new Error(
          `${(arg1 as { name?: string }).name ?? 'The entity class'} does not declare a shard key — `
          + 'add `static readonly shard = ShardKey.of<Command>(\'type-name\', (command) => command.id)`, '
          + 'or pass the typeName explicitly as the first argument',
        );
      }
      // `start(TheClass, factory, options?)` vs `start(TheClass, options?)`: only
      // the DI form puts a function in the second slot, and a zero-argument
      // class is its own factory.
      const hasFactory = typeof arg2 === 'function';
      return this.buildOptionsFromShorthand(
        key,
        (hasFactory ? arg2 : arg1) as ActorClassOrFactory<TMessage>,
        (hasFactory ? arg3 : arg2) as StartShardingOptions<TMessage> | undefined,
      );
    }
    return arg1 as StartShardingOptionsType<TMessage>;
  }

  /** @internal — wrap the shorthand entity arg into a Props + assemble full options. */
  private buildOptionsFromShorthand<TMessage>(
    type: string | ShardKey<TMessage>,
    entity: ActorClassOrFactory<TMessage>,
    options: StartShardingOptions<TMessage> | undefined,
  ): StartShardingOptionsType<TMessage> {
    const partialOptions = (options ?? {}) as Partial<StartShardingOptionsType<TMessage>>;
    const key = typeof type === 'string' ? null : type;
    return {
      // An extractor on the key is a default the declaring class supplies; an
      // explicit one in the options is the caller overriding it for this region.
      ...(key?.extractEntityId ? { extractEntityId: key.extractEntityId } : {}),
      ...partialOptions,
      typeName: key ? key.typeName : type,
      entityProps: Props.create<TMessage>(actorFactoryOf(entity)),
    } as StartShardingOptionsType<TMessage>;
  }

  /**
   * Start a proxy region — routes to the cluster but never hosts entities.
   * Takes a key (or the class declaring one) or the same builder as
   * {@link start}; `proxy` is forced on internally, so any `withProxy(...)` on
   * the passed builder is overridden.
   *
   * A proxy hosts nothing, so it needs neither entity props nor an extractor —
   * placeholders stand in for both, which is what lets the key form be a single
   * argument.
   */
  startProxy<TMessage>(
    key: ShardKey<TMessage> | ShardKeyedClass<TMessage>,
  ): ActorRef<TMessage>;
  startProxy<TMessage>(options: StartShardingOptions<TMessage>): ActorRef<TMessage>;
  startProxy<TMessage>(
    arg: ShardKey<TMessage> | ShardKeyedClass<TMessage> | StartShardingOptions<TMessage>,
  ): ActorRef<TMessage> {
    const fromKey = arg instanceof ShardKey || typeof (arg as ShardKeyedClass<TMessage>).shard === 'object';
    const base: Partial<StartShardingOptionsType<TMessage>> = fromKey
      ? this.proxyOptionsFor(shardKeyOf(arg as ShardKey<TMessage> | ShardKeyedClass<TMessage>))
      : (arg as Partial<StartShardingOptionsType<TMessage>>);
    // Force `proxy: true` regardless of what the caller passed.  Resolve to a
    // plain options object first so both builder and plain-object inputs are
    // handled uniformly (a `Partial<StartShardingOptionsType>` has no `.withProxy`).
    return this.start({ ...base, proxy: true });
  }

  /** Placeholder region options for a node that routes but never hosts. */
  private proxyOptionsFor<TMessage>(key: ShardKey<TMessage>): Partial<StartShardingOptionsType<TMessage>> {
    return {
      typeName: key.typeName,
      entityProps: Props.create<TMessage>(() => {
        throw new Error(`shard '${key.typeName}' is a proxy region on this node and never hosts entities`);
      }),
      extractEntityId: key.extractEntityId ?? ((): string => {
        throw new Error(
          `shard '${key.typeName}' is a proxy region started from a key with no extractEntityId — `
          + 'address entities through `entityRefFor(key, id)` rather than telling the region directly',
        );
      }),
    };
  }

  /**
   * A handle to one entity, addressed by id.  Location-transparent: the
   * entity may live on this node or any other, and it may move between them —
   * the handle keeps working, because it routes through the local region
   * exactly like a normal message does.
   *
   * ```ts
   * const entity = cluster.sharding.entityRefFor<Command>('counter', 'user-42');
   * entity.tell({ kind: 'increment', by: 1 });     // no id inside the message
   * const value = await entity.ask<number>({ kind: 'get' });
   * ```
   *
   * Synchronous by design — the shard id is `hash(entityId) % numShards`, so
   * nothing has to be looked up, and a message for a shard whose home is not
   * known yet is buffered by the region just as it always was.
   *
   * Unlike the region ref, messages sent through the handle do **not** go
   * through `extractEntityId`: the envelope names its entity, so the message
   * type no longer has to carry a routing key of its own.
   *
   * @throws if no region for `typeName` has been started on this node — a
   *   proxy region (`startProxy`) is enough.
   */
  entityRefFor<TMessage>(
    key: ShardKey<TMessage> | ShardKeyedClass<TMessage>,
    entityId: string,
  ): ActorRef<TMessage>;
  entityRefFor<TMessage>(typeName: string, entityId: string): ActorRef<TMessage>;
  entityRefFor<TMessage>(reference: ShardReference<TMessage>, entityId: string): ActorRef<TMessage> {
    const { typeName } = shardKeyOf(reference);
    const region = this.regionOrThrow(typeName);
    return new EntityRef<TMessage>(
      region,
      typeName,
      entityId,
      this.numShardsByType.get(typeName) ?? DEFAULT_NUM_SHARDS,
      this.system.name,
    );
  }

  /**
   * Every shard of `typeName` that currently has a home, cluster-wide —
   * where it lives, how many entities it is holding, and a live ref to it
   * (#151).
   *
   * ```ts
   * for (const shard of await cluster.sharding.shards<Command>('counter')) {
   *   console.log(shard.shardId, `${shard.node}`, shard.entityCount);
   * }
   * ```
   *
   * The coordinator owns the shard map but not the entity counts — only the
   * region hosting a shard knows those — so this costs one fan-out to the
   * registered regions.  A region that does not answer in time contributes
   * `entityCount: 0` rather than failing the whole call; the result is a
   * snapshot, not a subscription (for a live feed, subscribe to
   * `ShardMapChanged`).
   *
   * Shards with no home yet are absent: nothing has asked for them, so the
   * coordinator has had no reason to allocate them.  Use
   * {@link shardRefFor} to place one on purpose.
   *
   * @throws if no region for `typeName` has been started on this node, or if
   *   the coordinator does not answer within `timeoutMs` (`AskTimeoutError`) —
   *   which is what a leader election in flight looks like from here.
   */
  async shards<TMessage = unknown>(
    typeName: string,
    timeoutMs = 5_000,
  ): Promise<ReadonlyArray<ShardInfo<TMessage>>> {
    const region = this.regionOrThrow(typeName);
    // Leave the coordinator's fan-out a shorter fuse than our own ask, so a
    // slow region degrades into a partial answer instead of no answer at all.
    const fanOutTimeoutMs = Math.max(250, Math.floor(timeoutMs * 0.6));
    const query: GetShards = { $t: 'sharding.GetShards', timeoutMs: fanOutTimeoutMs };
    return await region.ask<ReadonlyArray<ShardInfo<TMessage>>>(query as never, timeoutMs);
  }

  /**
   * A ref to one shard.  Allocates the shard if it has no home yet — the same
   * thing a first message for it would have done.
   *
   * The ref is the real thing: the local shard actor when this node hosts it,
   * a `RemoteActorRef` at `/system/cluster/sharding/region-<type>/shard-<n>`
   * otherwise.  `tell`
   * therefore works from anywhere.  `ask` only works when the shard is local,
   * because a one-shot ask ref is not addressable from another node — to query
   * a remote shard, send `GetShardStats` with your own actor's `self` as
   * `replyTo`, or use {@link shards} for the cluster-wide picture.
   *
   * @throws if no region for `typeName` has been started on this node, or if
   *   the shard cannot be placed within `timeoutMs` (`AskTimeoutError`).
   */
  async shardRefFor<TMessage = unknown>(
    typeName: string,
    shardId: number,
    timeoutMs = 5_000,
  ): Promise<ActorRef<ShardMessage<TMessage>>> {
    const region = this.regionOrThrow(typeName);
    const query: GetShardLocation = { $t: 'sharding.GetShardLocation', shardId };
    return await region.ask<ActorRef<ShardMessage<TMessage>>>(query as never, timeoutMs);
  }

  private regionOrThrow(typeName: string): ActorRef<unknown> {
    const region = this.findRegionByType(typeName);
    if (!region) {
      throw new Error(
        `[sharding] no region for type '${typeName}' on this node — `
        + `call sharding.start(...) or sharding.startProxy(...) first`,
      );
    }
    return region;
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
    const ref = this.system._spawnSystemActor(
      Props.create(() => new ShardCoordinator(coordinatorOptions)),
      SystemGroups.clusterSharding,
      shardCoordinatorName(options.typeName),
    );
    this.coordinators.set(options.typeName, ref as ActorRef<unknown>);
    const wellKnownPath = coordinatorPath(this.system.name, options.typeName);
    // The registry is keyed on the well-known path, so a drift between it and
    // the spawn location would silently route past this handler.
    assertSpawnedAt(wellKnownPath, ref);
    this.regionsByPath.set(wellKnownPath, ref as ActorRef<unknown>);
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

  /**
   * Recover a typeName from a coordinator path — the inverse of
   * `coordinatorPath`, used by the local resolver to answer for a coordinator
   * this node hosts.  Anchored on the group segment so a region path
   * (`.../sharding/region-cart`) cannot match.
   */
  private typeNameFromCoordinatorPath(path: string): string | null {
    const match = path.match(/\/sharding\/coordinator-([^/]+)$/);
    return match ? match[1]! : null;
  }

  private findRegionByType(typeName: string): ActorRef<unknown> | null {
    const suffix = `/${SystemGroups.clusterSharding}/${shardRegionName(typeName)}`;
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
