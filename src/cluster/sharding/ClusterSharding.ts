import { match, P } from 'ts-pattern';
import type { Actor, ActorClassOrFactory } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { ActorSystem } from '../../ActorSystem.js';
import { actorFactoryOf } from '../../internal/ActorBlueprint.js';
import { PersistenceExtensionId } from '../../persistence/PersistenceExtension.js';
import { mergeOptions } from '../../util/OptionsMerge.js';
import {
  SystemGroups,
  assertSpawnedAt,
  shardCoordinatorName,
  shardRegionName,
} from '../../internal/SystemPaths.js';
import type { Cluster } from '../Cluster.js';
import { ShardMapChanged, type ClusterEvent } from '../ClusterEvents.js';
import type { EnvelopeMessage } from '../Protocol.js';
import { HashAllocationStrategy } from './AllocationStrategy.js';
import {
  JournalRememberEntitiesStore,
  type RememberEntitiesStore,
} from './RememberEntitiesStore.js';
import { EntityRef } from './EntityRef.js';
import type { ShardMessage } from './Shard.js';
import type { ShardInfo } from './ShardInfo.js';
import { shardMapViewOf, type ShardMapView } from './ShardMapView.js';
import { DEFAULT_NUM_SHARDS } from './ShardingOptions.js';
import {
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
import { StartShardingOptionsValidator, readShardingOptionsFromConfig } from './StartShardingOptions.js';
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
  /**
   * Type name → region path.  `regionsByPath` is a dispatch registry keyed on
   * the exact path and holds coordinators as well as regions, so resolving a
   * region by type used to mean suffix-matching every entry in it — O(n) in
   * the number of started types, on a path `start` takes for every message
   * send through {@link entityRefFor}.
   *
   * Deliberately a plain `Map` and not a `BidirectionalMap`: nothing here
   * needs to go from a region path back to a type name, and an index nobody
   * reads is one more thing to keep in step.  (The coordinator side does need
   * that direction, but it parses the path rather than looking it up, which
   * also answers for coordinators this node never registered.)
   */
  private readonly regionPathsByType = new Map<string, string>();
  private readonly coordinators = new Map<string, ActorRef<unknown>>();
  /** Shard count per started type — the entity→shard hash needs it. */
  private readonly numShardsByType = new Map<string, number>();
  /** Whether the region started for a type is a proxy — see {@link start}. */
  private readonly proxyByType = new Map<string, boolean>();
  /**
   * Type name → the last shard map this node was told about.  Read by
   * {@link shardMap}, fed by the `ShardMapChanged` subscription below.
   *
   * Kept here rather than derived on demand because the map has no local
   * owner to ask: the coordinator holds it, runs only on the leader, and
   * answers over the wire.  Every node's region already receives the
   * broadcast and republishes it, so remembering the last one costs one
   * assignment per publish and turns a round trip into a field read (#682).
   */
  private readonly shardMapsByType = new Map<string, ShardMapView>();

  private constructor(
    public readonly system: ActorSystem,
    public readonly cluster: Cluster,
  ) {
    cluster._setEnvelopeHandler((env: EnvelopeMessage) => this.dispatchEnvelope(env));
    // Subscribed here, not on the first `start`, so no publish can slip past
    // between construction and the first region: a type started later still
    // sees its own first broadcast.  `snapshot` replay because this listener
    // discards membership anyway — one event to ignore instead of N.  Never
    // unsubscribed: the instance is memoised per ActorSystem and both it and
    // the listener die with the Cluster that holds them.
    cluster.subscribe((event) => this.onClusterEvent(event), { replayMode: 'snapshot' });
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
   * // Shorthand: pass the entity class by name.
   * sharding.start('counter', CounterEntity, {
   *   extractEntityId: (message) => message.id,
   * });
   *
   * // Shorthand: pass a factory.  Useful for closures / DI / no-arg new.
   * sharding.start('cart', () => new CartEntity(deps),
   *   StartShardingOptions.create<CartMessage>().withExtractEntityId((message) => message.entityId));
   *
   * // Full-form: every option via the builder.
   * sharding.start(
   *   StartShardingOptions.create<CounterMessage>()
   *     .withTypeName('counter')
   *     .withEntityActor(CounterEntity)
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
    const options = this.withConfigDefaults(this.resolveStartOptions<TMessage>(arg1, arg2, arg3));
    new StartShardingOptionsValidator<TMessage>().validate(options);

    // Resolve the config BEFORE anything reads a shard count.  This used to
    // sit below `ensureCoordinator`, which read `numShardsByType` — a map
    // `start` does not populate until the line after this one, so on the
    // first (and only) start of a type the lookup always missed and every
    // coordinator was built with `DEFAULT_NUM_SHARDS` whatever the caller
    // configured (#1026).  The region hashed with the real value while the
    // coordinator bounded with 64, so every `GetShardHome` for a shard id at
    // or above 64 was refused and its messages piled up in the region's
    // unbounded buffer.  `settingsToConfig` is pure, so hoisting it is safe;
    // the count now travels as an argument and no longer depends on which
    // statement ran first.
    const config = ShardRegion.settingsToConfig(
      options,
      this.cluster,
      (path: string) => this.regionsByPath.get(path) ?? null,
    );

    this.ensureCoordinator(options as StartShardingOptionsType<unknown>, config.numShards);
    const existing = this.findRegionByType(options.typeName);
    if (existing) {
      // A second call for a type this node already started is a no-op — except
      // when the two disagree about hosting.  `startProxy` then `start` handed
      // the caller the *proxy* back, and a proxy throws from its placeholder
      // entity factory, so the first message for a local shard died in a spawn
      // the caller never wrote.  The reverse order is just as wrong: the caller
      // asked for a routing-only node and got one that hosts entities.
      const existingProxy = this.proxyByType.get(options.typeName) ?? false;
      const requestedProxy = options.proxy ?? false;
      if (existingProxy !== requestedProxy) {
        throw new Error(
          `[sharding] type '${options.typeName}' is already started on this node as `
          + `${existingProxy ? 'a proxy region' : 'a hosting region'} — `
          + `${requestedProxy ? 'startProxy()' : 'start()'} cannot change that. `
          + `Start each type once per node, as either a hosting region or a proxy.`,
        );
      }
      return existing as ActorRef<TMessage>;
    }

    this.numShardsByType.set(options.typeName, config.numShards);
    this.proxyByType.set(options.typeName, config.proxy);
    const ref = this.system._spawnSystemActor<TMessage>(
      // ShardRegion internally handles extra envelope types; cast to Actor<TMessage>
      // so the returned ref presents the user-facing signature.
      () => new ShardRegion<TMessage>(config) as unknown as Actor<TMessage>,
      SystemGroups.clusterSharding,
      shardRegionName(options.typeName),
    );
    const regionPath = ref.path.toString();
    this.regionsByPath.set(regionPath, ref as ActorRef<unknown>);
    // Regions only — a coordinator also lands in `regionsByPath` (see
    // `ensureCoordinator`), and letting one in here would make
    // `findRegionByType` hand back a coordinator ref.
    this.regionPathsByType.set(options.typeName, regionPath);
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

  /**
   * Layer the `actor-ts.sharding.*` block under the caller's options, giving
   * a sharded type the precedence the rest of the framework documents:
   * **explicit options > HOCON > built-in defaults**.
   *
   * It happens here, and not in `ShardRegion`, because `start` is the only
   * point that feeds *both* the region and — through {@link ensureCoordinator}
   * — its coordinator; `rebalance-interval` and `hand-off-timeout` never
   * reach the region at all.  Running before the validator is what lets a
   * cross-field rule see the values the node will actually run with.
   *
   * The defaults layer is empty on purpose: the built-in fallbacks already
   * live at their point of use (`settingsToConfig`'s `??` chain, the
   * coordinator's own defaults), and duplicating them here would give the
   * project two places to disagree about what `64` means.
   */
  private withConfigDefaults<TMessage>(
    options: StartShardingOptionsType<TMessage>,
  ): StartShardingOptionsType<TMessage> {
    return mergeOptions<StartShardingOptionsType<TMessage>>(
      {},
      readShardingOptionsFromConfig(this.system.config),
      options,
    );
  }

  /** @internal — normalize the shorthand entity arg + assemble full options. */
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
      entityActor: actorFactoryOf(entity),
    } as StartShardingOptionsType<TMessage>;
  }

  /**
   * Start a proxy region — routes to the cluster but never hosts entities.
   * Takes a key (or the class declaring one) or the same builder as
   * {@link start}; `proxy` is forced on internally, so any `withProxy(...)` on
   * the passed builder is overridden.
   *
   * A proxy hosts nothing, so it needs neither an entity actor nor an extractor
   * — placeholders stand in for both, which is what lets the key form be a
   * single argument.
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
      entityActor: (): never => {
        throw new Error(`shard '${key.typeName}' is a proxy region on this node and never hosts entities`);
      },
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
    const query: GetShards = { kind: 'sharding.GetShards', timeoutMs: fanOutTimeoutMs };
    return await region.ask<ReadonlyArray<ShardInfo<TMessage>>>(query as never, timeoutMs);
  }

  /**
   * The last shard map this node was told about, as plain JSON — the
   * serialisable counterpart to {@link shards} (#682).
   *
   * ```ts
   * const map = cluster.sharding.shardMap('counter');
   * if (map) console.log(map.regions.length, map.shardHome.length);
   * ```
   *
   * Synchronous and free: the coordinator broadcasts the map to every
   * registered region on each change, each region republishes it as a local
   * `ShardMapChanged`, and this returns the last one. So it needs no round
   * trip, no DistributedData and no `coordinatorStateStore` — which is what
   * the `/cluster/shards` management endpoint reads it for.
   *
   * `null` until the coordinator has published once for the type, which
   * includes every case where this node has started neither a region nor a
   * proxy for it: nothing broadcasts to a node that never registered. Use
   * {@link shards} when you need entity counts or live refs, and subscribe to
   * `ShardMapChanged` when you need the changes rather than the latest state.
   *
   * `shardHome` is empty until a shard has been placed — nothing asks the
   * coordinator to allocate one before an entity is addressed — while
   * `regions` is populated from the first registration. Read `regions` to
   * answer "who is participating", `shardHome` to answer "what is placed".
   */
  shardMap(typeName: string): ShardMapView | null {
    return this.shardMapsByType.get(typeName) ?? null;
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
    const query: GetShardLocation = { kind: 'sharding.GetShardLocation', shardId };
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

  /**
   * The cluster event stream, of which exactly one event is ours.  Membership
   * belongs to whoever else subscribed; sharding only reacts to the shard map
   * its own regions republish.
   */
  private onClusterEvent(event: ClusterEvent): void {
    match(event)
      .with(P.instanceOf(ShardMapChanged), (e) => this.onShardMapChanged(e))
      .otherwise(() => this.onOtherClusterEvent());
  }

  /**
   * Stamped with the receiving node's clock and its own view of the leader,
   * because that is what this node can honestly claim: the event carries
   * neither, and the coordinator that produced it publishes only while it is
   * the active one, so the leader at arrival time is the map's author.
   */
  private onShardMapChanged(event: ShardMapChanged): void {
    const leader = this.cluster.leader().fold(() => '', (member) => member.address.toString());
    this.shardMapsByType.set(event.type, shardMapViewOf(event, leader, Date.now()));
  }

  /**
   * Membership, leadership, a replayed snapshot.  All of them can move the
   * shard map, and none of them says how — the coordinator recomputes and
   * publishes `ShardMapChanged`, which is the only event that can.
   */
  private onOtherClusterEvent(): void {}

  /**
   * @param numShards Resolved by the caller from the same options the region
   *   is built with.  Passed rather than looked up: reading it back out of
   *   `numShardsByType` made the result depend on whether `start` had reached
   *   the line that populates that map, and on the first start of a type it
   *   had not (#1026).
   */
  private ensureCoordinator(options: StartShardingOptionsType<unknown>, numShards: number): void {
    if (this.coordinators.has(options.typeName)) return;
    const coordinatorOptions = ShardCoordinatorOptions.create()
      .withTypeName(options.typeName)
      .withCluster(this.cluster)
      .withAllocationStrategy(options.allocationStrategy ?? new HashAllocationStrategy())
      .withNumShards(numShards)
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
      () => new ShardCoordinator(coordinatorOptions),
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
    const path = this.regionPathsByType.get(typeName);
    return path === undefined ? null : this.regionsByPath.get(path) ?? null;
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
