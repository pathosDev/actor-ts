/**
 * A body that spells one of the hub's own signal kinds is not that signal.
 *
 * A `WebsocketServerActor` is an ordinary actor at an ordinary `/user` path, so
 * anything a remote node addresses to that path reaches its `onReceive` — the
 * cluster's envelope trust refuses `/system` paths, not `/user` ones — as a
 * decoded body: a plain object with the peer's keys as its own, and any
 * `ActorRef` marker inside it revived into a real ref (`RefCodec.decodeRefs`).
 * The hub used to dispatch on `kind` alone, so such a body was taken for the
 * framework's own signal, and each kind failed in its own way:
 *
 *   - `websocket-connected` planted a client whose `close` is not a function,
 *     so the next `closeAll()` threw and the hub restarted, tearing down every
 *     real connection under it;
 *   - `websocket-data` ran `onMessage` with the peer's payload, and `reply`
 *     went wherever the body's `connection` pointed;
 *   - `websocket-disconnected` evicted a real client from `clients` while its
 *     socket stayed open;
 *   - `websocket-invalid` ran `onInvalidMessage` for a connection that does
 *     not exist;
 *   - `websocket-accept` asked the hub to spawn a child from whatever the body
 *     carried, and a name that is already taken failed the hub outright.
 *
 * The class of defect #713 closed for the receptionist and the singleton
 * manager.  Every test below drives a hub with one real connection and then
 * tells it a forged body, and asserts the forgery is declined — a dead letter
 * naming the hub, through the default `onSelfMessage` — while the real
 * connection, the hub's incarnation and `clients` are untouched.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import type { ActorRef } from '../../../../src/ActorRef.js';
import type { ActorSystem } from '../../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { DeadLetter } from '../../../../src/SystemMessages.js';
import type { HttpRequest } from '../../../../src/http/Types.js';
import { wireConnection } from '../../../../src/http/websocket/ConnectionWiring.js';
import type { WebsocketListeners, WebsocketSocketAdapter } from '../../../../src/http/websocket/SocketAdapter.js';
import { jsonCodec } from '../../../../src/http/websocket/WebsocketCodec.js';
import type { WebsocketConnection } from '../../../../src/http/websocket/WebsocketConnection.js';
import type { WebsocketServerRef } from '../../../../src/http/websocket/WebsocketMessages.js';
import { DEFAULT_WEBSOCKET_POLICY } from '../../../../src/http/websocket/WebsocketPolicy.js';
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';
import { TestKit } from '../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../src/testkit/TestKitOptions.js';
import type { TestProbe } from '../../../../src/testkit/TestProbe.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type In = { kind: 'ping'; n: number };
type Out = { kind: 'pong'; n: number };

/** The one app-level command: snapshot `clients`, then close them all. */
type CloseAllCommand = { readonly kind: 'close-all' };

/** In-memory socket: buffers inbound events until the connection actor attaches. */
class MockSocket implements WebsocketSocketAdapter {
  readyState: 0 | 1 | 2 | 3 = 1;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  remoteAddress = '127.0.0.1';
  private listeners: WebsocketListeners | null = null;

  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.listeners?.onClose(code ?? 1000, reason ?? '');
  }
  setListeners(l: WebsocketListeners): void {
    this.listeners = l;
  }
}

/** What the hub did, owned by the test. */
type HubRecord = {
  starts: number;
  readonly events: string[];
  /** `clients` as the hub saw it when it ran `closeAll`, or `null` before it has. */
  clientsAtCloseAll: string[] | null;
};

class RecordingHub extends WebsocketServerActor<Out, In, CloseAllCommand> {
  constructor(private readonly record: HubRecord) {
    super();
  }

  override preStart(): void {
    this.record.starts += 1;
  }

  onMessage(message: In): void {
    this.record.events.push(`message:${this.connection.id}:${message.n}`);
    this.reply({ kind: 'pong', n: message.n });
  }

  protected override onClientConnected(client: WebsocketConnection<Out>): void {
    this.record.events.push(`connected:${client.id}`);
  }

  protected override onClientDisconnected(client: WebsocketConnection<Out>): void {
    this.record.events.push(`disconnected:${client.id}`);
  }

  protected override onInvalidMessage(client: WebsocketConnection<Out>): void {
    this.record.events.push(`invalid:${client.id}`);
  }

  protected override onSelfMessage(message: CloseAllCommand): void {
    match(message as unknown)
      .with({ kind: 'close-all' }, () => this.onCloseAll())
      .otherwise((m) => this.onForeign(m));
  }

  private onCloseAll(): void {
    this.record.clientsAtCloseAll = [...this.clients.keys()];
    this.closeAll(1001, 'going away');
  }

  /** Everything else keeps the default: a warn and a dead letter naming the hub. */
  private onForeign(message: unknown): void {
    super.onSelfMessage(message as CloseAllCommand);
  }
}

const request: HttpRequest = {
  method: 'GET', path: '/ws', headers: {}, query: {}, params: {}, body: null,
};

const kits: TestKit[] = [];
afterEach(async () => {
  await Promise.all(kits.splice(0).map((kit) => kit.system.terminate()));
});

type Harness = {
  readonly system: ActorSystem;
  readonly hub: WebsocketServerRef<Out, In, CloseAllCommand>;
  readonly record: HubRecord;
  /** The real connection, attached and announced. */
  readonly socket: MockSocket;
  readonly connectionId: string;
  /** Subscribed to `DeadLetter` before anything was forged. */
  readonly deadLetters: TestProbe;
  /** A ref a decoded body can carry: the cluster revives `{ $ref: 'actor' }` markers into refs like it. */
  readonly revivedRef: TestProbe;
};

