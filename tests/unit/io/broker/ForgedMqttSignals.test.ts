/**
 * An `MqttActor` signal is recognised by its mark, not by its `kind` alone.
 *
 * The actor's three internal signals — `mqtt-inbound`, `mqtt-connected` and
 * `mqtt-disconnected` — are told to its own mailbox by the connection code,
 * and each now has to carry the mark that only the constructors in
 * `MqttMessages.ts` put on it.  An `MqttActor` is an ordinary actor at an
 * ordinary `/user` path, so what a remote node addresses to that path reaches
 * it as a decoded body: a plain object with the peer's keys as its own, which
 * no decoder can give that mark.  Such a body is declined like any other
 * message none of the actor's kinds matched — it reaches `onSelfMessage`,
 * whose default makes it a dead letter naming the actor — and nothing else
 * about the actor changes.  The same requirement #1431 put on the WebSocket
 * hub's signals, and the class of defect #713 closed for the receptionist and
 * the singleton manager.
 *
 * Every test in the first group drives an actor with one real connection,
 * tells it a decoded body, then a barrier, and asserts once the barrier is
 * through — so the body has certainly been processed — that no hook ran,
 * nothing was fanned out, the actor is on its first incarnation with its one
 * connection, and the body came back as a dead letter.  The other groups pin
 * the other side: the real signals still drive the actor, and the documented
 * commands still work when they arrive as decoded bodies.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { DeadLetter } from '../../../../src/SystemMessages.js';
import { structuredCloneProblem } from '../../../../src/diagnostics/MessageBoundaryCheck.js';
import { MessageBoundaryOptions } from '../../../../src/diagnostics/MessageBoundaryOptions.js';
import {
  MqttActor,
  type MqttClientLike,
  type MqttInboundPacketLike,
  type MqttModuleLike,
} from '../../../../src/io/broker/MqttActor.js';
import { mqttJsonCodec } from '../../../../src/io/broker/MqttCodec.js';
import {
  MqttPayload,
  isMqttSignal,
  mqttConnectedSignal,
  mqttDisconnectedSignal,
  mqttInboundSignal,
  type MqttMessage,
  type MqttQos,
} from '../../../../src/io/broker/MqttMessages.js';
import { MqttOptions } from '../../../../src/io/broker/MqttOptions.js';
import { JsonSerializer } from '../../../../src/serialization/JsonSerializer.js';
import { TestKit } from '../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../src/testkit/TestKitOptions.js';
import type { TestProbe } from '../../../../src/testkit/TestProbe.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The one application message: once it is recorded, everything told before it has been processed. */
type BarrierMessage = { readonly kind: 'barrier' };

/** In-memory mqtt.js client: records what the actor asks of the broker, and fires what a broker would. */
class FakeMqttClient implements MqttClientLike {
  readonly subscribes: string[] = [];
  readonly unsubscribes: string[] = [];
  readonly publishes: string[] = [];
  private messageListeners: Array<(topic: string, payload: Uint8Array, packet?: MqttInboundPacketLike) => void> = [];
  private closeListeners: Array<() => void> = [];
  private connectListeners: Array<() => void> = [];

  on(event: 'message' | 'error' | 'close', listener: (...args: never[]) => void): void {
    if (event === 'message') this.messageListeners.push(listener as never);
    else if (event === 'close') this.closeListeners.push(listener as never);
  }
  once(event: 'connect' | 'error', listener: (...args: never[]) => void): void {
    if (event === 'connect') this.connectListeners.push(listener as never);
  }
  removeAllListeners(event?: string): void {
    if (event !== undefined) return;
    this.messageListeners = [];
    this.closeListeners = [];
    this.connectListeners = [];
  }
  publish(
    topic: string,
    payload: string | Uint8Array,
    _options: { qos: MqttQos; retain: boolean },
    callback?: (error?: Error) => void,
  ): void {
    this.publishes.push(`${topic}:${typeof payload === 'string' ? payload : decoder.decode(payload)}`);
    callback?.();
  }
  subscribe(topic: string, _options: { qos: MqttQos }, callback?: (error?: Error) => void): void {
    this.subscribes.push(topic);
    callback?.();
  }
  unsubscribe(topic: string, _options: undefined, callback?: (error?: Error) => void): void {
    this.unsubscribes.push(topic);
    callback?.();
  }
  end(_force?: boolean, _options?: object, callback?: () => void): void { callback?.(); }

