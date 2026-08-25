/**
 * TLS material actually reaches the broker drivers (#743).
 *
 * Every one of these six actors used to hand its driver a URL and nothing
 * else — `amqp.connect(url)`, `new Redis(url)`, a fixed six-field mqtt
 * options object, a five-key `nats.connect({…})` — so a private CA or a
 * client certificate had no way in at all.  The bug was never visible from
 * the outside: the connection still succeeded against any broker with a
 * publicly-trusted certificate, and failed *loudly but unfixably* against
 * one behind an internal CA.
 *
 * The assertion each test makes is therefore about the **argument the driver
 * received**, not about the actor reaching `connected` — which it does either
 * way.  Each actor is subclassed at its module seam (`amqpModule`,
 * `ioredisModule`, `mqttModule`, `natsModule`, `kafkaModule`), which is the
 * layer *above* the options-building code, so the mapping under test really
 * runs.  Overriding `createNatsConnection` / `createClient` /
 * `createKafkaInstance` instead would replace that code with the test's own
 * and assert nothing.
 *
 * `serverName` is in every payload on purpose: it is the one field whose
 * spelling changes on the way out (`serverName` → Node's `servername`), so a
 * pass-through that looks right and silently does nothing is exactly what a
 * spread would produce.
 */
import { describe, expect, test } from 'bun:test';
import type { ActorSystem } from '../../../../src/ActorSystem.js';
import { createTestActorSystem } from '../../../util/TestActorSystem.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import type { TlsTransportOptionsType } from '../../../../src/runtime/tcp/TcpBackend.js';
import {
  findBrokerTlsProblem,
  toBrokerDriverTls,
} from '../../../../src/io/broker/BrokerTls.js';
import type { BrokerDriverTlsOptions } from '../../../../src/io/broker/BrokerTls.js';
import {
  AmqpActor,
  type AmqpChannelLike,
  type AmqpConnectionLike,
  type AmqpModuleLike,
} from '../../../../src/io/broker/AmqpActor.js';
import { AmqpOptions } from '../../../../src/io/broker/AmqpOptions.js';
import {
  RedisStreamsActor,
  type IoredisClientLike,
  type IoredisClientOptionsLike,
  type IoredisModuleLike,
} from '../../../../src/io/broker/RedisStreamsActor.js';
import { RedisStreamsOptions } from '../../../../src/io/broker/RedisStreamsOptions.js';
import {
  MqttActor,
  type MqttClientLike,
  type MqttModuleLike,
} from '../../../../src/io/broker/MqttActor.js';
import { MqttOptions } from '../../../../src/io/broker/MqttOptions.js';
import {
  NatsActor,
  type NatsConnectionLike,
  type NatsModuleLike,
} from '../../../../src/io/broker/NatsActor.js';
import { NatsOptions } from '../../../../src/io/broker/NatsOptions.js';
import {
  JetStreamActor,
  type NatsConnectionLike as JetStreamConnectionLike,
  type NatsModuleLike as JetStreamModuleLike,
  type JetStreamClientLike,
} from '../../../../src/io/broker/JetStreamActor.js';
import { JetStreamOptions } from '../../../../src/io/broker/JetStreamOptions.js';
import {
  KafkaActor,
  type KafkaInstanceLike,
  type KafkaProducerLike,
  type KafkajsModule,
} from '../../../../src/io/broker/KafkaActor.js';
import { KafkaOptions } from '../../../../src/io/broker/KafkaOptions.js';

/**
 * One material set reused by every arm, so a driver that quietly drops a
 * field shows up as a diff against the same expectation everywhere.
 */
const MATERIAL: TlsTransportOptionsType = {
  ca: '-----BEGIN CERTIFICATE-----private-ca-----END CERTIFICATE-----',
  cert: '-----BEGIN CERTIFICATE-----client-----END CERTIFICATE-----',
  key: '-----BEGIN PRIVATE KEY-----client-----END PRIVATE KEY-----',
  rejectUnauthorized: true,
  serverName: 'broker.internal',
  // Listener-only, and the one field that must NOT reach an outbound dial.
  requestClientCert: true,
};

