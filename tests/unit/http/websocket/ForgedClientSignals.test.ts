/**
 * A `WebsocketClientActor` signal is recognised by its mark, not by its `kind`
 * alone.
 *
 * The client's four internal signals — `websocket-client-inbound`,
 * `websocket-client-invalid`, `websocket-client-connected` and
 * `websocket-client-disconnected` — are told to its own mailbox by the socket
 * listeners, and each now has to carry the mark that only the constructors in
 * `WebsocketMessages.ts` put on it.  A client actor is an ordinary actor at an
 * ordinary `/user` path, so what a remote node addresses to that path reaches
 * it as a decoded body: a plain object with the peer's keys as its own, which
 * no decoder can give that mark.  Such a body is declined like any other
 * message none of the client's kinds matched — it reaches `onSelfMessage`,
 * whose default makes it a dead letter naming the client — and nothing else
 * about the client changes: no hook runs, no frame is sent, and the count of
 * decoded frames waiting in the mailbox, which the inbound high-water mark
 * (#1523) pauses and resumes the socket by, stays the count of real frames.
 * The requirement #1431 put on the WebSocket hub's signals.
 *
 * `websocket-client-send` is not a signal: it is the documented command
 * `websocketSend(message)` builds for anyone holding the ref, so a decoded
 * body spelling it still sends — the last group pins that, together with the
 * real signals still driving the client.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { DeadLetter } from '../../../../src/SystemMessages.js';
import { structuredCloneProblem } from '../../../../src/diagnostics/MessageBoundaryCheck.js';
import { MessageBoundaryOptions } from '../../../../src/diagnostics/MessageBoundaryOptions.js';
import type { WebsocketFrame } from '../../../../src/http/websocket/Types.js';
import { WebsocketClientActor } from '../../../../src/http/websocket/WebsocketClientActor.js';
import { WebsocketClientOptions } from '../../../../src/http/websocket/WebsocketClientOptions.js';
import { jsonCodec, rawCodec, WebsocketDecodeError } from '../../../../src/http/websocket/WebsocketCodec.js';
import {
  websocketClientConstructor,
  type WebsocketClientConstructor,
  type WebsocketLike,
} from '../../../../src/http/websocket/WebsocketConstructor.js';
import {
  isWebsocketClientSignal,
  websocketClientConnected,
  websocketClientDisconnected,
  websocketClientInbound,
  websocketClientInvalid,
} from '../../../../src/http/websocket/WebsocketMessages.js';
import { JsonSerializer } from '../../../../src/serialization/JsonSerializer.js';
import { TestKit } from '../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../src/testkit/TestKitOptions.js';
import type { TestProbe } from '../../../../src/testkit/TestProbe.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type ServerMessage = { readonly kind: 'pong'; readonly n: number };
type ClientMessage = { readonly kind: 'ping'; readonly n: number };

/** The one application message: once it is recorded, everything told before it has been processed. */
type BarrierMessage = { readonly kind: 'barrier' };

const decoder = new TextDecoder();

/** A socket as Bun's client `WebSocket` behaves: listeners, `send`, and the `pause()` / `resume()` pair, recorded. */
class FakeSocket {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  binaryType: 'blob' | 'arraybuffer' | 'nodebuffer' = 'blob';
  readonly sent: string[] = [];
  /** Every flow-control transition, in order. */
  readonly transitions: Array<'pause' | 'resume'> = [];
  isPaused = false;

  addEventListener(event: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === 'string' ? data : decoder.decode(data));
  }

  close(): void { this.fire('close'); }
  pause(): void { this.isPaused = true; this.transitions.push('pause'); }
  resume(): void { this.isPaused = false; this.transitions.push('resume'); }

  fire(event: string, payload?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload);
  }

  /** One text frame from the server, as the runtime hands it to the `message` listener. */
  deliver(text: string): void { this.fire('message', { data: text }); }

  get isOpen(): boolean { return (this.listeners.get('message') ?? []).length > 0; }
}

/** Point the client actor at `socket`, which opens on the next microtask. */
function serve(socket: FakeSocket): void {
  const constructor: WebsocketClientConstructor = {
    create: (): WebsocketLike => {
      queueMicrotask(() => socket.fire('open'));
      return socket as unknown as WebsocketLike;
    },
  };
  websocketClientConstructor.setOverride(Promise.resolve(constructor));
}

const kits: TestKit[] = [];
afterEach(async () => {
  websocketClientConstructor.reset();
  await Promise.all(kits.splice(0).map((kit) => kit.system.terminate()));
});

