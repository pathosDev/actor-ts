import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Props } from '../../../../../src/Props.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { MqttOptions, type MqttOptionsType } from '../../../../../src/io/broker/MqttOptions.js';
import { mqttJsonCodec } from '../../../../../src/io/broker/MqttCodec.js';
import {
  MqttActor,
  type MqttModuleLike,
} from '../../../../../src/io/broker/MqttActor.js';
import type { MqttMessage } from '../../../../../src/io/broker/MqttMessages.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('MqttOptions builder', () => {
  test('each withX sets the right options key', () => {
    const codec = mqttJsonCodec();
    const resolved = MqttOptions.create()
      .withBrokerUrl('mqtt://host:1883')
      .withClientId('cid')
      .withCredentials('user', 'pass')
      .withQos(2)
      .withWill({ topic: 'down', payload: 'bye' })
      .withCleanSession(false)
      .withKeepAlive(45)
      .withProtocolVersion(5)
      .withCodec(codec)
      .withReconnect({ initialDelayMs: 5 })
      .withCircuitBreaker(3, 1000)
      .withOutboundBuffer(50)
      .build();

    expect(resolved.brokerUrl).toBe('mqtt://host:1883');
    expect(resolved.clientId).toBe('cid');
    expect(resolved.credentials).toEqual({ username: 'user', password: 'pass' });
    expect(resolved.qos).toBe(2);
    expect(resolved.will).toEqual({ topic: 'down', payload: 'bye' });
    expect(resolved.cleanSession).toBe(false);
    expect(resolved.keepAlive).toBe(45);
    expect(resolved.protocolVersion).toBe(5);
    expect(resolved.codec).toBe(codec);
    expect(resolved.reconnect).toEqual({ initialDelayMs: 5 });
    expect(resolved.circuitBreaker).toEqual({ failureThreshold: 3, resetMs: 1000 });
    expect(resolved.outboundBuffer).toBe(50);
  });

  test('chaining mutates and returns the same instance', () => {
    const builder = MqttOptions.create();
    const b2 = builder.withClientId('x');
    expect(b2).toBe(builder);
  });

  test('build() returns an independent copy', () => {
    const builder = MqttOptions.create().withClientId('a');
    const snap = builder.build();
    builder.withClientId('b');
    expect(snap.clientId).toBe('a'); // snapshot not mutated by later chaining
    expect(builder.build().clientId).toBe('b');
  });

  test('withCleanSession() defaults to true', () => {
    expect(MqttOptions.create().withCleanSession().build().cleanSession).toBe(true);
  });
});

/* ------------------- merge precedence (builder > HOCON > defaults) --- */

class ProbeActor extends MqttActor {
  constructor(options: MqttOptions) { super(options); }
  protected override mqttModule(): Promise<MqttModuleLike> {
    // Minimal fake module that connects immediately.
    const client = {
      on() {}, once(ev: string, cb: () => void) { if (ev === 'connect') setTimeout(cb, 0); },
      removeAllListeners() {}, publish() {}, subscribe() {}, unsubscribe() {}, end(_f?: unknown, _o?: unknown, cb?: () => void) { cb?.(); },
    };
    return Promise.resolve({ connect: () => client } as unknown as MqttModuleLike);
  }
  override onMessage(_msg: MqttMessage): void {}
  get resolved(): MqttOptionsType { return this.options; }
}

describe('MqttOptions HOCON merge precedence', () => {
  test('constructor (builder) > HOCON > built-in defaults', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          io: { broker: { mqtt: {
            brokerUrl: 'mqtt://from-hocon:1883',
            clientId: 'hocon-client',
            keepAlive: 30,
          } } },
        },
      });
    const sys = ActorSystem.create('mqtt-opts-merge', sysOptions);
    try {
      // Builder overrides clientId; HOCON supplies brokerUrl + keepAlive;
      // cleanSession falls through to the built-in default (true).
      const mqttOptions = MqttOptions.create()
        .withClientId('ctor-client');
      const actor = new ProbeActor(mqttOptions);
      sys.spawn(Props.create(() => actor), 'probe');
      await sleep(30);
      const resolved = actor.resolved;
      expect(resolved.clientId).toBe('ctor-client');            // builder wins
      expect(resolved.brokerUrl).toBe('mqtt://from-hocon:1883'); // HOCON supplies
      expect(resolved.keepAlive).toBe(30);                       // HOCON supplies
      expect(resolved.cleanSession).toBe(true);                  // built-in default
    } finally {
      await sys.terminate();
    }
  });
});
