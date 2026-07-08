import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Actor } from '../../../../../src/Actor.js';
import { Props } from '../../../../../src/Props.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import {
  MqttActor,
  buildPublishProperties,
  matchesMqttPattern,
  type MqttClientLike,
  type MqttInboundPacketLike,
  type MqttModuleLike,
  type MqttPublish,
} from '../../../../../src/io/broker/MqttActor.js';
import { MqttOptions, type MqttOptionsType } from '../../../../../src/io/broker/MqttOptions.js';
import type { MqttDecodeError } from '../../../../../src/io/broker/MqttCodec.js';
import type { MqttMessage, MqttQos, MqttRef } from '../../../../../src/io/broker/MqttMessages.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

/* ----------------------- matchesMqttPattern ------------------------ */

describe('matchesMqttPattern', () => {
  test('exact-match topics', () => {
    expect(matchesMqttPattern('a/b', 'a/b')).toBe(true);
    expect(matchesMqttPattern('a/b', 'a/c')).toBe(false);
    expect(matchesMqttPattern('a/b', 'a/b/c')).toBe(false);
  });

  test('+ wildcard matches a single segment', () => {
    expect(matchesMqttPattern('a/+/c', 'a/x/c')).toBe(true);
    expect(matchesMqttPattern('a/+/c', 'a/c')).toBe(false);
    expect(matchesMqttPattern('a/+/c', 'a/x/y/c')).toBe(false);
    expect(matchesMqttPattern('+/+', 'x/y')).toBe(true);
  });

  test('# wildcard matches the remaining segments', () => {
    expect(matchesMqttPattern('a/#', 'a/b/c/d')).toBe(true);
    expect(matchesMqttPattern('a/#', 'a')).toBe(true);
    expect(matchesMqttPattern('#', 'anything/at/all')).toBe(true);
  });
});

/* --------------------------- fake mqtt client ----------------------- */

class FakeMqttClient implements MqttClientLike {
  readonly subscribes: Array<{ topic: string; qos: number }> = [];
  readonly unsubscribes: string[] = [];
  readonly publishes: Array<{ topic: string; payload: string | Uint8Array; qos: number; retain: boolean }> = [];

  private msgCbs: Array<(t: string, p: Uint8Array, pk?: MqttInboundPacketLike) => void> = [];
  private closeCbs: Array<() => void> = [];
  private errCbs: Array<(e: Error) => void> = [];
  private connectCbs: Array<() => void> = [];
  private connectErrCbs: Array<(e: Error) => void> = [];

  on(event: 'message' | 'error' | 'close', cb: (...args: never[]) => void): void {
    if (event === 'message') this.msgCbs.push(cb as never);
    else if (event === 'close') this.closeCbs.push(cb as never);
    else this.errCbs.push(cb as never);
  }
  once(event: 'connect' | 'error', cb: (...args: never[]) => void): void {
    if (event === 'connect') this.connectCbs.push(cb as never);
    else this.connectErrCbs.push(cb as never);
  }
  removeAllListeners(event?: string): void {
    if (event === 'error' || event === undefined) { this.errCbs = []; this.connectErrCbs = []; }
    if (event === undefined) { this.msgCbs = []; this.closeCbs = []; this.connectCbs = []; }
  }
  publish(topic: string, payload: string | Uint8Array, opts: { qos: MqttQos; retain: boolean }, cb?: (err?: Error) => void): void {
    this.publishes.push({ topic, payload, qos: opts.qos, retain: opts.retain });
    cb?.();
  }
  subscribe(topic: string, opts: { qos: MqttQos }, cb?: (err?: Error) => void): void {
    this.subscribes.push({ topic, qos: opts.qos });
    cb?.();
  }
  unsubscribe(topic: string, _opts: undefined, cb?: (err?: Error) => void): void {
    this.unsubscribes.push(topic);
    cb?.();
  }
  end(_force?: boolean, _opts?: object, cb?: () => void): void { cb?.(); }

  fireConnect(): void { for (const cb of [...this.connectCbs]) cb(); }
  fireMessage(topic: string, payload: Uint8Array, packet?: MqttInboundPacketLike): void {
    for (const cb of [...this.msgCbs]) cb(topic, payload, packet);
  }
  fireClose(): void { for (const cb of [...this.closeCbs]) cb(); }
}

