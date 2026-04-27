import type { Config } from '../../config/Config.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import type { BrokerCommonSettings } from './BrokerSettings.js';

/** Inbound Kafka record delivered to subscribers. */
export interface KafkaRecord {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly key: Uint8Array | null;
  readonly value: Uint8Array | null;
  readonly timestamp: string;
  readonly headers: Readonly<Record<string, Uint8Array | string | null>>;
}

/** Outbound Kafka publish envelope.  `key` / `partition` optional. */
export interface KafkaPublish {
  readonly topic: string;
  readonly value: Uint8Array | string;
  readonly key?: Uint8Array | string;
  readonly partition?: number;
  readonly headers?: Readonly<Record<string, string | Uint8Array>>;
}

export interface KafkaActorSettings extends BrokerCommonSettings {
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
  };
  /** Subscriber that receives every consumed record. */
  readonly target?: ActorRef<KafkaRecord>;
  /** Topics the consumer subscribes to at connect time. */
  readonly topics?: ReadonlyArray<string>;
}

export type KafkaCmd =
  | { readonly kind: 'publish'; readonly publish: KafkaPublish }
  | { readonly kind: 'subscribe'; readonly topic: string }
  | { readonly kind: 'commit'; readonly topic: string; readonly partition: number; readonly offset: string };

/**
 * Kafka producer + consumer in one actor, backed by `kafkajs`.  When
 * `consumer.groupId` is set, a consumer is started after `connectImpl`
 * and consumed records are delivered to `target`.  When a producer is
 * the only goal, leave `consumer` and `topics` empty.
 *
 * Offset commit semantics: kafkajs auto-commits after the message
 * handler returns successfully, which gives at-least-once delivery.
 * Apps that need exactly-once should use `commit`-command + disable
 * auto-commit (out of scope for v1; document upgrade path).
 */
export class KafkaActor extends BrokerActor<KafkaActorSettings, KafkaCmd, KafkaPublish> {
  private kafka: KafkaInstanceLike | null = null;
  private producer: KafkaProducerLike | null = null;
  private consumer: KafkaConsumerLike | null = null;

  constructor(settings: Partial<KafkaActorSettings> = {}) { super(settings); }

  protected configKey(): string { return 'actor-ts.io.broker.kafka'; }
  protected builtInDefaults(): Partial<KafkaActorSettings> {
    return { ssl: false, producer: { idempotent: false, allowAutoTopicCreation: false } };
  }
  protected readSettingsFromConfig(c: Config): Partial<KafkaActorSettings> {
    const out: { -readonly [K in keyof KafkaActorSettings]?: KafkaActorSettings[K] } = {};
    if (c.hasPath('brokers')) out.brokers = c.getStringList('brokers');
    if (c.hasPath('clientId')) out.clientId = c.getString('clientId');
    if (c.hasPath('ssl')) out.ssl = c.getBoolean('ssl');
    if (c.hasPath('sasl')) {
      const s = c.getConfig('sasl');
      out.sasl = {
        mechanism: s.getString('mechanism') as 'plain' | 'scram-sha-256' | 'scram-sha-512',
        username: s.getString('username'),
        password: s.getString('password'),
      };
    }
    if (c.hasPath('consumer')) {
      const cc = c.getConfig('consumer');
      out.consumer = {
        groupId: cc.hasPath('groupId') ? cc.getString('groupId') : undefined,
        fromBeginning: cc.hasPath('fromBeginning') ? cc.getBoolean('fromBeginning') : undefined,
      };
    }
    if (c.hasPath('topics')) out.topics = c.getStringList('topics');
    return out;
  }
  protected requiredSettings(): ReadonlyArray<keyof KafkaActorSettings> { return ['brokers']; }
  protected endpointLabel(): string {
    const brokers = this.settings.brokers;
    return Array.isArray(brokers) ? `kafka://${brokers.join(',')}` : `kafka://${brokers ?? ''}`;
  }

