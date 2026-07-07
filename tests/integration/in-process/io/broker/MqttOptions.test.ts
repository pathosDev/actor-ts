import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Props } from '../../../../../src/Props.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { MqttOptions } from '../../../../../src/io/broker/MqttOptions.js';
import { mqttJsonCodec } from '../../../../../src/io/broker/MqttCodec.js';
import {
  MqttActor,
  type MqttActorSettings,
  type MqttModuleLike,
} from '../../../../../src/io/broker/MqttActor.js';
import type { MqttMessage } from '../../../../../src/io/broker/MqttMessages.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('MqttOptions builder', () => {
  test('each withX sets the right settings key', () => {
    const codec = mqttJsonCodec();
    const s = MqttOptions.create()
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

    expect(s.brokerUrl).toBe('mqtt://host:1883');
    expect(s.clientId).toBe('cid');
    expect(s.credentials).toEqual({ username: 'user', password: 'pass' });
    expect(s.qos).toBe(2);
    expect(s.will).toEqual({ topic: 'down', payload: 'bye' });
    expect(s.cleanSession).toBe(false);
    expect(s.keepAlive).toBe(45);
    expect(s.protocolVersion).toBe(5);
    expect(s.codec).toBe(codec);
    expect(s.reconnect).toEqual({ initialDelayMs: 5 });
    expect(s.circuitBreaker).toEqual({ failureThreshold: 3, resetMs: 1000 });
    expect(s.outboundBuffer).toBe(50);
  });

  test('chaining mutates and returns the same instance', () => {
    const b = MqttOptions.create();
    const b2 = b.withClientId('x');
    expect(b2).toBe(b);
  });

  test('build() returns an independent copy', () => {
    const b = MqttOptions.create().withClientId('a');
    const snap = b.build();
    b.withClientId('b');
    expect(snap.clientId).toBe('a'); // snapshot not mutated by later chaining
    expect(b.build().clientId).toBe('b');
  });

  test('withCleanSession() defaults to true', () => {
    expect(MqttOptions.create().withCleanSession().build().cleanSession).toBe(true);
  });
});

/* ------------------- merge precedence (builder > HOCON > defaults) --- */

class ProbeActor extends MqttActor {
  constructor(settings: MqttOptions) { super(settings); }
  protected override mqttModule(): Promise<MqttModuleLike> {
    // Minimal fake module that connects immediately.
    const client = {
      on() {}, once(ev: string, cb: () => void) { if (ev === 'connect') setTimeout(cb, 0); },
      removeAllListeners() {}, publish() {}, subscribe() {}, unsubscribe() {}, end(_f?: unknown, _o?: unknown, cb?: () => void) { cb?.(); },
    };
    return Promise.resolve({ connect: () => client } as unknown as MqttModuleLike);
  }
  override onMessage(_msg: MqttMessage): void {}
  get resolved(): MqttActorSettings { return this.settings; }
}

describe('MqttOptions HOCON merge precedence', () => {
  test('constructor (builder) > HOCON > built-in defaults', async () => {
    const sys = ActorSystem.create('mqtt-opts-merge', ActorSystemOptions.create()
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
      }));
    try {
      // Builder overrides clientId; HOCON supplies brokerUrl + keepAlive;
      // cleanSession falls through to the built-in default (true).
      const actor = new ProbeActor(MqttOptions.create().withClientId('ctor-client'));
      sys.spawn(Props.create(() => actor), 'probe');
      await sleep(30);
      const s = actor.resolved;
      expect(s.clientId).toBe('ctor-client');            // builder wins
      expect(s.brokerUrl).toBe('mqtt://from-hocon:1883'); // HOCON supplies
      expect(s.keepAlive).toBe(30);                       // HOCON supplies
      expect(s.cleanSession).toBe(true);                  // built-in default
    } finally {
      await sys.terminate();
    }
  });
});