async function harness(name: string): Promise<Harness> {
  const kit = TestKit.create(name, TestKitOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off));
  kits.push(kit);
  const record: HubRecord = { starts: 0, events: [], clientsAtCloseAll: null };
  const hub = kit.system.spawn(
    () => new RecordingHub(record), 'hub',
  ) as WebsocketServerRef<Out, In, CloseAllCommand>;
  const socket = new MockSocket();
  wireConnection<Out, In, CloseAllCommand>(
    kit.system, hub, request, socket, jsonCodec<Out, In>(), DEFAULT_WEBSOCKET_POLICY,
  );
  await awaitCondition(() => record.events.some((event) => event.startsWith('connected:')), {
    timeoutMs: 4_000,
    label: 'the real connection was announced to the hub',
  });
  const connectionId = record.events[0]!.slice('connected:'.length);
  const deadLetters = kit.createTestProbe();
  kit.system.eventStream.subscribe(deadLetters, DeadLetter);
  return { system: kit.system, hub, record, socket, connectionId, deadLetters, revivedRef: kit.createTestProbe() };
}

/** Tell the hub `body` exactly as a decoded peer body arrives: an untyped `tell`. */
function forge(h: Harness, body: unknown): void {
  (h.hub as ActorRef<unknown>).tell(body);
}

/** The forged body came back as a dead letter naming the hub — declined, not dispatched. */
async function expectDeclined(h: Harness, body: unknown): Promise<void> {
  const letter = await h.deadLetters.receiveOne(2_000) as DeadLetter;
  expect(letter.message).toBe(body);
  expect(letter.recipient.path.toString()).toBe(h.hub.path.toString());
}

/** Run `closeAll` and check it reached exactly the real connection, on the first incarnation. */
async function expectRealConnectionIntact(h: Harness): Promise<void> {
  forge(h, { kind: 'close-all' } satisfies CloseAllCommand);
  await awaitCondition(() => h.socket.closeCalls.length > 0, {
    timeoutMs: 4_000,
    label: 'closeAll reached the real socket',
  });
  expect(h.record.clientsAtCloseAll).toEqual([h.connectionId]);
  expect(h.socket.closeCalls).toEqual([{ code: 1001, reason: 'going away' }]);
  expect(h.record.starts).toBe(1);
}

describe('a forged hub signal is declined, not dispatched (#713 class)', () => {
  test('websocket-connected with a plain-object connection plants no client', async () => {
    const h = await harness('ws-forged-connected-plain');
    const body = { kind: 'websocket-connected', connection: { id: 'forged' } };
    forge(h, body);

    await expectDeclined(h, body);
    expect(h.record.events).toEqual([`connected:${h.connectionId}`]);
    await expectRealConnectionIntact(h);
  });

  test('websocket-connected with a revived ref plants no client', async () => {
    const h = await harness('ws-forged-connected-ref');
    const body = { kind: 'websocket-connected', connection: h.revivedRef };
    forge(h, body);

    await expectDeclined(h, body);
    expect(h.record.events).toEqual([`connected:${h.connectionId}`]);
    await expectRealConnectionIntact(h);
  });

  test('websocket-data never reaches onMessage, and nothing is replied to the ref it names', async () => {
    const h = await harness('ws-forged-data');
    const plain = { kind: 'websocket-data', connection: { id: h.connectionId }, message: { kind: 'ping', n: 1 } };
    const aimed = { kind: 'websocket-data', connection: h.revivedRef, message: { kind: 'ping', n: 2 } };
    forge(h, plain);
    forge(h, aimed);

    await expectDeclined(h, plain);
    await expectDeclined(h, aimed);
    expect(h.record.events).toEqual([`connected:${h.connectionId}`]);
    await h.revivedRef.expectNoMessage(100);
    await expectRealConnectionIntact(h);
  });

  test('websocket-disconnected cannot evict a real client', async () => {
    const h = await harness('ws-forged-disconnected');
    const body = {
      kind: 'websocket-disconnected',
      connection: { id: h.connectionId },
      info: { code: 1000, reason: '', initiatedBy: 'client' },
    };
    forge(h, body);

    await expectDeclined(h, body);
    expect(h.record.events).toEqual([`connected:${h.connectionId}`]);
    await expectRealConnectionIntact(h);
  });

  test('websocket-invalid never reaches onInvalidMessage', async () => {
    const h = await harness('ws-forged-invalid');
    const body = { kind: 'websocket-invalid', connection: { id: h.connectionId }, error: { message: 'x' } };
    forge(h, body);

    await expectDeclined(h, body);
    expect(h.record.events).toEqual([`connected:${h.connectionId}`]);
    await expectRealConnectionIntact(h);
  });

  test('websocket-accept spawns nothing and cannot fail the hub with a name already taken', async () => {
    const h = await harness('ws-forged-accept');
    // The live connection's actor is the hub's child under the connection id,
    // so this name is taken: a spawn of it throws on the hub's stack.
    const body = { kind: 'websocket-accept', actor: {}, name: h.connectionId };
    forge(h, body);

    await expectDeclined(h, body);
    expect(h.socket.closeCalls).toEqual([]);
    await expectRealConnectionIntact(h);
  });
});
