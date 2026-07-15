import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Props } from '../../../../../src/Props.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import {
  MqttOptions,
  MqttOptionsValidator,
  type MqttOptionsType,
} from '../../../../../src/io/broker/MqttOptions.js';
import { OptionsError } from '../../../../../src/util/OptionsValidator.js';
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

/* ---------------------------- value validation ----------------------- */

describe('MqttOptionsValidator (direct)', () => {
  const validate = (s: Partial<MqttOptionsType>): void => new MqttOptionsValidator().validate(s);

  test('accepts valid boundary values', () => {
    expect(() => validate({ brokerUrl: 'mqtts://h:8883', qos: 0, protocolVersion: 4, keepAlive: 0 })).not.toThrow();
    expect(() => validate({ brokerUrl: 'ws://h/mqtt', qos: 2, protocolVersion: 5, keepAlive: 60 })).not.toThrow();
  });

  test('rejects an out-of-range qos', () => {
    expect(() => validate({ qos: 7 as unknown as 0 })).toThrow(OptionsError);
  });

  test('rejects an unsupported protocolVersion', () => {
    expect(() => validate({ protocolVersion: 6 as unknown as 4 })).toThrow(
      'MqttOptions: protocolVersion must be one of 4, 5 (got 6)',
    );
  });

  test('rejects a negative keepAlive', () => {
    expect(() => validate({ keepAlive: -1 })).toThrow(OptionsError);
  });

  test('rejects a brokerUrl with the wrong protocol', () => {
    expect(() => validate({ brokerUrl: 'http://h:1883' })).toThrow(OptionsError);
  });

  test('rejects a negative outboundBuffer (common broker field)', () => {
    expect(() => validate({ outboundBuffer: -1 })).toThrow(/outboundBuffer/);
  });

  test('an unset field passes', () => {
    expect(() => validate({ brokerUrl: 'mqtt://h:1883' })).not.toThrow();
  });
});

describe('MqttOptions validation fires at actor start (all input paths)', () => {
  // preStart throws are caught by supervision; wrap preStart to observe them.
  async function captureStart(settings: MqttOptions, hocon?: object): Promise<Error | null> {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig(hocon ?? {});
    const sys = ActorSystem.create('mqtt-opts-validate', sysOptions);
    let captured: Error | null = null;
    try {
      const actor = new ProbeActor(settings);
      const orig = actor.preStart.bind(actor);
      actor.preStart = async (): Promise<void> => {
        try { await orig(); }
        catch (e) { captured = e as Error; }
      };
      sys.spawn(Props.create(() => actor), 'probe');
      await sleep(30);
    } finally {
      await sys.terminate();
    }
    return captured;
  }

  test('plain-object path: invalid qos throws OptionsError', async () => {
    const err = await captureStart({ brokerUrl: 'mqtt://h:1883', qos: 7 as unknown as 0 });
    expect(err).toBeInstanceOf(OptionsError);
    expect((err as OptionsError).field).toBe('qos');
  });

  test('builder path: negative keepAlive throws OptionsError', async () => {
    const mqttOptions = MqttOptions.create()
      .withBrokerUrl('mqtt://h:1883')
      .withKeepAlive(-1);
    const err = await captureStart(mqttOptions);
    expect(err).toBeInstanceOf(OptionsError);
    expect((err as OptionsError).field).toBe('keepAlive');
  });

  test('HOCON path: invalid protocolVersion throws OptionsError', async () => {
    const err = await captureStart({}, {
      'actor-ts': {
        io: { broker: { mqtt: { brokerUrl: 'mqtt://h:1883', protocolVersion: 6 } } },
      },
    });
    expect(err).toBeInstanceOf(OptionsError);
    expect((err as OptionsError).field).toBe('protocolVersion');
  });

  test('a valid configuration starts without error', async () => {
    const mqttOptions = MqttOptions.create()
      .withBrokerUrl('mqtt://h:1883')
      .withQos(1)
      .withProtocolVersion(5);
    const err = await captureStart(mqttOptions);
    expect(err).toBeNull();
  });
});
