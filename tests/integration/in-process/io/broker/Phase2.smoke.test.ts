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
import { awaitCondition } from '../../../../util/AwaitCondition.js';

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
    const actor = new KafkaActor(kafkaOptions);
    expect(actor).toBeInstanceOf(KafkaActor);
  });
  test('AmqpActor constructs without loading amqplib', () => {
    const amqpOptions = AmqpOptions.create()
      .withUrl('amqp://localhost');
    const actor = new AmqpActor(amqpOptions);
    expect(actor).toBeInstanceOf(AmqpActor);
  });
  test('GrpcClientActor constructs without loading @grpc/grpc-js', () => {
    const grpcClientOptions = GrpcClientOptions.create()
      .withProtoPath('x.proto').withPackageName('x').withServiceName('X').withEndpoint('localhost:1');
    const actor = new GrpcClientActor(grpcClientOptions);
    expect(actor).toBeInstanceOf(GrpcClientActor);
  });
  test('GrpcServerActor constructs without loading @grpc/grpc-js', () => {
    const grpcServerOptions = GrpcServerOptions.create()
      .withProtoPath('x.proto').withPackageName('x').withServiceName('X')
      .withBind('0.0.0.0:0').withHandlers({});
    const actor = new GrpcServerActor(grpcServerOptions);
    expect(actor).toBeInstanceOf(GrpcServerActor);
  });
});

describe('Phase 2 actors — options validation', () => {
  test('KafkaActor without `brokers` raises BrokerOptionsError', async () => {
    const sys = makeSys('kafka-validate');
    let captured: Error | null = null;
    sys.spawnAnonymous(() => {
      const actor = new KafkaActor(KafkaOptions.create());
      const orig = actor.preStart.bind(actor);
      actor.preStart = async (): Promise<void> => {
        try { await orig(); }
        catch (e) { captured = e as Error; }
      };
      return actor as unknown as Actor<unknown>;
    });
    await awaitCondition(() => captured !== null, {
      label: "preStart rejected the KafkaActor's options",
    });
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
    sys.spawnAnonymous(() => {
      const actor = new GrpcClientActor(grpcClientOptions);
      const orig = actor.preStart.bind(actor);
      actor.preStart = async (): Promise<void> => {
        try { await orig(); }
        catch (e) { captured = e as Error; }
      };
      return actor as unknown as Actor<unknown>;
    });
    await awaitCondition(() => captured !== null, {
      label: "preStart rejected the GrpcClientActor's options",
    });
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
    let resolve!: (actor: KafkaActor) => void;
    const ready = new Promise<KafkaActor>((r) => { resolve = r; });
    const kafkaOptions = KafkaOptions.create()
      .withBrokers(['ctor:9092']);  // ctor wins
    sys.spawnAnonymous(() => {
      const actor = new KafkaActor(kafkaOptions);
      // We'll never actually try to connect — kafkajs isn't installed.
      // Override preStart to swallow the connect error after options
      // resolution so the test can inspect them.
      const orig = actor.preStart.bind(actor);
      actor.preStart = async (): Promise<void> => {
        try { await orig(); } catch { /* ignored — kafkajs missing */ }
        captured = actor;
        resolve(actor);
      };
      return actor as unknown as Actor<unknown>;
    });
    // `ready` resolves in the statement after `captured = actor`, so there is
    // nothing left to wait for once it settles.
    await ready;
    expect(captured).not.toBeNull();
    const options = (captured as unknown as { options: { brokers: string[]; clientId?: string } }).options;
    // Constructor `brokers` override takes precedence.
    expect(options.brokers).toEqual(['ctor:9092']);
    // `clientId` only set in HOCON, so it propagates.
    expect(options.clientId).toBe('from-cfg');
    await sys.terminate();
  });
});