  protected async connectImpl(): Promise<void> {
    const kafkajs = await kafkaLazy.get();
    const Ctor = kafkajs.Kafka ?? (kafkajs as unknown as { default: { Kafka: KafkaCtor } }).default.Kafka;
    const brokersRaw = this.settings.brokers;
    const brokers: ReadonlyArray<string> = Array.isArray(brokersRaw)
      ? brokersRaw
      : (typeof brokersRaw === 'string' ? brokersRaw : '')
          .split(',').map((s: string) => s.trim()).filter(Boolean);
    this.kafka = new Ctor({
      clientId: this.settings.clientId,
      brokers: [...brokers],
      ssl: this.settings.ssl,
      sasl: this.settings.sasl,
    });
    this.producer = this.kafka.producer({
      idempotent: this.settings.producer?.idempotent,
      allowAutoTopicCreation: this.settings.producer?.allowAutoTopicCreation,
    });
    await this.producer.connect();

    if (this.settings.consumer?.groupId) {
      this.consumer = this.kafka.consumer({ groupId: this.settings.consumer.groupId });
      await this.consumer.connect();
      for (const topic of this.settings.topics ?? []) {
        await this.consumer.subscribe({
          topic, fromBeginning: this.settings.consumer.fromBeginning ?? false,
        });
      }
      const target = this.settings.target;
      // We deliberately don't await `run` — it's a long-running pump.
      void this.consumer.run({
        eachMessage: async ({ topic, partition, message }: KafkaConsumedMessage): Promise<void> => {
          if (!target) return;
          target.tell({
            topic, partition,
            offset: message.offset,
            key: message.key,
            value: message.value,
            timestamp: message.timestamp,
            headers: message.headers ?? {},
          });
        },
      });
    }
  }

  protected async disconnectImpl(): Promise<void> {
    const errors: Error[] = [];
    if (this.consumer) {
      try { await this.consumer.disconnect(); } catch (e) { errors.push(e as Error); }
      this.consumer = null;
    }
    if (this.producer) {
      try { await this.producer.disconnect(); } catch (e) { errors.push(e as Error); }
      this.producer = null;
    }
    this.kafka = null;
    if (errors.length > 0) {
      this.log.warn(`KafkaActor disconnect: ${errors.map((e) => e.message).join('; ')}`);
    }
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<KafkaPublish>): Promise<void> {
    if (!this.producer) throw new Error('KafkaActor: producer not connected');
    const p = env.payload;
    const value = typeof p.value === 'string' ? Buffer.from(p.value) : p.value;
    const key = p.key === undefined ? null
      : (typeof p.key === 'string' ? Buffer.from(p.key) : p.key);
    await this.producer.send({
      topic: p.topic,
      messages: [{ value, key, partition: p.partition, headers: p.headers as never }],
    });
  }

  override onReceive(cmd: KafkaCmd): void {
    if (cmd.kind === 'publish') this.enqueueOutbound(cmd.publish);
    else if (cmd.kind === 'subscribe') {
      // Runtime topic-add — kafkajs requires the consumer already be running.
      if (this.consumer && this.connectionState === 'connected') {
        void this.consumer.subscribe({ topic: cmd.topic, fromBeginning: false });
      }
    }
    // 'commit' would only be relevant in manual-commit mode (out of scope).
  }
}

/* ----------------------------- internals -------------------------------- */

interface KafkaCtor {
  new (config: {
    clientId?: string;
    brokers: string[];
    ssl?: boolean;
    sasl?: { mechanism: string; username: string; password: string };
  }): KafkaInstanceLike;
}

interface KafkaInstanceLike {
  producer(config?: { idempotent?: boolean; allowAutoTopicCreation?: boolean }): KafkaProducerLike;
  consumer(config: { groupId: string }): KafkaConsumerLike;
}

interface KafkaProducerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(args: {
    topic: string;
    messages: Array<{
      value: Uint8Array | null; key?: Uint8Array | null;
      partition?: number; headers?: Record<string, string | Uint8Array>;
    }>;
  }): Promise<unknown>;
}

interface KafkaConsumedMessage {
  topic: string;
  partition: number;
  message: {
    offset: string;
    key: Uint8Array | null;
    value: Uint8Array | null;
    timestamp: string;
    headers?: Record<string, Uint8Array | string | null>;
  };
}

interface KafkaConsumerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(args: { topic: string; fromBeginning?: boolean }): Promise<void>;
  run(args: { eachMessage: (m: KafkaConsumedMessage) => Promise<void> }): Promise<void>;
}

interface KafkajsModule {
  Kafka?: KafkaCtor;
}

const kafkaLazy: Lazy<Promise<KafkajsModule>> = Lazy.of(async () => {
  try {
    const name = 'kafkajs';
    return (await import(name)) as unknown as KafkajsModule;
  } catch (e) {
    throw new Error(
      'KafkaActor requires the "kafkajs" package.  Install it with: npm install kafkajs\n'
      + 'Original error: ' + (e instanceof Error ? e.message : String(e)),
    );
  }
});