function createKit(name: string): TestKit {
  // Off, unlike a TestKit's default: the structured-clone check reports the
  // client's own `websocket-client-invalid` signal, because the decode error
  // it carries is a `WebsocketDecodeError` instance.  That is a question about
  // worker hops, not about which bodies the client takes for a signal.
  const boundaryOptions = MessageBoundaryOptions.create().withStructuredClone('off');
  const kitOptions = TestKitOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withMessageBoundary(boundaryOptions);
  const kit = TestKit.create(name, kitOptions);
  kits.push(kit);
  return kit;
}

/** A body exactly as the cluster hands one over: parsed from the wire, then told untyped. */
function forge(client: ActorRef<unknown>, json: string): unknown {
  const body: unknown = JSON.parse(json);
  client.tell(body);
  return body;
}

/** Shared across incarnations, so a restart shows up as a second start. */
type ClientRecord = {
  starts: number;
  connected: number;
  disconnects: unknown[];
  invalid: unknown[];
  messages: ServerMessage[];
  barriers: number;
};

/** Says hello on every connect, as the documented client does, and records every hook it is offered. */
class RecordingClient extends WebsocketClientActor<ClientMessage, ServerMessage, BarrierMessage> {
  constructor(private readonly record: ClientRecord) {
    const clientOptions = WebsocketClientOptions.create<ClientMessage, ServerMessage>()
      .withUrl('wss://feed.example.com/ws')
      .withCodec(jsonCodec<ClientMessage, ServerMessage>())
      .withOnInvalidMessage('hook')
      .withReconnect(false);
    super(clientOptions);
  }

  override async preStart(): Promise<void> {
    this.record.starts += 1;
    await super.preStart();
  }

  onMessage(message: ServerMessage): void {
    this.record.messages.push(message);
  }

  protected override onConnected(): void {
    this.record.connected += 1;
    this.send({ kind: 'ping', n: this.record.connected });
  }

  protected override onDisconnected(cause?: Error): void {
    this.record.disconnects.push(cause);
  }

  protected override onInvalidMessage(error: WebsocketDecodeError): void {
    this.record.invalid.push(error);
  }

  protected override onSelfMessage(message: BarrierMessage): void {
    match(message as unknown)
      .with({ kind: 'barrier' }, () => this.onBarrier())
      .otherwise((m) => this.onForeign(m));
  }

  private onBarrier(): void {
    this.record.barriers += 1;
  }

  /** Everything else keeps the default: a warn and a dead letter naming the client. */
  private onForeign(message: unknown): void {
    super.onSelfMessage(message as BarrierMessage);
  }
}

type Harness = {
  readonly kit: TestKit;
  readonly client: ActorRef<unknown>;
  readonly socket: FakeSocket;
  readonly record: ClientRecord;
  /** Subscribed to `DeadLetter` before anything was told. */
  readonly deadLetters: TestProbe;
};

/** A client with its one real connection open and its hello sent. */
async function harness(name: string): Promise<Harness> {
  const socket = new FakeSocket();
  serve(socket);
  const kit = createKit(name);
  const record: ClientRecord = { starts: 0, connected: 0, disconnects: [], invalid: [], messages: [], barriers: 0 };
  const client = kit.system.spawn(() => new RecordingClient(record), 'client') as ActorRef<unknown>;
  await awaitCondition(() => record.connected === 1 && socket.sent.length === 1, {
    timeoutMs: 4_000,
    label: 'the real connection was announced and the hello sent',
  });
  const deadLetters = kit.createTestProbe();
  kit.system.eventStream.subscribe(deadLetters, DeadLetter);
  const h: Harness = { kit, client, socket, record, deadLetters };
  await settle(h);
  return h;
}

/** Returns once everything told before it has been processed — by whichever incarnation. */
async function settle(h: Harness): Promise<void> {
  const before = h.record.barriers;
  h.client.tell({ kind: 'barrier' } satisfies BarrierMessage);
  await awaitCondition(() => h.record.barriers > before, {
    timeoutMs: 4_000,
    label: 'the barrier was processed',
  });
}

/** First incarnation, its one connection, its one hello, no hook run since. */
function expectUntouched(h: Harness): void {
  expect(h.record.starts).toBe(1);
  expect(h.record.connected).toBe(1);
  expect(h.socket.sent).toEqual(['{"kind":"ping","n":1}']);
  expect(h.record.disconnects).toEqual([]);
  expect(h.record.invalid).toEqual([]);
  expect(h.record.messages).toEqual([]);
}

/** The body came back as a dead letter naming the client — declined, not dispatched. */
async function expectDeclined(h: Harness, body: unknown): Promise<void> {
  const letter = await h.deadLetters.receiveOne(2_000) as DeadLetter;
  expect(letter.message).toBe(body);
  expect(letter.recipient.path.toString()).toBe(h.client.path.toString());
}