  fireConnect(): void { for (const listener of [...this.connectListeners]) listener(); }
  fireMessage(topic: string, text: string): void {
    for (const listener of [...this.messageListeners]) listener(topic, encoder.encode(text), { qos: 0, retain: false });
  }
  fireClose(): void { for (const listener of [...this.closeListeners]) listener(); }
}

/** Hands out one client per connect and lets it connect on the next microtask. */
class FakeMqttModule {
  readonly clients: FakeMqttClient[] = [];
  connect(_url: string, _options?: unknown): FakeMqttClient {
    const client = new FakeMqttClient();
    this.clients.push(client);
    queueMicrotask(() => client.fireConnect());
    return client;
  }
  last(): FakeMqttClient { return this.clients[this.clients.length - 1]!; }
}

/** Shared across incarnations, so a restart shows up as a second start. */
type ActorRecord = {
  starts: number;
  connected: number;
  disconnects: unknown[];
  messages: string[];
  barriers: number;
};

/** Subscribed to `sensors/#` for itself; records every hook it is offered. */
class RecordingMqttActor extends MqttActor<unknown, BarrierMessage> {
  constructor(
    private readonly module: FakeMqttModule,
    private readonly record: ActorRecord,
  ) {
    const mqttOptions = MqttOptions.create()
      .withBrokerUrl('mqtt://broker.test')
      .withReconnect(false);
    super(mqttOptions);
    this.subscribe('sensors/#');
  }

  override async preStart(): Promise<void> {
    this.record.starts += 1;
    await super.preStart();
  }

  protected override mqttModule(): Promise<MqttModuleLike> {
    return Promise.resolve(this.module as unknown as MqttModuleLike);
  }

  override onMessage(message: MqttMessage<unknown>): void {
    // Reading the payload is the first thing a handler does with a message.
    this.record.messages.push(`${message.topic}:${message.payload.text()}`);
  }

  protected override onConnected(): void {
    this.record.connected += 1;
  }

  protected override onDisconnected(cause?: Error): void {
    this.record.disconnects.push(cause);
  }

  protected override onSelfMessage(message: BarrierMessage): void {
    match(message as unknown)
      .with({ kind: 'barrier' }, () => this.onBarrier())
      .otherwise((m) => this.onForeign(m));
  }

  private onBarrier(): void {
    this.record.barriers += 1;
  }

  /** Everything else keeps the default: a warn and a dead letter naming the actor. */
  private onForeign(message: unknown): void {
    super.onSelfMessage(message as BarrierMessage);
  }
}

const kits: TestKit[] = [];
afterEach(async () => {
  await Promise.all(kits.splice(0).map((kit) => kit.system.terminate()));
});

type Harness = {
  readonly kit: TestKit;
  readonly actor: ActorRef<unknown>;
  readonly module: FakeMqttModule;
  readonly record: ActorRecord;
  /** Attached to `sensors/#` by an external `subscribe`, so a fan-out would reach it. */
  readonly target: TestProbe;
  /** Subscribed to `DeadLetter` before anything was told. */
  readonly deadLetters: TestProbe;
};