class FakeMqttModule {
  readonly clients: FakeMqttClient[] = [];
  autoConnect = true;
  connect(_url: string, _opts?: unknown): FakeMqttClient {
    const c = new FakeMqttClient();
    this.clients.push(c);
    if (this.autoConnect) setTimeout(() => c.fireConnect(), 0);
    return c;
  }
  last(): FakeMqttClient { return this.clients[this.clients.length - 1]!; }
}

/* --------------------------- test actor ----------------------------- */

interface TestActorOpts<T> {
  options?: MqttOptions;
  module?: FakeMqttModule;
  ctorSubs?: Array<{ topic: string; qos?: MqttQos; target?: ActorRef<MqttMessage<T>> }>;
}

class TestMqttActor<T = unknown, TSelf = never> extends MqttActor<T, TSelf> {
  readonly module: FakeMqttModule;
  readonly inbound: MqttMessage<T>[] = [];
  readonly selfMsgs: TSelf[] = [];
  readonly decodeErrors: Array<{ error: MqttDecodeError; msg: MqttMessage<T> }> = [];
  connectedCount = 0;
  disconnectedCount = 0;

  constructor(opts: TestActorOpts<T> = {}) {
    super(opts.options ?? MqttOptions.create());
    this.module = opts.module ?? new FakeMqttModule();
    for (const s of opts.ctorSubs ?? []) this.subscribe(s.topic, { qos: s.qos, target: s.target });
  }

  protected override mqttModule(): Promise<MqttModuleLike> {
    return Promise.resolve(this.module as unknown as MqttModuleLike);
  }

  override onMessage(msg: MqttMessage<T>): void {
    // Touch entity() so a malformed payload surfaces to onInvalidMessage.
    if (this.decodeOnReceive) msg.payload.entity();
    this.inbound.push(msg);
  }
  decodeOnReceive = false;

  protected override onConnected(): void { this.connectedCount++; }
  protected override onDisconnected(): void { this.disconnectedCount++; }
  protected override onInvalidMessage(error: MqttDecodeError, msg: MqttMessage<T>): void {
    this.decodeErrors.push({ error, msg });
  }
  protected override onSelfMessage(msg: TSelf): void { this.selfMsgs.push(msg); }

  // Public test wrappers for the protected API.
  doSubscribe(topic: string, opts?: { qos?: MqttQos; target?: ActorRef<MqttMessage<T>> }): void { this.subscribe(topic, opts); }
  doUnsubscribe(topic: string, opts?: { target?: ActorRef<MqttMessage<T>> }): void { this.unsubscribe(topic, opts); }
  doPublish(topic: string, payload: unknown, opts?: { qos?: MqttQos; retain?: boolean }): boolean {
    return (this.publish as (t: string, p: unknown, o?: unknown) => boolean)(topic, payload, opts);
  }
  encodeEntity(value: unknown): Uint8Array { return this.codec().encode(value); }
  get resolvedOptions(): MqttOptionsType { return this.options; }
}

let sysCounter = 0;
function makeSystem(): ActorSystem {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(`mqtt-unit-${++sysCounter}`, sysOptions);
}

async function boot<T, TSelf>(
  sys: ActorSystem,
  actor: TestMqttActor<T, TSelf>,
  name = 'mqtt',
): Promise<MqttRef<T, TSelf>> {
  const ref = sys.spawn(Props.create(() => actor), name);
  await sleep(30); // let preStart connect (autoConnect fires on the next tick)
  return ref as MqttRef<T, TSelf>;
}

/** Collects fanned-out MqttMessages for external-target assertions. */
class InboxActor<T> extends Actor<MqttMessage<T>> {
  readonly received: MqttMessage<T>[] = [];
  override onReceive(m: MqttMessage<T>): void { this.received.push(m); }
}

/* --------------------------- construction --------------------------- */

describe('MqttActor construction', () => {
  test('constructing an actor does not pull in the mqtt peer-dep', () => {
    const mqttOptions = MqttOptions.create()
      .withBrokerUrl('mqtt://localhost');
    const a = new TestMqttActor({ options: mqttOptions });
    expect(a).toBeInstanceOf(MqttActor);
  });
});