/** What the drivers must end up holding. */
const EXPECTED_DRIVER_TLS: BrokerDriverTlsOptions = {
  ca: MATERIAL.ca,
  cert: MATERIAL.cert,
  key: MATERIAL.key,
  rejectUnauthorized: true,
  servername: 'broker.internal',
};

/** Wait until the driver was called, then run the assertions. */
async function awaitDriverCall(label: string, seen: () => boolean): Promise<void> {
  await awaitCondition(seen, { timeoutMs: 4_000, label });
}

/* ------------------------------- AMQP ---------------------------------- */

class FakeAmqpChannel implements AmqpChannelLike {
  async prefetch(): Promise<void> {}
  async assertQueue(): Promise<unknown> { return undefined; }
  async bindQueue(): Promise<unknown> { return undefined; }
  async consume(): Promise<unknown> { return undefined; }
  publish(): boolean { return true; }
  ack(): void {}
  nack(): void {}
  once(): void {}
  async close(): Promise<void> {}
}

class FakeAmqpConnection implements AmqpConnectionLike {
  async createChannel(): Promise<AmqpChannelLike> { return new FakeAmqpChannel(); }
  on(): void {}
  async close(): Promise<void> {}
}

class RecordingAmqpModule implements AmqpModuleLike {
  readonly calls: Array<{ url: string; socketOptions?: BrokerDriverTlsOptions }> = [];
  async connect(url: string, socketOptions?: BrokerDriverTlsOptions): Promise<AmqpConnectionLike> {
    this.calls.push({ url, socketOptions });
    return new FakeAmqpConnection();
  }
}

class RecordingAmqpActor extends AmqpActor {
  readonly module = new RecordingAmqpModule();
  protected override amqpModule(): Promise<AmqpModuleLike> { return Promise.resolve(this.module); }
}

/* --------------------------- Redis Streams ------------------------------ */

class FakeRedisClient implements IoredisClientLike {
  async connect(): Promise<void> {}
  on(): void {}
  async xadd(): Promise<string> { return '0-0'; }
  async xack(): Promise<number> { return 0; }
  async xgroup(): Promise<unknown> { return undefined; }
  async xreadgroup(): Promise<unknown> { return undefined; }
  async quit(): Promise<unknown> { return undefined; }
}

class RecordingIoredisModule implements IoredisModuleLike {
  readonly calls: Array<{ url: string; options: IoredisClientOptionsLike }> = [];
  readonly default = class {
    constructor(url: string, options: IoredisClientOptionsLike) {
      RecordingIoredisModule.active!.calls.push({ url, options });
      return new FakeRedisClient();
    }
  } as unknown as IoredisModuleLike['default'];
  /**
   * The constructor above is a class expression and cannot close over `this`,
   * so the instance under test is parked here for the duration of one test.
   * Every test in this file runs its own actor, and `bun test` runs a file's
   * tests sequentially, so there is never a second live recorder.
   */
  static active: RecordingIoredisModule | null = null;
}

class RecordingRedisStreamsActor extends RedisStreamsActor {
  readonly module = new RecordingIoredisModule();
  protected override ioredisModule(): Promise<IoredisModuleLike> {
    RecordingIoredisModule.active = this.module;
    return Promise.resolve(this.module);
  }
}

/* ------------------------------- MQTT ----------------------------------- */

type MqttConnectListener = () => void;

