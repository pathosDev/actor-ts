import type { ActorClassOrFactory } from '../../Actor.js';
import type { ActorOptions } from '../../ActorOptions.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

/**
 * Plain options-object shape for a sharded region.  Consumed by
 * {@link ShardRegion.settingsToConfig} and extended by
 * {@link StartShardingOptionsType} — the coordinator-side superset that
 * {@link ClusterSharding.start} accepts.
 */
export type ShardingOptionsType<TMessage> = {
  readonly typeName: string;
  /**
   * The entity actor — its class, or a factory when it needs dependencies.
   * Distinct from {@link ActorOptionsType.entity}, which is the *identity*
   * `ClusterSharding` stamps onto each entity it spawns.
   */
  readonly entityActor: ActorClassOrFactory<TMessage>;
  /** Spawn options applied to every entity of this type. */
  readonly entityOptions?: ActorOptions<TMessage>;
  readonly extractEntityId: (message: TMessage) => string;
  readonly extractEntityMessage?: (message: TMessage) => unknown;
  readonly numShards?: number;
  /** Members must carry this role to be candidates for hosting shards. */
  readonly role?: string;
  /** Run as a proxy — route messages but never host entities locally. */
  readonly proxy?: boolean;
  /** Track entity lifecycle so entities can be re-created on the new owner. */
  readonly rememberEntities?: boolean;
  /**
   * Passivate an entity after it has been idle this many ms.
   *
   * Default: 5 minutes (`passivation-idle` in `reference.conf`).  `0`
   * disables the sweep and keeps every entity resident until something
   * else stops it.
   *
   * Two consequences worth knowing before turning it down or off.  An
   * entity that holds state in memory and does not rebuild it in
   * `preStart` loses that state when it passivates — persistent entities
   * recover, plain ones do not.  And under `rememberEntities` a
   * passivation is a *forget*: the region relays `EntityStopped` to the
   * coordinator, which drops the entity from the registry, so it is no
   * longer among those revived after a node failure.
   */
  readonly passivationIdleMs?: number;
  /**
   * Stop a shard once it has stood empty this many ms — the shard-level
   * counterpart to {@link passivationIdleMs} (#892).
   *
   * A shard actor appears when the coordinator allocates the shard to this
   * node and, without this, is only ever stopped again by a handoff.  So once
   * its last entity passivates it stays resident holding an empty map; and
   * since entity ids spread over the hash space, a long-running node ends up
   * with one such shard per `numShards`.
   *
   * Unset, it follows `passivationIdleMs`: a shard stands empty precisely
   * because its entities went idle, so the same window applies one level up.
   * Set it to decouple the two — a larger value trades memory for fewer
   * re-creations, `0` keeps empty shards resident while entities still
   * passivate.
   *
   * Only an *empty* shard is ever stopped, and the region keeps ownership, so
   * the next message re-creates it transparently.
   */
  readonly shardPassivationIdleMs?: number;
  /**
   * Cap the number of locally-hosted entities (#82).  When the region
   * is about to spawn a new entity and the existing count is already
   * `maxEntities`, the entity with the oldest `lastActivity` is
   * passivated — same code path users invoke manually via
   * {@link Passivate}.  Useful for unbounded entity sets (per-user
   * sessions, IoT devices, …) where a memory cap per node matters
   * more than keeping every cold entity resident.
   *
   * Default: `0` (no cap).  Eviction runs only when `> 0`.
   *
   * Note: passivation is asynchronous, so during the brief window
   * between "stop the LRU" and "Terminated arrives" the region may
   * hold `maxEntities + 1` entities; the cap is a steady-state
   * upper bound rather than a strict instantaneous one.
   */
  readonly maxEntities?: number;
};

/**
 * Fluent builder for {@link ShardingOptionsType}.  Base of the builder
 * inheritance chain: {@link StartShardingOptionsBuilder} (in
 * `StartShardingOptions`) extends this and adds the coordinator-side
 * fields.  Each concrete `withX` records exactly one field so unset
 * fields fall through to HOCON / built-in defaults when the options are
 * normalised by {@link ShardRegion.settingsToConfig}.
 *
 * The whole-object fields — `entityActor`, `entityOptions`, and the
 * `extractEntityId` / `extractEntityMessage` extractors — are passed
 * as-is via a single `withX(value)`; no nested builders.
 */
export class ShardingOptionsBuilder<
  TMessage,
  S extends ShardingOptionsType<TMessage> = ShardingOptionsType<TMessage>,
