/**
 * Fluent builder for {@link JetStreamOptionsType}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.jetstream` > built-in defaults).
 */
import { BrokerOptionsBuilder, BrokerOptionsValidator } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';
import type { ActorRef } from '../../ActorRef.js';
import type {
  JetStreamConsumerConfig,
  JetStreamMessage,
  JetStreamStreamConfig,
} from './JetStreamActor.js';

export interface JetStreamOptionsType extends BrokerCommonOptionsType {
  /** NATS server URLs. */
  readonly servers?: ReadonlyArray<string> | string;
  /** Optional credentials. */
  readonly token?: string;
  readonly user?: string;
  readonly password?: string;
  /** Optional client name. */
  readonly name?: string;
  /** Stream lifecycle config — set when this actor owns the stream. */
  readonly stream?: JetStreamStreamConfig;
  /** Consumer config — required to start a subscription. */
  readonly consumer?: JetStreamConsumerConfig;
  /** Actor receiving every consumed message. */
  readonly target?: ActorRef<JetStreamMessage>;
  /**
   * Max time the manual-ack pump waits for a `ack`/`nak`/`term`
   * before giving up on a message and rejecting internally
   * (kafkajs-style failure).  Default = `consumer.ackWaitMs ?? 30s`.
   */
  readonly acknowledgmentTimeout?: number;
}

export class JetStreamOptionsBuilder extends BrokerOptionsBuilder<JetStreamOptionsType> {
  /** Start a fresh builder.  Equivalent to `new JetStreamOptionsBuilder()`. */
  static create(): JetStreamOptionsBuilder {
    return new JetStreamOptionsBuilder();
  }

  /** NATS server URLs (`'nats://localhost:4222'` or array). */
  withServers(servers: ReadonlyArray<string> | string): this {
    return this.set('servers', servers);
  }

  /** Token credential. */
  withToken(token: string): this {
    return this.set('token', token);
  }

  /** Username credential. */
  withUser(user: string): this {
    return this.set('user', user);
  }

  /** Password credential. */
  withPassword(password: string): this {
    return this.set('password', password);
  }

  /** Client name reported to the server. */
  withName(name: string): this {
    return this.set('name', name);
  }

  /** Stream lifecycle config — set when this actor owns the stream. */
  withStream(stream: JetStreamStreamConfig): this {
    return this.set('stream', stream);
  }

  /** Consumer config — required to start a subscription. */
  withConsumer(consumer: JetStreamConsumerConfig): this {
    return this.set('consumer', consumer);
  }

  /** Actor receiving every consumed message. */
  withTarget(target: ActorRef<JetStreamMessage>): this {
    return this.set('target', target);
  }

  /** Max time the manual-ack pump waits for ack/nak/term before giving up. */
  withAcknowledgmentTimeout(ms: number): this {
    return this.set('acknowledgmentTimeout', ms);
  }
}

/** Validates resolved {@link JetStreamOptionsType} settings. */
export class JetStreamOptionsValidator extends BrokerOptionsValidator<JetStreamOptionsType> {
  constructor() {
    super('JetStreamOptions');
  }
  protected rules(s: Partial<JetStreamOptionsType>): void {
    this.commonRules(s);
    this.nonEmptyStringOrArray('servers', s.servers);
    this.positiveNumber('acknowledgmentTimeout');
  }
}

/**
 * Accepted input for any JetStream-configurable constructor: the fluent
 * {@link JetStreamOptionsBuilder} OR a plain {@link JetStreamOptionsType} object.
 */
export type JetStreamOptions = JetStreamOptionsBuilder | Partial<JetStreamOptionsType>;
/** Value alias so `JetStreamOptions.create()` / `new JetStreamOptions()` resolve to the builder. */
export const JetStreamOptions = JetStreamOptionsBuilder;