class FakeMqttClient implements MqttClientLike {
  on(): void {}
  once(event: 'connect' | 'error', listener: MqttConnectListener | ((e: Error) => void)): void {
    // Resolve the actor's connect promise on the next tick — synchronously
    // would fire before `once('error')` is attached.
    if (event === 'connect') setTimeout(listener as MqttConnectListener, 0);
  }
  removeAllListeners(): void {}
  publish(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  end(_force?: boolean, _options?: object, callback?: () => void): void { callback?.(); }
}

/** The mqtt.js options object, widened to whatever the actor put in it. */
type RecordedMqttOptions = Record<string, unknown>;

class RecordingMqttModule implements MqttModuleLike {
  readonly calls: Array<{ url: string; options?: RecordedMqttOptions }> = [];
  connect(url: string, options?: unknown): MqttClientLike {
    this.calls.push({ url, options: options as RecordedMqttOptions });
    return new FakeMqttClient();
  }
}

class RecordingMqttActor extends MqttActor {
  readonly module = new RecordingMqttModule();
  /** `MqttActor` is subclass-first and abstract; nothing is published here. */
  override onMessage(): void {}
  protected override mqttModule(): Promise<MqttModuleLike> { return Promise.resolve(this.module); }
}

/* ------------------------------- NATS ----------------------------------- */

/** Options the `nats` module was handed, with only the fields asserted here. */
type RecordedNatsOptions = { servers: string[]; tls?: BrokerDriverTlsOptions };

class FakeNatsConnection implements NatsConnectionLike {
  publish(): void {}
  subscribe(): never { throw new Error('not used'); }
  async drain(): Promise<void> {}
  closed(): Promise<Error | undefined> { return new Promise(() => {}); }
}

class RecordingNatsModule implements NatsModuleLike {
  readonly calls: RecordedNatsOptions[] = [];
  async connect(options: RecordedNatsOptions): Promise<NatsConnectionLike> {
    this.calls.push(options);
    return new FakeNatsConnection();
  }
}

class RecordingNatsActor extends NatsActor {
  readonly module = new RecordingNatsModule();
  protected override natsModule(): Promise<NatsModuleLike> { return Promise.resolve(this.module); }
}

/* ----------------------------- JetStream -------------------------------- */

class FakeJetStreamConnection implements JetStreamConnectionLike {
  jetstream(): JetStreamClientLike { return {} as JetStreamClientLike; }
  jetstreamManager(): never { throw new Error('not used'); }
  async drain(): Promise<void> {}
  closed(): Promise<Error | undefined> { return new Promise(() => {}); }
}

class RecordingJetStreamModule implements JetStreamModuleLike {
  readonly calls: RecordedNatsOptions[] = [];
  async connect(options: RecordedNatsOptions): Promise<JetStreamConnectionLike> {
    this.calls.push(options);
    return new FakeJetStreamConnection();
  }
}

class RecordingJetStreamActor extends JetStreamActor {
  readonly module = new RecordingJetStreamModule();
  protected override natsModule(): Promise<JetStreamModuleLike> {
    return Promise.resolve(this.module);
  }
}

/* ------------------------------- Kafka ---------------------------------- */

type RecordedKafkaConfig = { brokers: string[]; ssl?: boolean | BrokerDriverTlsOptions };

class FakeKafkaProducer implements KafkaProducerLike {
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(): Promise<unknown> { return undefined; }
}

class FakeKafkaInstance implements KafkaInstanceLike {
  producer(): KafkaProducerLike { return new FakeKafkaProducer(); }
  consumer(): never { throw new Error('not used'); }
}

/** Captures the kafkajs constructor config; see the ioredis note for `active`. */
class RecordingKafkajsModule {
  readonly calls: RecordedKafkaConfig[] = [];
  static active: RecordingKafkajsModule | null = null;
  readonly Kafka = class {
    constructor(config: RecordedKafkaConfig) {
      RecordingKafkajsModule.active!.calls.push(config);
      return new FakeKafkaInstance();
    }
  } as unknown as NonNullable<KafkajsModule['Kafka']>;
}

class RecordingKafkaActor extends KafkaActor {
  readonly module = new RecordingKafkajsModule();
  protected override kafkaModule(): Promise<KafkajsModule> {
    RecordingKafkajsModule.active = this.module;
    return Promise.resolve(this.module as KafkajsModule);
  }
}

/* ------------------------------- tests ---------------------------------- */

describe('BrokerTls mapping', () => {
  test('renames serverName to the servername every driver reads, and drops requestClientCert', () => {
    expect(toBrokerDriverTls(MATERIAL)).toEqual(EXPECTED_DRIVER_TLS);
    expect(toBrokerDriverTls(MATERIAL)).not.toHaveProperty('serverName');
    expect(toBrokerDriverTls(MATERIAL)).not.toHaveProperty('requestClientCert');
  });

  test('unconfigured TLS maps to undefined, so a driver call stays byte-identical', () => {
    expect(toBrokerDriverTls(undefined)).toBeUndefined();
  });

  test('an empty block is kept as an object — presence is how kafkajs/nats say "TLS on"', () => {
    expect(toBrokerDriverTls({})).toEqual({
      ca: undefined, cert: undefined, key: undefined,
      rejectUnauthorized: undefined, servername: undefined,
    });
  });

  test('a certificate without its key is rejected, in both directions', () => {
    expect(findBrokerTlsProblem({ cert: 'c' })).toContain('cert without key');
    expect(findBrokerTlsProblem({ key: 'k' })).toContain('key without cert');
    expect(findBrokerTlsProblem({ cert: 'c', key: 'k' })).toBeNull();
    expect(findBrokerTlsProblem({ ca: 'ca' })).toBeNull();
    expect(findBrokerTlsProblem(undefined)).toBeNull();
  });
});

describe('broker actors forward TLS material to their driver', () => {
  test('AmqpActor passes it as amqplib socketOptions', async () => {
    const system: ActorSystem = createTestActorSystem({ name: 'tls-amqp' });
    const reference = { current: null as RecordingAmqpActor | null };
    const options = AmqpOptions.create()
      .withUrl('amqps://rabbitmq.internal:5671')
      .withTls(MATERIAL);
    system.spawn(() => {
      const actor = new RecordingAmqpActor(options);
      reference.current = actor;
      return actor;
    }, 'amqp');
    try {
      await awaitDriverCall(
        'amqplib was asked to connect',
        () => (reference.current?.module.calls.length ?? 0) > 0,
      );
      expect(reference.current!.module.calls[0]!.socketOptions).toEqual(EXPECTED_DRIVER_TLS);
    } finally {
      await system.terminate();
    }
  });

  test('RedisStreamsActor passes it as ioredis `tls`', async () => {
    const system: ActorSystem = createTestActorSystem({ name: 'tls-redis' });
    const reference = { current: null as RecordingRedisStreamsActor | null };
    const options = RedisStreamsOptions.create()
      .withUrl('rediss://redis.internal:6379')
      .withTls(MATERIAL);
    system.spawn(() => {
      const actor = new RecordingRedisStreamsActor(options);
      reference.current = actor;
      return actor;
    }, 'redis');
    try {
      await awaitDriverCall(
        'ioredis was constructed',
        () => (reference.current?.module.calls.length ?? 0) > 0,
      );
      const call = reference.current!.module.calls[0]!;
      expect(call.options.tls).toEqual(EXPECTED_DRIVER_TLS);
      // The lazyConnect contract of #742 has to survive the widening.
      expect(call.options.lazyConnect).toBe(true);
    } finally {
      await system.terminate();
    }
  });

  test('MqttActor merges it into the mqtt.js connect options', async () => {
    const system: ActorSystem = createTestActorSystem({ name: 'tls-mqtt' });
    const reference = { current: null as RecordingMqttActor | null };
    const options = MqttOptions.create()
      .withBrokerUrl('mqtts://mqtt.internal:8883')
      .withClientId('tls-probe')
      .withTls(MATERIAL);
    system.spawn(() => {
      const actor = new RecordingMqttActor(options);
      reference.current = actor;
      return actor;
    }, 'mqtt');
    try {
      await awaitDriverCall(
        'mqtt.js was asked to connect',
        () => (reference.current?.module.calls.length ?? 0) > 0,
      );
      const recorded = reference.current!.module.calls[0]!.options!;
      expect(recorded).toMatchObject(EXPECTED_DRIVER_TLS as Record<string, unknown>);
      // The protocol fields it is merged beside must survive the merge.
      expect(recorded.clientId).toBe('tls-probe');
    } finally {
      await system.terminate();
    }
  });

  test('NatsActor passes it as the nats.js `tls` option', async () => {
    const system: ActorSystem = createTestActorSystem({ name: 'tls-nats' });
    const reference = { current: null as RecordingNatsActor | null };
    const options = NatsOptions.create()
      .withServers('nats://nats.internal:4222')
      .withTls(MATERIAL);
    system.spawn(() => {
      const actor = new RecordingNatsActor(options);
      reference.current = actor;
      return actor;
    }, 'nats');
    try {
      await awaitDriverCall(
        'nats.js was asked to connect',
        () => (reference.current?.module.calls.length ?? 0) > 0,
      );
      expect(reference.current!.module.calls[0]!.tls).toEqual(EXPECTED_DRIVER_TLS);
    } finally {
      await system.terminate();
    }
  });

  test('JetStreamActor passes it too — a separate copy of the same call', async () => {
    const system: ActorSystem = createTestActorSystem({ name: 'tls-jetstream' });
    const reference = { current: null as RecordingJetStreamActor | null };
    const options = JetStreamOptions.create()
      .withServers('nats://nats.internal:4222')
      .withTls(MATERIAL);
    system.spawn(() => {
      const actor = new RecordingJetStreamActor(options);
      reference.current = actor;
      return actor;
    }, 'jetstream');
    try {
      await awaitDriverCall(
        'nats.js was asked to connect',
        () => (reference.current?.module.calls.length ?? 0) > 0,
      );
      expect(reference.current!.module.calls[0]!.tls).toEqual(EXPECTED_DRIVER_TLS);
    } finally {
      await system.terminate();
    }
  });

  test('KafkaActor forwards material given as `ssl`', async () => {
    const system: ActorSystem = createTestActorSystem({ name: 'tls-kafka' });
    const reference = { current: null as RecordingKafkaActor | null };
    const options = KafkaOptions.create()
      .withBrokers(['kafka.internal:9093'])
      .withSsl(MATERIAL);
    system.spawn(() => {
      const actor = new RecordingKafkaActor(options);
      reference.current = actor;
      return actor;
    }, 'kafka');
    try {
      await awaitDriverCall(
        'kafkajs was constructed',
        () => (reference.current?.module.calls.length ?? 0) > 0,
      );
      expect(reference.current!.module.calls[0]!.ssl).toEqual(EXPECTED_DRIVER_TLS);
    } finally {
      await system.terminate();
    }
  });

  test('KafkaActor still forwards the plain boolean form', async () => {
    const system: ActorSystem = createTestActorSystem({ name: 'tls-kafka-boolean' });
    const reference = { current: null as RecordingKafkaActor | null };
    const options = KafkaOptions.create()
      .withBrokers(['kafka.internal:9093'])
      .withSsl(true);
    system.spawn(() => {
      const actor = new RecordingKafkaActor(options);
      reference.current = actor;
      return actor;
    }, 'kafka');
    try {
      await awaitDriverCall(
        'kafkajs was constructed',
        () => (reference.current?.module.calls.length ?? 0) > 0,
      );
      expect(reference.current!.module.calls[0]!.ssl).toBe(true);
    } finally {
      await system.terminate();
    }
  });

  test('an actor with no TLS configured calls its driver exactly as before', async () => {
    const system: ActorSystem = createTestActorSystem({ name: 'tls-absent' });
    const reference = { current: null as RecordingAmqpActor | null };
    const options = AmqpOptions.create().withUrl('amqp://rabbitmq.internal:5672');
    system.spawn(() => {
      const actor = new RecordingAmqpActor(options);
      reference.current = actor;
      return actor;
    }, 'amqp');
    try {
      await awaitDriverCall(
        'amqplib was asked to connect',
        () => (reference.current?.module.calls.length ?? 0) > 0,
      );
      expect(reference.current!.module.calls[0]!.socketOptions).toBeUndefined();
    } finally {
      await system.terminate();
    }
  });
});