> extends OptionsBuilder<S> {
  /** Start a fresh builder.  Equivalent to `new ShardingOptionsBuilder<TMessage>()`. */
  static create<TMessage>(): ShardingOptionsBuilder<TMessage> {
    return new ShardingOptionsBuilder<TMessage>();
  }

  /** Logical name of the sharded type. */
  withTypeName(typeName: string): this {
    return this.set('typeName', typeName);
  }

  /** The actor each entity instance is built from. */
  withEntityActor(entityActor: ActorClassOrFactory<TMessage>): this {
    return this.set('entityActor', entityActor);
  }

  /** Spawn options applied to every entity of this type. */
  withEntityOptions(entityOptions: ActorOptions<TMessage>): this {
    return this.set('entityOptions', entityOptions);
  }

  /** Derive the stable entity id from an incoming message. */
  withExtractEntityId(extractEntityId: (message: TMessage) => string): this {
    return this.set('extractEntityId', extractEntityId);
  }

  /** Unwrap the payload actually delivered to the entity.  Default: identity. */
  withExtractEntityMessage(extractEntityMessage: (message: TMessage) => unknown): this {
    return this.set('extractEntityMessage', extractEntityMessage);
  }

  /** Number of shards to spread entities across.  Default: 64. */
  withNumShards(numShards: number): this {
    return this.set('numShards', numShards);
  }

  /** Members must carry this role to be candidates for hosting shards. */
  withRole(role: string): this {
    return this.set('role', role);
  }

  /** Run as a proxy — route messages but never host entities locally. */
  withProxy(proxy = true): this {
    return this.set('proxy', proxy);
  }

  /** Track entity lifecycle so entities can be re-created on the new owner. */
  withRememberEntities(rememberEntities = true): this {
    return this.set('rememberEntities', rememberEntities);
  }

  /** Passivate an entity after it has been idle this many ms.  Default: 5 min; `0` disables. */
  withPassivationIdleMs(passivationIdleMs: number): this {
    return this.set('passivationIdleMs', passivationIdleMs);
  }

  /** Stop a shard once it has stood empty this many ms.  Default: follows `passivationIdleMs`. */
  withShardPassivationIdleMs(shardPassivationIdleMs: number): this {
    return this.set('shardPassivationIdleMs', shardPassivationIdleMs);
  }

  /** Cap the number of locally-hosted entities; LRU-passivate on overflow.  Default: 0 (no cap). */
  withMaxEntities(maxEntities: number): this {
    return this.set('maxEntities', maxEntities);
  }
}

/**
 * Validates resolved sharding settings.  Generic so
 * {@link StartShardingOptionsValidator} can extend it via {@link commonRules};
 * only present values are checked (unset fields fall through to defaults).
 */
export class ShardingOptionsValidator<
  TMessage,
  S extends ShardingOptionsType<TMessage> = ShardingOptionsType<TMessage>,
> extends OptionsValidator<S> {
  constructor(optionsName = 'ShardingOptions') {
    super(optionsName);
  }
  protected rules(s: Partial<S>): void {
    this.commonRules(s);
  }
  protected commonRules(s: Partial<S>): void {
    const options = s as Partial<ShardingOptionsType<TMessage>>;
    // Required-ness is asserted here rather than through the check helpers,
    // which pass on `undefined` by design.  Without these, a region missing
    // its entity or its extractor validates cleanly and then fails deep inside
    // `settingsToConfig` or on the first message, far from the call that was
    // actually wrong.  A proxy region is exempt: it hosts nothing, so it needs
    // neither.
    if (options.typeName === undefined) this.fail('typeName', 'is required');
    if (!options.proxy) {
      if (options.entityActor === undefined) this.fail('entityActor', 'is required');
      if (options.extractEntityId === undefined) this.fail('extractEntityId', 'is required');
    }
    if (options.typeName !== undefined && (typeof options.typeName !== 'string' || options.typeName.length === 0)) {
      this.fail('typeName', 'must be a non-empty string', options.typeName);
    }
    if (options.numShards !== undefined && (!Number.isInteger(options.numShards) || options.numShards < 1)) {
      this.fail('numShards', 'must be an integer >= 1', options.numShards);
    }
    if (
      options.passivationIdleMs !== undefined &&
      (typeof options.passivationIdleMs !== 'number' || !Number.isFinite(options.passivationIdleMs) || options.passivationIdleMs < 0)
    ) {
      this.fail('passivationIdleMs', 'must be a non-negative finite number', options.passivationIdleMs);
    }
    if (
      options.shardPassivationIdleMs !== undefined &&
      (typeof options.shardPassivationIdleMs !== 'number' || !Number.isFinite(options.shardPassivationIdleMs) || options.shardPassivationIdleMs < 0)
    ) {
      this.fail('shardPassivationIdleMs', 'must be a non-negative finite number', options.shardPassivationIdleMs);
    }
    if (options.maxEntities !== undefined && (!Number.isInteger(options.maxEntities) || options.maxEntities < 0)) {
      this.fail('maxEntities', 'must be an integer >= 0', options.maxEntities);
    }
  }
}

/**
 * Accepted input for a sharded-region-configurable API: the fluent
 * {@link ShardingOptionsBuilder} OR a plain {@link ShardingOptionsType} object.
 */
export type ShardingOptions<
  TMessage,
  S extends ShardingOptionsType<TMessage> = ShardingOptionsType<TMessage>,
> = ShardingOptionsBuilder<TMessage, S> | S;
/** Value alias so `ShardingOptions.create()` / `new ShardingOptions()` resolve to the builder. */
export const ShardingOptions = ShardingOptionsBuilder;
