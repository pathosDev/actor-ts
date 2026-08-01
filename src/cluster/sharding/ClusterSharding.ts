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
   * Start a sharded region for a type.  Three calling shapes:
   *
   * ```ts
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
  start<TMessage>(options: StartShardingOptions<TMessage>): ActorRef<TMessage>;
  start<TMessage>(
    typeName: string,
    entity: ActorClassOrFactory<TMessage>,
    options?: StartShardingOptions<TMessage>,
  ): ActorRef<TMessage>;
  start<TMessage>(
    arg1: string | StartShardingOptions<TMessage>,
    arg2?: ActorClassOrFactory<TMessage>,
    arg3?: StartShardingOptions<TMessage>,
  ): ActorRef<TMessage> {
    const options = typeof arg1 === 'string'
      ? this.buildOptionsFromShorthand(arg1, arg2!, arg3 ?? {})
      : arg1 as StartShardingOptionsType<TMessage>;
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

  /** @internal — wrap the shorthand entity arg into a Props + assemble full options. */
  private buildOptionsFromShorthand<TMessage>(
    typeName: string,
    entity: ActorClassOrFactory<TMessage>,
    options: StartShardingOptions<TMessage>,
  ): StartShardingOptionsType<TMessage> {
    const partialOptions = (options as Partial<StartShardingOptionsType<TMessage>>);
    return {
      ...partialOptions,
      typeName,
      entityProps: Props.create<TMessage>(actorFactoryOf(entity)),
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
  entityRefFor<TMessage>(typeName: string, entityId: string): ActorRef<TMessage> {
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