/* ------------------------ pending-sub flush ------------------------- */

describe('MqttActor subscription flush + defaults', () => {
  test('constructor subscribe is applied to the broker on connect with defaultQos', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x')
        .withQos(1);
      const actor = new TestMqttActor({
        options: mqttOptions,
        ctorSubs: [{ topic: 'a/+' }],
      });
      await boot(sys, actor);
      expect(actor.module.last().subscribes).toEqual([{ topic: 'a/+', qos: 1 }]);
    } finally {
      await sys.terminate();
    }
  });

  test('per-subscription qos overrides defaultQos', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x')
        .withQos(0);
      const actor = new TestMqttActor({
        options: mqttOptions,
        ctorSubs: [{ topic: 'a/#', qos: 2 }],
      });
      await boot(sys, actor);
      expect(actor.module.last().subscribes).toEqual([{ topic: 'a/#', qos: 2 }]);
    } finally {
      await sys.terminate();
    }
  });
});

/* --------------------------- inbound routing ------------------------ */

describe('MqttActor inbound routing', () => {
  test('own subscription delivers a wrapped, decodable payload to onMessage', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor<{ v: number }>({
        options: mqttOptions,
        ctorSubs: [{ topic: 'sensors/+/temp' }],
      });
      await boot(sys, actor);
      actor.module.last().fireMessage('sensors/1/temp', enc.encode('{"v":21}'));
      await sleep(20);
      expect(actor.inbound).toHaveLength(1);
      expect(actor.inbound[0]!.topic).toBe('sensors/1/temp');
      const decoded = actor.inbound[0]!.payload.entity();
      expect(decoded).toEqual({ v: 21 });
    } finally {
      await sys.terminate();
    }
  });

  test('external target receives the message; overlapping patterns dedupe', async () => {
    const sys = makeSystem();
    try {
      const inbox = new InboxActor<unknown>();
      const inboxRef = sys.spawn(Props.create(() => inbox), 'inbox') as ActorRef<MqttMessage<unknown>>;
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor({
        options: mqttOptions,
        ctorSubs: [
          { topic: 'a/#', target: inboxRef },
          { topic: 'a/b', target: inboxRef }, // overlaps a/# for topic a/b
        ],
      });
      await boot(sys, actor);
      actor.module.last().fireMessage('a/b', enc.encode('hi'));
      await sleep(20);
      // Two matching patterns, one ref → delivered exactly once.
      expect(inbox.received).toHaveLength(1);
      expect(inbox.received[0]!.payload.text()).toBe('hi');
      // No own-delivery was configured.
      expect(actor.inbound).toHaveLength(0);
    } finally {
      await sys.terminate();
    }
  });

  test('external subscribe command with no target routes to onMessage', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor({ options: mqttOptions });
      const ref = await boot(sys, actor);
      ref.tell({ kind: 'subscribe', topic: 'x/#' });
      await sleep(20);
      expect(actor.module.last().subscribes.map((s) => s.topic)).toContain('x/#');
      actor.module.last().fireMessage('x/y', enc.encode('yo'));
      await sleep(20);
      expect(actor.inbound.map((m) => m.topic)).toEqual(['x/y']);
    } finally {
      await sys.terminate();
    }
  });
});

/* ----------------------- reconnect / disconnected ------------------- */

