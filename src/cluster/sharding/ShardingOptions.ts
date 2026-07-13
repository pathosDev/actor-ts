import type { Props } from '../../Props.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

/**
 * Plain options-object shape for a sharded region.  Consumed by
 * {@link ShardRegion.settingsToConfig} and extended by
 * {@link StartShardingOptionsType} — the coordinator-side superset that
 * {@link ClusterSharding.start} accepts.
 */
export interface ShardingOptionsType<TMessage> {
  readonly typeName: string;
  readonly entityProps: Props<TMessage>;
  readonly extractEntityId: (message: TMessage) => string;
  readonly extractEntityMessage?: (message: TMessage) => unknown;
  readonly numShards?: number;
  /** Members must carry this role to be candidates for hosting shards. */
  readonly role?: string;
  /** Run as a proxy — route messages but never host entities locally. */
  readonly proxy?: boolean;
  /** Track entity lifecycle so entities can be re-created on the new owner. */
  readonly rememberEntities?: boolean;
  /** Notify the region after an entity has been idle this many ms.  */
  readonly passivationIdleMs?: number;
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
}

/**
 * Fluent builder for {@link ShardingOptionsType}.  Base of the builder
 * inheritance chain: {@link StartShardingOptionsBuilder} (in
 * `StartShardingOptions`) extends this and adds the coordinator-side
 * fields.  Each concrete `withX` records exactly one field so unset
 * fields fall through to HOCON / built-in defaults when the options are
 * normalised by {@link ShardRegion.settingsToConfig}.
 *
 * The whole-object fields — `entityProps` (a {@link Props}), and the
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

  /** Props used to spawn each entity instance. */
  withEntityProps(entityProps: Props<TMessage>): this {
    return this.set('entityProps', entityProps);
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

  /** Notify the region after an entity has been idle this many ms. */
  withPassivationIdleMs(passivationIdleMs: number): this {
    return this.set('passivationIdleMs', passivationIdleMs);
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
  TMsg,
  S extends ShardingOptionsType<TMsg> = ShardingOptionsType<TMsg>,
> extends OptionsValidator<S> {
  constructor(optionsName = 'ShardingOptions') {
    super(optionsName);
  }
  protected rules(s: Partial<S>): void {
    this.commonRules(s);
  }
  protected commonRules(s: Partial<S>): void {
    const c = s as Partial<ShardingOptionsType<TMsg>>;
    if (c.typeName !== undefined && (typeof c.typeName !== 'string' || c.typeName.length === 0)) {
      this.fail('typeName', 'must be a non-empty string', c.typeName);
    }
    if (c.numShards !== undefined && (!Number.isInteger(c.numShards) || c.numShards < 1)) {
      this.fail('numShards', 'must be an integer >= 1', c.numShards);
    }
    if (
      c.passivationIdleMs !== undefined &&
      (typeof c.passivationIdleMs !== 'number' || !Number.isFinite(c.passivationIdleMs) || c.passivationIdleMs < 0)
    ) {
      this.fail('passivationIdleMs', 'must be a non-negative finite number', c.passivationIdleMs);
    }
    if (c.maxEntities !== undefined && (!Number.isInteger(c.maxEntities) || c.maxEntities < 0)) {
      this.fail('maxEntities', 'must be an integer >= 0', c.maxEntities);
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