/** A real frame on the real connection still reaches `onMessage`. */
async function expectStillServing(h: Harness): Promise<void> {
  h.socket.deliver('{"kind":"pong","n":7}');
  await awaitCondition(() => h.record.messages.length > 0, {
    timeoutMs: 4_000,
    label: 'the real frame reached onMessage',
  });
  expect(h.record.messages).toEqual([{ kind: 'pong', n: 7 }]);
  expect(h.record.starts).toBe(1);
}

describe('WebsocketClientActor declines a body that spells one of its signal kinds without the mark', () => {
  test('websocket-client-inbound: onMessage does not run, a dead letter', async () => {
    const h = await harness('ws-client-unmarked-inbound');
    const body = forge(h.client, '{"kind":"websocket-client-inbound","message":{"kind":"pong","n":99}}');
    await settle(h);

    expectUntouched(h);
    await expectDeclined(h, body);
    await expectStillServing(h);
  });

  test('websocket-client-invalid: onInvalidMessage does not run, a dead letter', async () => {
    const h = await harness('ws-client-unmarked-invalid');
    const body = forge(
      h.client,
      '{"kind":"websocket-client-invalid","error":{"name":"WebsocketDecodeError","message":"bad frame"}}',
    );
    await settle(h);

    expectUntouched(h);
    await expectDeclined(h, body);
    await expectStillServing(h);
  });

  test('websocket-client-connected: onConnected does not run, nothing is sent, a dead letter', async () => {
    const h = await harness('ws-client-unmarked-connected');
    const body = forge(h.client, '{"kind":"websocket-client-connected"}');
    await settle(h);

    expectUntouched(h);
    await expectDeclined(h, body);
    await expectStillServing(h);
  });

  test('websocket-client-disconnected: onDisconnected does not run, a dead letter', async () => {
    const h = await harness('ws-client-unmarked-disconnected');
    const body = forge(
      h.client,
      '{"kind":"websocket-client-disconnected","cause":{"name":"Error","message":"websocket closed"}}',
    );
    await settle(h);

    expectUntouched(h);
    await expectDeclined(h, body);
    await expectStillServing(h);
  });
});

const HIGH_WATER_MARK = 4;
const LOW_WATER_MARK = 1;

/** What a gated client was handed, and the hold on the frame it is handling. */
type GateRecord = {
  readonly socket: FakeSocket;
  /** `<frame data>:<paused|flowing>` — the socket's state when the frame was handed over. */
  readonly handled: string[];
  release: (() => void) | null;
  open: boolean;
};

/** Holds every frame in `onMessage` until the test opens the gate. */
class GatedClient extends WebsocketClientActor<WebsocketFrame, WebsocketFrame> {
  constructor(private readonly gate: GateRecord) {
    const clientOptions = WebsocketClientOptions.create<WebsocketFrame, WebsocketFrame>()
      .withUrl('wss://feed.example.com/ws')
      .withCodec(rawCodec())
      .withReconnect(false)
      .withInboundHighWaterMark(HIGH_WATER_MARK)
      .withInboundLowWaterMark(LOW_WATER_MARK);
    super(clientOptions);
  }

  onMessage(frame: WebsocketFrame): Promise<void> {
    this.gate.handled.push(`${String(frame.data)}:${this.gate.socket.isPaused ? 'paused' : 'flowing'}`);
    if (this.gate.open) return Promise.resolve();
    return new Promise<void>((resolve) => { this.gate.release = resolve; });
  }
}

describe('a body spelling websocket-client-inbound leaves the inbound high-water mark to the real frames', () => {
  test('the socket pauses and resumes on the real backlog alone', async () => {
    const socket = new FakeSocket();
    serve(socket);
    const kit = createKit('ws-client-unmarked-inbound-flow');
    const gate: GateRecord = { socket, handled: [], release: null, open: false };
    const client = kit.system.spawn(() => new GatedClient(gate), 'client') as ActorRef<unknown>;
    await awaitCondition(() => socket.isOpen, { timeoutMs: 4_000, label: 'the client opened its socket' });
    const deadLetters = kit.createTestProbe();
    kit.system.eventStream.subscribe(deadLetters, DeadLetter);

    // The first frame is held in onMessage, so everything after it queues.
    socket.deliver('frame-0');
    await awaitCondition(() => gate.handled.length === 1, { timeoutMs: 4_000, label: 'frame-0 is being handled' });
    const bodies: unknown[] = [];
    for (let i = 1; i <= HIGH_WATER_MARK; i++) {
      socket.deliver(`frame-${i}`);
      bodies.push(forge(client, `{"kind":"websocket-client-inbound","message":{"kind":"text","data":"forged-${i}"}}`));
    }
    expect(socket.transitions).toEqual(['pause']);

    gate.open = true;
    gate.release?.();
    await awaitCondition(() => gate.handled.length >= HIGH_WATER_MARK + 1, {
      timeoutMs: 4_000,
      label: 'every real frame was handled',
    });

    // Paused until the real backlog is down to the low-water mark, and no
    // forged message among what onMessage was handed.
    expect(gate.handled).toEqual([
      'frame-0:flowing',
      'frame-1:paused',
      'frame-2:paused',
      'frame-3:flowing',
      'frame-4:flowing',
    ]);
    const letters = await deadLetters.receiveN(HIGH_WATER_MARK, 2_000) as DeadLetter[];
    expect(letters.map((letter) => letter.message)).toEqual(bodies);
    expect(letters.every((letter) => letter.recipient.path.toString() === client.path.toString())).toBe(true);
    expect(socket.transitions).toEqual(['pause', 'resume']);
    expect(gate.handled).toHaveLength(HIGH_WATER_MARK + 1);
  });
});

