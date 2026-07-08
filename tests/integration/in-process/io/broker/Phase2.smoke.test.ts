/**
 * Phase 2 actors — Kafka / AMQP / gRPC — smoke tests that don't need the
 * peer deps installed.  We verify:
 *   1. Importing the modules doesn't crash.
 *   2. Constructing actors stays sync (peer-dep loaded lazily).
 *   3. Options resolution + required-field validation works.
 *
 * Live integration tests against real brokers / a real gRPC loop run
 * in a separate, optional file (out of scope here).
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Props } from '../../../../../src/Props.js';
import { Actor } from '../../../../../src/Actor.js';
import { KafkaActor } from '../../../../../src/io/broker/KafkaActor.js';
import { KafkaOptions } from '../../../../../src/io/broker/KafkaOptions.js';
import { AmqpActor } from '../../../../../src/io/broker/AmqpActor.js';
import { AmqpOptions } from '../../../../../src/io/broker/AmqpOptions.js';
import { GrpcClientActor } from '../../../../../src/io/broker/GrpcClientActor.js';
import { GrpcClientOptions } from '../../../../../src/io/broker/GrpcClientOptions.js';
import { GrpcServerActor } from '../../../../../src/io/broker/GrpcServerActor.js';
import { GrpcServerOptions } from '../../../../../src/io/broker/GrpcServerOptions.js';
import { BrokerOptionsError } from '../../../../../src/io/broker/BrokerOptions.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

function makeSys(name = 'phase2'): ActorSystem {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
}

describe('Phase 2 actors — construction is lazy', () => {
  test('KafkaActor constructs without loading kafkajs', () => {
    const kafkaOptions = KafkaOptions.create()
      .withBrokers(['localhost:9092']);
    const a = new KafkaActor(kafkaOptions);
    expect(a).toBeInstanceOf(KafkaActor);
  });
  test('AmqpActor constructs without loading amqplib', () => {
    const amqpOptions = AmqpOptions.create()
      .withUrl('amqp://localhost');
    const a = new AmqpActor(amqpOptions);
    expect(a).toBeInstanceOf(AmqpActor);
  });
  test('GrpcClientActor constructs without loading @grpc/grpc-js', () => {
    const grpcClientOptions = GrpcClientOptions.create()
      .withProtoPath('x.proto').withPackageName('x').withServiceName('X').withEndpoint('localhost:1');
    const a = new GrpcClientActor(grpcClientOptions);
    expect(a).toBeInstanceOf(GrpcClientActor);
  });
  test('GrpcServerActor constructs without loading @grpc/grpc-js', () => {
    const grpcServerOptions = GrpcServerOptions.create()
      .withProtoPath('x.proto').withPackageName('x').withServiceName('X')
      .withBind('0.0.0.0:0').withHandlers({});
    const a = new GrpcServerActor(grpcServerOptions);
    expect(a).toBeInstanceOf(GrpcServerActor);
  });
});

describe('Phase 2 actors — options validation', () => {
  test('KafkaActor without `brokers` raises BrokerOptionsError', async () => {
    const sys = makeSys('kafka-validate');
    let captured: Error | null = null;
    sys.spawnAnonymous(Props.create(() => {
      const a = new KafkaActor(KafkaOptions.create());
      const orig = a.preStart.bind(a);
      a.preStart = async (): Promise<void> => {
        try { await orig(); }
        catch (e) { captured = e as Error; }
      };
      return a as unknown as Actor<unknown>;
    }));
    await sleep(30);
    expect(captured).toBeInstanceOf(BrokerOptionsError);
    expect((captured as unknown as Error).message).toContain('brokers');
    await sys.terminate();
  });

  test('GrpcClientActor without endpoint raises BrokerOptionsError', async () => {
    const sys = makeSys('grpc-validate');
    let captured: Error | null = null;
    const grpcClientOptions = GrpcClientOptions.create()
      .withProtoPath('x.proto').withPackageName('x').withServiceName('X');
    // endpoint missing
    sys.spawnAnonymous(Props.create(() => {
      const a = new GrpcClientActor(grpcClientOptions);
      const orig = a.preStart.bind(a);
      a.preStart = async (): Promise<void> => {
        try { await orig(); }
        catch (e) { captured = e as Error; }
      };
      return a as unknown as Actor<unknown>;
    }));
    await sleep(30);
    expect(captured).toBeInstanceOf(BrokerOptionsError);
    expect((captured as unknown as Error).message).toContain('endpoint');
    await sys.terminate();
  });
});

describe('Phase 2 actors — options precedence (constructor wins over HOCON)', () => {
  test('KafkaActor: constructor brokers override HOCON', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': { io: { broker: { kafka: { brokers: ['hocon:9092'], clientId: 'from-cfg' } } } },
      });
    const sys = ActorSystem.create('kafka-prec', sysOptions);
    let captured: KafkaActor | null = null;
    let resolve!: (a: KafkaActor) => void;
    const ready = new Promise<KafkaActor>((r) => { resolve = r; });
    const kafkaOptions = KafkaOptions.create()
      .withBrokers(['ctor:9092']);  // ctor wins
    sys.spawnAnonymous(Props.create(() => {
      const a = new KafkaActor(kafkaOptions);
      // We'll never actually try to connect — kafkajs isn't installed.
      // Override preStart to swallow the connect error after options
      // resolution so the test can inspect them.
      const orig = a.preStart.bind(a);
      a.preStart = async (): Promise<void> => {
        try { await orig(); } catch { /* ignored — kafkajs missing */ }
        captured = a;
        resolve(a);
      };
      return a as unknown as Actor<unknown>;
    }));
    await ready;
    await sleep(20);
    expect(captured).not.toBeNull();
    const options = (captured as unknown as { options: { brokers: string[]; clientId?: string } }).options;
    // Constructor `brokers` override takes precedence.
    expect(options.brokers).toEqual(['ctor:9092']);
    // `clientId` only set in HOCON, so it propagates.
    expect(options.clientId).toBe('from-cfg');
    await sys.terminate();
  });
});