describe('MqttActor reconnect + subscription persistence', () => {
  test('subscribe received while disconnected reaches the broker on reconnect (bug #2)', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x')
        .withReconnect({ initialDelayMs: 10 });
      const actor = new TestMqttActor({
        options: mqttOptions,
      });
      const ref = await boot(sys, actor);
      // Drop the connection → disconnected, reconnect scheduled.
      actor.module.last().fireClose();
      // Subscribe arrives while disconnected: recorded, not yet on the broker.
      ref.tell({ kind: 'subscribe', topic: 'late/#', qos: 1 });
      await sleep(60); // let the reconnect fire + apply the registry
      const latest = actor.module.last();
      expect(actor.module.clients.length).toBeGreaterThanOrEqual(2);
      expect(latest.subscribes).toEqual([{ topic: 'late/#', qos: 1 }]);
    } finally {
      await sys.terminate();
    }
  });

  test('runtime subscription is re-applied on the broker after a reconnect (bug #1)', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x')
        .withQos(1)
        .withReconnect({ initialDelayMs: 10 });
      const actor = new TestMqttActor({
        options: mqttOptions,
      });
      const ref = await boot(sys, actor);
      ref.tell({ kind: 'subscribe', topic: 'run/#' });
      await sleep(20);
      expect(actor.module.last().subscribes.map((s) => s.topic)).toContain('run/#');
      // Reconnect → the new client must re-receive the runtime subscription.
      actor.module.last().fireClose();
      await sleep(60);
      const latest = actor.module.last();
      expect(actor.module.clients.length).toBeGreaterThanOrEqual(2);
      expect(latest.subscribes.map((s) => s.topic)).toContain('run/#');
    } finally {
      await sys.terminate();
    }
  });

  test('onConnected / onDisconnected hooks fire across a reconnect', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x')
        .withReconnect({ initialDelayMs: 10 });
      const actor = new TestMqttActor({
        options: mqttOptions,
      });
      await boot(sys, actor);
      expect(actor.connectedCount).toBe(1);
      actor.module.last().fireClose();
      await sleep(60);
      expect(actor.disconnectedCount).toBeGreaterThanOrEqual(1);
      expect(actor.connectedCount).toBeGreaterThanOrEqual(2);
    } finally {
      await sys.terminate();
    }
  });
});

/* --------------------------- Terminated cleanup --------------------- */

describe('MqttActor deathwatch cleanup (bug #3)', () => {
  test('stopping an external target prunes it and unsubscribes when the pattern empties', async () => {
    const sys = makeSystem();
    try {
      const inbox = new InboxActor<unknown>();
      const inboxRef = sys.spawn(Props.create(() => inbox), 'inbox-term') as ActorRef<MqttMessage<unknown>>;
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor({
        options: mqttOptions,
        ctorSubs: [{ topic: 'watched/#', target: inboxRef }],
      });
      await boot(sys, actor);
      expect(actor.module.last().subscribes.map((s) => s.topic)).toContain('watched/#');
      // Stop the target → Terminated flows to the actor → registry pruned.
      inboxRef.stop();
      await sleep(40);
      expect(actor.module.last().unsubscribes).toContain('watched/#');
      // A subsequent message must not reach the stopped inbox.
      actor.module.last().fireMessage('watched/x', enc.encode('gone'));
      await sleep(20);
      expect(inbox.received).toHaveLength(0);
    } finally {
      await sys.terminate();
    }
  });
});

/* --------------------------- decode errors -------------------------- */

describe('MqttActor onInvalidMessage', () => {
  test('malformed payload in onMessage routes to onInvalidMessage without restarting', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor({
        options: mqttOptions,
        ctorSubs: [{ topic: 'j/#' }],
      });
      actor.decodeOnReceive = true;
      await boot(sys, actor);
      actor.module.last().fireMessage('j/1', enc.encode('{ broken'));
      await sleep(20);
      expect(actor.decodeErrors).toHaveLength(1);
      expect(actor.decodeErrors[0]!.error.topic).toBe('j/1');
      // Actor is still alive and processing: a valid message still lands.
      actor.decodeOnReceive = false;
      actor.module.last().fireMessage('j/2', enc.encode('"ok"'));
      await sleep(20);
      expect(actor.inbound.map((m) => m.topic)).toContain('j/2');
    } finally {
      await sys.terminate();
    }
  });
});

/* --------------------------- self messages -------------------------- */

describe('MqttActor onSelfMessage', () => {
  test('non-command app messages route to onSelfMessage; commands still dispatch', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor<unknown, { kind: 'tick'; n: number }>({
        options: mqttOptions,
      });
      const ref = await boot(sys, actor);
      ref.tell({ kind: 'tick', n: 7 });
      ref.tell({ kind: 'subscribe', topic: 's/#' });
      await sleep(20);
      expect(actor.selfMsgs).toEqual([{ kind: 'tick', n: 7 }]);
      expect(actor.module.last().subscribes.map((s) => s.topic)).toContain('s/#');
    } finally {
      await sys.terminate();
    }
  });
});

/* --------------------------- publish matrix ------------------------- */