async function harness(name: string): Promise<Harness> {
  // Off, unlike a TestKit's default: the structured-clone check reports every
  // real delivery here, because an inbound message carries its payload as an
  // `MqttPayload` instance — both on the actor's own `mqtt-inbound` signal and
  // on what it fans out.  That is a question about worker hops, not about
  // which bodies the actor takes for a signal.
  const boundaryOptions = MessageBoundaryOptions.create().withStructuredClone('off');
  const kitOptions = TestKitOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withMessageBoundary(boundaryOptions);
  const kit = TestKit.create(name, kitOptions);
  kits.push(kit);
  const module = new FakeMqttModule();
  const record: ActorRecord = { starts: 0, connected: 0, disconnects: [], messages: [], barriers: 0 };
  const actor = kit.system.spawn(() => new RecordingMqttActor(module, record), 'mqtt') as ActorRef<unknown>;
  await awaitCondition(() => record.connected === 1, {
    timeoutMs: 4_000,
    label: 'the real connection was announced to the actor',
  });
  const target = kit.createTestProbe();
  actor.tell({ kind: 'subscribe', topic: 'sensors/#', target });
  const deadLetters = kit.createTestProbe();
  kit.system.eventStream.subscribe(deadLetters, DeadLetter);
  const h: Harness = { kit, actor, module, record, target, deadLetters };
  await settle(h);
  return h;
}

/** A body exactly as the cluster hands one over: parsed from the wire, then told untyped. */
function forge(h: Harness, json: string): unknown {
  const body: unknown = JSON.parse(json);
  h.actor.tell(body);
  return body;
}

/** Returns once everything told before it has been processed — by whichever incarnation. */
async function settle(h: Harness): Promise<void> {
  const before = h.record.barriers;
  h.actor.tell({ kind: 'barrier' } satisfies BarrierMessage);
  await awaitCondition(() => h.record.barriers > before, {
    timeoutMs: 4_000,
    label: 'the barrier was processed',
  });
}

/** First incarnation, its one connection, no hook run, nothing fanned out. */
function expectUntouched(h: Harness): void {
  expect(h.record.starts).toBe(1);
  expect(h.module.clients).toHaveLength(1);
  expect(h.record.connected).toBe(1);
  expect(h.record.disconnects).toEqual([]);
  expect(h.record.messages).toEqual([]);
  expect(h.target.hasMessage()).toBe(false);
}

/** The body came back as a dead letter naming the actor — declined, not dispatched. */
async function expectDeclined(h: Harness, body: unknown): Promise<void> {
  const letter = await h.deadLetters.receiveOne(2_000) as DeadLetter;
  expect(letter.message).toBe(body);
  expect(letter.recipient.path.toString()).toBe(h.actor.path.toString());
}

/** A real message on the real connection still reaches the actor and the fan-out target. */
async function expectStillServing(h: Harness): Promise<void> {
  h.module.last().fireMessage('sensors/2', '21.5');
  await awaitCondition(() => h.record.messages.length > 0, {
    timeoutMs: 4_000,
    label: 'the real message reached onMessage',
  });
  expect(h.record.messages).toEqual(['sensors/2:21.5']);
  const fannedOut = await h.target.receiveOne(2_000) as MqttMessage<unknown>;
  expect(fannedOut.topic).toBe('sensors/2');
  expect(fannedOut.payload.text()).toBe('21.5');
  expect(h.record.starts).toBe(1);
}

describe('MqttActor declines a body that spells one of its signal kinds without the mark', () => {
  test('mqtt-inbound: no delivery, no fan-out, a dead letter', async () => {
    const h = await harness('mqtt-unmarked-inbound');
    const body = forge(
      h,
      '{"kind":"mqtt-inbound","message":{"topic":"sensors/1","payload":"99.9","qos":0,"retain":false}}',
    );
    await settle(h);

    expectUntouched(h);
    await expectDeclined(h, body);
    await expectStillServing(h);
  });

  test('mqtt-connected: onConnected does not run, a dead letter', async () => {
    const h = await harness('mqtt-unmarked-connected');
    const body = forge(h, '{"kind":"mqtt-connected"}');
    await settle(h);

    expectUntouched(h);
    await expectDeclined(h, body);
    await expectStillServing(h);
  });

  test('mqtt-disconnected: onDisconnected does not run, a dead letter', async () => {
    const h = await harness('mqtt-unmarked-disconnected');
    const body = forge(h, '{"kind":"mqtt-disconnected","cause":{"name":"Error","message":"connection lost"}}');
    await settle(h);

    expectUntouched(h);
    await expectDeclined(h, body);
    await expectStillServing(h);
  });
});

