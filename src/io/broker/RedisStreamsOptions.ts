/**
 * Fluent builder for {@link RedisStreamsOptionsType}.  Protocol-
 * specific methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.redisStreams` > built-in defaults).
 */
import { BrokerOptionsBuilder, BrokerOptionsValidator } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';
import { findBrokerTlsProblem } from './BrokerTls.js';
import type { TlsTransportOptionsType } from '../../runtime/tcp/TcpBackend.js';
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
  /**
   * TLS material forwarded to ioredis as its `tls` option — a private CA to
   * trust, or a client certificate for mTLS.  Carries the material itself,
   * never a path to it.
   *
   * Setting it also *enables* TLS on the ioredis side, so it works with a
   * plain `redis://` URL; `rediss://` remains the clearer way to say the same
   * thing.  Deliberately has no HOCON leaf — a config file is the wrong place
   * for a private key.
   */
  readonly tls?: TlsTransportOptionsType;
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

  /** TLS material for the Redis dial.  Pass the material, not a file path. */
  withTls(tls: TlsTransportOptionsType): this {
    return this.set('tls', tls);
  }
}

/** Validates resolved {@link RedisStreamsOptionsType} settings. */
export class RedisStreamsOptionsValidator extends BrokerOptionsValidator<RedisStreamsOptionsType> {
  constructor() {
    super('RedisStreamsOptions');
  }
  protected rules(s: Partial<RedisStreamsOptionsType>): void {
    this.commonRules(s);
    this.url('url', ['redis', 'rediss']);
    this.nonNegativeInt('blockMs'); // 0 = block indefinitely (Redis XREAD semantics)
    const tlsProblem = findBrokerTlsProblem(s.tls);
    if (tlsProblem !== null) this.fail('tls', tlsProblem);
  }
}

/**
 * Accepted input for any Redis-Streams-configurable constructor: the fluent
 * {@link RedisStreamsOptionsBuilder} OR a plain {@link RedisStreamsOptionsType} object.
 */
export type RedisStreamsOptions = RedisStreamsOptionsBuilder | Partial<RedisStreamsOptionsType>;
/** Value alias so `RedisStreamsOptions.create()` / `new RedisStreamsOptions()` resolve to the builder. */
export const RedisStreamsOptions = RedisStreamsOptionsBuilder;