describe('the mark', () => {
  const signals = (): Array<[string, object]> => [
    ['websocket-client-inbound', websocketClientInbound<ServerMessage>({ kind: 'pong', n: 1 })],
    ['websocket-client-invalid', websocketClientInvalid(
      new WebsocketDecodeError('bad frame', { kind: 'text', data: 'x' }),
    )],
    ['websocket-client-connected', websocketClientConnected()],
    ['websocket-client-disconnected', websocketClientDisconnected(new Error('websocket closed'))],
  ];

  test('every signal constructor sets it, and a copy through JSON does not keep it', () => {
    for (const [kind, signal] of signals()) {
      expect([kind, isWebsocketClientSignal(signal)]).toEqual([kind, true]);
      expect([kind, isWebsocketClientSignal(JSON.parse(JSON.stringify(signal)) as object)]).toEqual([kind, false]);
    }
  });

  test('is one symbol of this module, not one from the global registry', () => {
    for (const [kind, signal] of signals()) {
      const marks = Object.getOwnPropertySymbols(signal);
      expect([kind, marks.length]).toEqual([kind, 1]);
      expect([kind, Symbol.keyFor(marks[0]!)]).toEqual([kind, undefined]);
    }
  });

  // The invalid signal is left out: its `WebsocketDecodeError` is a class
  // instance, which the structured-clone check reports whatever the mark is.
  test('adds nothing the message boundary check reports, in its clone or its serializer round trip', () => {
    const serializer = new JsonSerializer();
    for (const [kind, signal] of signals().filter(([name]) => name !== 'websocket-client-invalid')) {
      expect(structuredCloneProblem(signal), kind).toBeNull();
      expect(() => serializer.fromBinary(serializer.toBinary(signal), ''), kind).not.toThrow();
    }
  });
});

describe('the real signals and the send command still drive the client', () => {
  test('a real connect runs onConnected once and sends the hello', async () => {
    const h = await harness('ws-client-real-connect');

    expectUntouched(h);
    expect(h.deadLetters.hasMessage()).toBe(false);
  });

  test('a real frame reaches onMessage', async () => {
    const h = await harness('ws-client-real-inbound');

    await expectStillServing(h);
    expect(h.deadLetters.hasMessage()).toBe(false);
  });

  test('a real undecodable frame reaches onInvalidMessage with its decode error', async () => {
    const h = await harness('ws-client-real-invalid');
    h.socket.deliver('not json');
    await awaitCondition(() => h.record.invalid.length > 0, {
      timeoutMs: 4_000,
      label: 'the real undecodable frame reached onInvalidMessage',
    });

    expect(h.record.invalid).toHaveLength(1);
    expect(h.record.invalid[0]).toBeInstanceOf(WebsocketDecodeError);
    expect(h.record.messages).toEqual([]);
    expect(h.deadLetters.hasMessage()).toBe(false);
  });

  test('a real close runs onDisconnected with its cause', async () => {
    const h = await harness('ws-client-real-disconnect');
    h.socket.close();
    await awaitCondition(() => h.record.disconnects.length > 0, {
      timeoutMs: 4_000,
      label: 'the real close reached onDisconnected',
    });

    expect(h.record.disconnects).toHaveLength(1);
    const cause = h.record.disconnects[0];
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toBe('websocket closed');
    expect(h.record.starts).toBe(1);
  });

  test('websocket-client-send is a command: a decoded body spelling it still sends', async () => {
    const h = await harness('ws-client-decoded-send');
    forge(h.client, '{"kind":"websocket-client-send","message":{"kind":"ping","n":42}}');
    await awaitCondition(() => h.socket.sent.length > 1, {
      timeoutMs: 4_000,
      label: 'the decoded send reached the socket',
    });

    expect(h.socket.sent).toEqual(['{"kind":"ping","n":1}', '{"kind":"ping","n":42}']);
    expect(h.deadLetters.hasMessage()).toBe(false);
  });
});
