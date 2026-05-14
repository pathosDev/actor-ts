/**
 * Phase 2 actors — Kafka / AMQP / gRPC — smoke tests that don't need the
 * peer deps installed.  We verify:
 *   1. Importing the modules doesn't crash.
 *   2. Constructing actors stays sync (peer-dep loaded lazily).
 *   3. Settings resolution + required-field validation works.
 *
 * Live integration tests against real brokers / a real gRPC loop run
 * in a separate, optional file (out of scope here).
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import { Actor } from '../../../../src/Actor.js';
import { KafkaActor } from '../../../../src/io/broker/KafkaActor.js';
import { AmqpActor } from '../../../../src/io/broker/AmqpActor.js';
import { GrpcClientActor } from '../../../../src/io/broker/GrpcClientActor.js';
import { GrpcServerActor } from '../../../../src/io/broker/GrpcServerActor.js';
import { BrokerSettingsError } from '../../../../src/io/broker/BrokerSettings.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

function makeSys(name = 'phase2'): ActorSystem {
  return ActorSystem.create(name, { logger: new NoopLogger(), logLevel: LogLevel.Off });
}

describe('Phase 2 actors — construction is lazy', () => {
  test('KafkaActor constructs without loading kafkajs', () => {
    const a = new KafkaActor({ brokers: ['localhost:9092'] });
    expect(a).toBeInstanceOf(KafkaActor);
  });
  test('AmqpActor constructs without loading amqplib', () => {
    const a = new AmqpActor({ url: 'amqp://localhost' });
    expect(a).toBeInstanceOf(AmqpActor);
  });
  test('GrpcClientActor constructs without loading @grpc/grpc-js', () => {
    const a = new GrpcClientActor({
      protoPath: 'x.proto', packageName: 'x', serviceName: 'X', endpoint: 'localhost:1',
    });
    expect(a).toBeInstanceOf(GrpcClientActor);
  });
  test('GrpcServerActor constructs without loading @grpc/grpc-js', () => {
    const a = new GrpcServerActor({
      protoPath: 'x.proto', packageName: 'x', serviceName: 'X',
      bind: '0.0.0.0:0', handlers: {},
    });
    expect(a).toBeInstanceOf(GrpcServerActor);
  });
});

describe('Phase 2 actors — settings validation', () => {
  test('KafkaActor without `brokers` raises BrokerSettingsError', async () => {
    const sys = makeSys('kafka-validate');
    let captured: Error | null = null;
    sys.spawnAnonymous(Props.create(() => {
      const a = new KafkaActor({});
      const orig = a.preStart.bind(a);
      a.preStart = async (): Promise<void> => {
        try { await orig(); }
        catch (e) { captured = e as Error; }
      };
      return a as unknown as Actor<unknown>;
    }));
    await sleep(30);
    expect(captured).toBeInstanceOf(BrokerSettingsError);
    expect((captured as unknown as Error).message).toContain('brokers');
    await sys.terminate();
  });

  test('GrpcClientActor without endpoint raises BrokerSettingsError', async () => {
    const sys = makeSys('grpc-validate');
    let captured: Error | null = null;
    sys.spawnAnonymous(Props.create(() => {
      const a = new GrpcClientActor({
        protoPath: 'x.proto', packageName: 'x', serviceName: 'X',
        // endpoint missing
      });
      const orig = a.preStart.bind(a);
      a.preStart = async (): Promise<void> => {
        try { await orig(); }
        catch (e) { captured = e as Error; }
      };
      return a as unknown as Actor<unknown>;
    }));
    await sleep(30);
    expect(captured).toBeInstanceOf(BrokerSettingsError);
    expect((captured as unknown as Error).message).toContain('endpoint');
    await sys.terminate();
  });
});

describe('Phase 2 actors — settings precedence (constructor wins over HOCON)', () => {
  test('KafkaActor: constructor brokers override HOCON', async () => {
    const sys = ActorSystem.create('kafka-prec', {
      logger: new NoopLogger(), logLevel: LogLevel.Off,
      config: {
        'actor-ts': { io: { broker: { kafka: { brokers: ['hocon:9092'], clientId: 'from-cfg' } } } },
      },
    });
    let captured: KafkaActor | null = null;
    let resolve!: (a: KafkaActor) => void;
    const ready = new Promise<KafkaActor>((r) => { resolve = r; });
    sys.spawnAnonymous(Props.create(() => {
      const a = new KafkaActor({ brokers: ['ctor:9092'] });  // ctor wins
      // We'll never actually try to connect — kafkajs isn't installed.
      // Override preStart to swallow the connect error after settings
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
    const settings = (captured as unknown as { settings: { brokers: string[]; clientId?: string } }).settings;
    // Constructor `brokers` override takes precedence.
    expect(settings.brokers).toEqual(['ctor:9092']);
    // `clientId` only set in HOCON, so it propagates.
    expect(settings.clientId).toBe('from-cfg');
    await sys.terminate();
  });
});
