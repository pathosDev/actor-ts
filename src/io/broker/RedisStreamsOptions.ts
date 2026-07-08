/**
 * Fluent builder for {@link RedisStreamsOptionsType}.  Protocol-
 * specific methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.redisStreams` > built-in defaults).
 */
import { BrokerOptionsBuilder } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';
import type { ActorRef } from '../../ActorRef.js';
import type { RedisStreamEntry } from './RedisStreamsActor.js';

export interface RedisStreamsOptionsType extends BrokerCommonOptionsType {
  /** Redis URL (`'redis://host:6379'`). */
  readonly url?: string;
  /** Streams to consume. */
  readonly streams?: ReadonlyArray<string>;
  /** Consumer-group options — required to consume.  When omitted only producing works. */
  readonly consumerGroup?: {
    readonly group: string;
    readonly consumer: string;
    /** Auto-create the group if missing.  Default: true. */
    readonly createIfMissing?: boolean;
  };
  /** Block timeout per XREADGROUP call in ms.  Default: 5_000. */
  readonly blockMs?: number;
  /** Subscriber for inbound entries.  Required to consume. */
  readonly target?: ActorRef<RedisStreamEntry>;
}

export class RedisStreamsOptionsBuilder extends BrokerOptionsBuilder<RedisStreamsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RedisStreamsOptionsBuilder()`. */
  static create(): RedisStreamsOptionsBuilder {
    return new RedisStreamsOptionsBuilder();
  }

  /** Redis URL (`'redis://host:6379'`). */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Streams to consume. */
  withStreams(streams: ReadonlyArray<string>): this {
    return this.set('streams', streams);
  }

  /** Consumer-group options — required to consume. */
  withConsumerGroup(group: NonNullable<RedisStreamsOptionsType['consumerGroup']>): this {
    return this.set('consumerGroup', group);
  }

  /** Block timeout per XREADGROUP call in ms.  Default 5000. */
  withBlockMs(ms: number): this {
    return this.set('blockMs', ms);
  }

  /** Subscriber for inbound entries.  Required to consume. */
  withTarget(target: ActorRef<RedisStreamEntry>): this {
    return this.set('target', target);
  }
}

/**
 * Accepted input for any Redis-Streams-configurable constructor: the fluent
 * {@link RedisStreamsOptionsBuilder} OR a plain {@link RedisStreamsOptionsType} object.
 */
export type RedisStreamsOptions = RedisStreamsOptionsBuilder | Partial<RedisStreamsOptionsType>;
/** Value alias so `RedisStreamsOptions.create()` / `new RedisStreamsOptions()` resolve to the builder. */
export const RedisStreamsOptions = RedisStreamsOptionsBuilder;