describe('MqttActor publish', () => {
  test('string + Uint8Array pass through raw; objects are codec-encoded', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor({ options: mqttOptions });
      await boot(sys, actor);
      actor.doPublish('t/str', 'hello');
      actor.doPublish('t/bin', enc.encode('bin'));
      actor.doPublish('t/obj', { a: 1 });
      await sleep(20);
      const byTopic = new Map(actor.module.last().publishes.map((p) => [p.topic, p.payload]));
      expect(byTopic.get('t/str')).toBe('hello');
      expect(new TextDecoder().decode(byTopic.get('t/bin') as Uint8Array)).toBe('bin');
      expect(new TextDecoder().decode(byTopic.get('t/obj') as Uint8Array)).toBe('{"a":1}');
    } finally {
      await sys.terminate();
    }
  });

  test('escape hatch: encode a bare string as a JSON entity', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor({ options: mqttOptions });
      await boot(sys, actor);
      actor.doPublish('t/entity', actor.encodeEntity('pong'));
      await sleep(20);
      const p = actor.module.last().publishes.find((x) => x.topic === 't/entity')!;
      expect(new TextDecoder().decode(p.payload as Uint8Array)).toBe('"pong"');
    } finally {
      await sys.terminate();
    }
  });

  test('encode failure drops the publish and returns false', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x');
      const actor = new TestMqttActor({ options: mqttOptions });
      await boot(sys, actor);
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const ok = actor.doPublish('t/bad', circular);
      await sleep(20);
      expect(ok).toBe(false);
      expect(actor.module.last().publishes.find((x) => x.topic === 't/bad')).toBeUndefined();
    } finally {
      await sys.terminate();
    }
  });

  test('publishes while disconnected are buffered and flushed on reconnect in order', async () => {
    const sys = makeSystem();
    try {
      const mqttOptions = MqttOptions.create()
        .withBrokerUrl('mqtt://x')
        .withReconnect({ initialDelayMs: 10 });
      const actor = new TestMqttActor({
        options: mqttOptions,
      });
      const ref = await boot(sys, actor);
      actor.module.last().fireClose();
      // Buffered while disconnected.
      ref.tell({ kind: 'publish', publish: { topic: 'buf/1', payload: 'one' } });
      ref.tell({ kind: 'publish', publish: { topic: 'buf/2', payload: 'two' } });
      await sleep(60);
      const flushed = actor.module.last().publishes.filter((p) => p.topic.startsWith('buf/'));
      expect(flushed.map((p) => p.topic)).toEqual(['buf/1', 'buf/2']);
    } finally {
      await sys.terminate();
    }
  });
});

/* ------------------- MQTT 5.0 publish-properties helper (#13) -------- */

describe('buildPublishProperties (MQTT 5.0)', () => {
  test('returns undefined on protocolVersion=4 even with userProperties set', () => {
    const p: MqttPublish = { topic: 'sensor/1', payload: 'x', userProperties: { tenant: 't1' } };
    expect(buildPublishProperties(p, 4)).toBeUndefined();
  });

  test('returns undefined when no v5 fields are set, regardless of version', () => {
    const p: MqttPublish = { topic: 'sensor/1', payload: 'x' };
    expect(buildPublishProperties(p, 4)).toBeUndefined();
    expect(buildPublishProperties(p, 5)).toBeUndefined();
  });

  test('returns undefined when userProperties is an empty object on v5', () => {
    const p: MqttPublish = { topic: 'sensor/1', payload: 'x', userProperties: {} };
    expect(buildPublishProperties(p, 5)).toBeUndefined();
  });

  test('returns a properties block on v5 with populated userProperties', () => {
    const userProperties = { tenant: 't1', priority: ['high', 'audit'] };
    const p: MqttPublish = { topic: 'sensor/1', payload: 'x', userProperties };
    expect(buildPublishProperties(p, 5)).toEqual({ userProperties });
  });

  test('preserves multi-valued properties (string[]) verbatim', () => {
    const p: MqttPublish = { topic: 'sensor/1', payload: 'x', userProperties: { tag: ['alpha', 'beta', 'gamma'] } };
    const props = buildPublishProperties(p, 5);
    expect(props?.userProperties?.tag).toEqual(['alpha', 'beta', 'gamma']);
  });
});
