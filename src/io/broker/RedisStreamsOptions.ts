/**
 * Fluent builder for {@link RedisStreamsActorSettings}.  Protocol-
 * specific methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptions}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.redisStreams` > built-in defaults).
 */
import { BrokerOptions } from './BrokerOptions.js';
import type { ActorRef } from '../../ActorRef.js';
import type { RedisStreamsActorSettings, RedisStreamEntry } from './RedisStreamsActor.js';

export class RedisStreamsOptions extends BrokerOptions<RedisStreamsActorSettings> {
  /** Start a fresh builder.  Equivalent to `new RedisStreamsOptions()`. */
  static create(): RedisStreamsOptions {
    return new RedisStreamsOptions();
  }

  /** Redis URL (`'redis://host:6379'`). */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Streams to consume. */
  withStreams(streams: ReadonlyArray<string>): this {
    return this.set('streams', streams);
  }

  /** Consumer-group settings — required to consume. */
  withConsumerGroup(group: NonNullable<RedisStreamsActorSettings['consumerGroup']>): this {
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
