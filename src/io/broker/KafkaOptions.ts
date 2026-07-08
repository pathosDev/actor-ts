/**
 * Fluent builder for {@link KafkaOptionsType}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.kafka` > built-in defaults).
 */
import { BrokerOptionsBuilder, BrokerOptionsValidator } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerSettings.js';
import type { ActorRef } from '../../ActorRef.js';
import type { KafkaCommitMode, KafkaRecord } from './KafkaActor.js';

export interface KafkaOptionsType extends BrokerCommonOptionsType {
  /** Bootstrap servers (`'kafka-1:9092,kafka-2:9092'` or array). */
  readonly brokers?: ReadonlyArray<string> | string;
  /** Stable client id reported to the broker. */
  readonly clientId?: string;
  /** Optional SASL credentials. */
  readonly sasl?: {
    readonly mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
    readonly username: string;
    readonly password: string;
  };
  /** Enable TLS. */
  readonly ssl?: boolean;
  /** Producer settings. */
  readonly producer?: {
    readonly idempotent?: boolean;
    readonly allowAutoTopicCreation?: boolean;
  };
  /** Consumer settings.  `groupId` is required to start a consumer. */
  readonly consumer?: {
    readonly groupId?: string;
    readonly fromBeginning?: boolean;
    /**
     * Offset-commit policy.  Default `'auto'` — kafkajs auto-commits
     * after the handler returns (at-least-once).  See
     * {@link KafkaCommitMode} for the `'manual'` (exactly-once-with-
     * processing) shape.
     */
    readonly commitMode?: KafkaCommitMode;
    /**
     * Max time in ms the manual-commit pump waits for an external
     * `commit` / `nack` before giving up on a message and letting
     * kafkajs reject it (which triggers a rebalance and re-delivery).
     * Only used when `commitMode === 'manual'`.  Default 30s.
     */
    readonly commitTimeoutMs?: number;
  };
  /** Subscriber that receives every consumed record. */
  readonly target?: ActorRef<KafkaRecord>;
  /** Topics the consumer subscribes to at connect time. */
  readonly topics?: ReadonlyArray<string>;
}

export class KafkaOptionsBuilder extends BrokerOptionsBuilder<KafkaOptionsType> {
  /** Start a fresh builder.  Equivalent to `new KafkaOptionsBuilder()`. */
  static create(): KafkaOptionsBuilder {
    return new KafkaOptionsBuilder();
  }

  /** Bootstrap servers (`'kafka-1:9092,kafka-2:9092'` or array). */
  withBrokers(brokers: ReadonlyArray<string> | string): this {
    return this.set('brokers', brokers);
  }

  /** Stable client id reported to the broker. */
  withClientId(clientId: string): this {
    return this.set('clientId', clientId);
  }

  /** SASL credentials. */
  withSasl(sasl: NonNullable<KafkaOptionsType['sasl']>): this {
    return this.set('sasl', sasl);
  }

  /** Enable TLS.  Default `false`. */
  withSsl(on = true): this {
    return this.set('ssl', on);
  }

  /** Producer settings (idempotence / auto-topic-creation). */
  withProducer(producer: NonNullable<KafkaOptionsType['producer']>): this {
    return this.set('producer', producer);
  }

  /** Consumer settings.  `groupId` is required to start a consumer. */
  withConsumer(consumer: NonNullable<KafkaOptionsType['consumer']>): this {
    return this.set('consumer', consumer);
  }

  /** Subscriber that receives every consumed record. */
  withTarget(target: ActorRef<KafkaRecord>): this {
    return this.set('target', target);
  }

  /** Topics the consumer subscribes to at connect time. */
  withTopics(topics: ReadonlyArray<string>): this {
    return this.set('topics', topics);
  }
}

/** Validates resolved {@link KafkaOptionsType} settings. */
export class KafkaOptionsValidator extends BrokerOptionsValidator<KafkaOptionsType> {
  constructor() {
    super('KafkaOptions');
  }
  protected rules(s: Partial<KafkaOptionsType>): void {
    this.commonRules(s);
    this.nonEmptyStringOrArray('brokers', s.brokers);
    this.nestedPositive('consumer.commitTimeoutMs', s.consumer?.commitTimeoutMs);
  }
}

/**
 * Accepted input for any Kafka-configurable constructor: the fluent
 * {@link KafkaOptionsBuilder} OR a plain {@link KafkaOptionsType} object.
 */
export type KafkaOptions = KafkaOptionsBuilder | Partial<KafkaOptionsType>;
/** Value alias so `KafkaOptions.create()` / `new KafkaOptions()` resolve to the builder. */
export const KafkaOptions = KafkaOptionsBuilder;