describe('the real signals still drive the actor', () => {
  test('a real connect runs onConnected once', async () => {
    const h = await harness('mqtt-real-connect');

    expectUntouched(h);
    expect(h.deadLetters.hasMessage()).toBe(false);
  });

  test('a real inbound message reaches onMessage and the fan-out target', async () => {
    const h = await harness('mqtt-real-inbound');

    await expectStillServing(h);
    expect(h.deadLetters.hasMessage()).toBe(false);
  });

  test('a real disconnect runs onDisconnected with its cause', async () => {
    const h = await harness('mqtt-real-disconnect');
    h.module.last().fireClose();
    await awaitCondition(() => h.record.disconnects.length > 0, {
      timeoutMs: 4_000,
      label: 'the real disconnect reached onDisconnected',
    });

    expect(h.record.disconnects).toHaveLength(1);
    const cause = h.record.disconnects[0];
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toBe('mqtt connection closed');
    expect(h.record.starts).toBe(1);
  });
});

describe('the mark', () => {
  const signals = (): Array<[string, object]> => [
    ['mqtt-inbound', mqttInboundSignal({
      topic: 'sensors/1',
      payload: new MqttPayload<unknown>(encoder.encode('21.5'), mqttJsonCodec(), 'sensors/1'),
      qos: 0,
      retain: false,
    })],
    ['mqtt-connected', mqttConnectedSignal()],
    ['mqtt-disconnected', mqttDisconnectedSignal(new Error('connection lost'))],
  ];

  test('every signal constructor sets it, and a copy through JSON does not keep it', () => {
    for (const [kind, signal] of signals()) {
      expect([kind, isMqttSignal(signal)]).toEqual([kind, true]);
      expect([kind, isMqttSignal(JSON.parse(JSON.stringify(signal)) as object)]).toEqual([kind, false]);
    }
  });

  test('is one symbol of this module, not one from the global registry', () => {
    for (const [kind, signal] of signals()) {
      const marks = Object.getOwnPropertySymbols(signal);
      expect([kind, marks.length]).toEqual([kind, 1]);
      expect([kind, Symbol.keyFor(marks[0]!)]).toEqual([kind, undefined]);
    }
  });

  // The inbound signal is left out: its `MqttPayload` is a class instance,
  // which the structured-clone check reports whatever the mark is.
  test('adds nothing the message boundary check reports, in its clone or its serializer round trip', () => {
    const serializer = new JsonSerializer();
    for (const [kind, signal] of signals().filter(([name]) => name !== 'mqtt-inbound')) {
      expect(structuredCloneProblem(signal), kind).toBeNull();
      expect(() => serializer.fromBinary(serializer.toBinary(signal), ''), kind).not.toThrow();
    }
  });
});

describe('the documented commands still work when they arrive as decoded bodies', () => {
  test('publish, subscribe and unsubscribe', async () => {
    const h = await harness('mqtt-decoded-commands');
    const client = h.module.last();
    forge(h, '{"kind":"publish","publish":{"topic":"out/1","payload":"on"}}');
    await awaitCondition(() => client.publishes.length > 0, {
      timeoutMs: 4_000,
      label: 'the decoded publish reached the broker',
    });
    expect(client.publishes).toEqual(['out/1:on']);

    // A ref inside a decoded body arrives revived, as a real ref.
    const subscriber = h.kit.createTestProbe();
    const subscribe = { ...JSON.parse('{"kind":"subscribe","topic":"cmd/#"}') as object, target: subscriber };
    h.actor.tell(subscribe);
    await settle(h);
    expect(client.subscribes).toContain('cmd/#');
    client.fireMessage('cmd/1', 'go');
    const delivered = await subscriber.receiveOne(2_000) as MqttMessage<unknown>;
    expect(delivered.payload.text()).toBe('go');

    const unsubscribe = { ...JSON.parse('{"kind":"unsubscribe","topic":"cmd/#"}') as object, target: subscriber };
    h.actor.tell(unsubscribe);
    await settle(h);
    expect(client.unsubscribes).toEqual(['cmd/#']);
    expect(h.deadLetters.hasMessage()).toBe(false);
  });
});
