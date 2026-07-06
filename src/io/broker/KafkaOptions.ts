/**
 * Fluent builder for {@link KafkaActorSettings}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptions}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.kafka` > built-in defaults).
 */
import { BrokerOptions } from './BrokerOptions.js';
import type { ActorRef } from '../../ActorRef.js';
import type { KafkaActorSettings, KafkaRecord } from './KafkaActor.js';

export class KafkaOptions extends BrokerOptions<KafkaActorSettings> {
  /** Start a fresh builder.  Equivalent to `new KafkaOptions()`. */
  static create(): KafkaOptions {
    return new KafkaOptions();
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
  withSasl(sasl: NonNullable<KafkaActorSettings['sasl']>): this {
    return this.set('sasl', sasl);
  }

  /** Enable TLS.  Default `false`. */
  withSsl(on = true): this {
    return this.set('ssl', on);
  }

  /** Producer settings (idempotence / auto-topic-creation). */
  withProducer(producer: NonNullable<KafkaActorSettings['producer']>): this {
    return this.set('producer', producer);
  }

  /** Consumer settings.  `groupId` is required to start a consumer. */
  withConsumer(consumer: NonNullable<KafkaActorSettings['consumer']>): this {
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
