import type { Props } from '../../Props.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { ShardingSettings } from './ShardRegion.js';

/**
 * Fluent builder for {@link ShardingSettings}.  Base of the builder
 * inheritance chain: {@link StartShardingOptions} (in `ClusterSharding`)
 * extends this and adds the coordinator-side fields.  Each concrete
 * `withX` records exactly one field so unset fields fall through to
 * HOCON / built-in defaults when the settings are normalised by
 * {@link ShardRegion.settingsToConfig}.
 *
 * The whole-object fields — `entityProps` (a {@link Props}), and the
 * `extractEntityId` / `extractEntityMessage` extractors — are passed
 * as-is via a single `withX(value)`; no nested builders.
 */
export class ShardingOptions<
  TMsg,
  S extends ShardingSettings<TMsg> = ShardingSettings<TMsg>,
> extends OptionsBuilder<S> {
  /** Start a fresh builder.  Equivalent to `new ShardingOptions<TMsg>()`. */
  static create<TMsg>(): ShardingOptions<TMsg> {
    return new ShardingOptions<TMsg>();
  }

  /** Logical name of the sharded type. */
  withTypeName(typeName: string): this {
    return this.set('typeName', typeName);
  }

  /** Props used to spawn each entity instance. */
  withEntityProps(entityProps: Props<TMsg>): this {
    return this.set('entityProps', entityProps);
  }

  /** Derive the stable entity id from an incoming message. */
  withExtractEntityId(extractEntityId: (message: TMsg) => string): this {
    return this.set('extractEntityId', extractEntityId);
  }

  /** Unwrap the payload actually delivered to the entity.  Default: identity. */
  withExtractEntityMessage(extractEntityMessage: (message: TMsg) => unknown): this {
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
