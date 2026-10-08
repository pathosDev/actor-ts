/**
 * What happens to a WebSocket connection once this side has decided to close
 * it (#1431).
 *
 * **Inbound traffic does not stop when the server closes.**  The `ws` package
 * keeps emitting `'message'` while a socket is CLOSING — a frame the peer sent
 * before it saw the close frame is still parsed and handed over
 * (`receiverOnMessage` in `ws/lib/websocket.js`, 8.21.3) — and the connection
 * actor's listeners stay attached after it has stopped.  So a frame arriving
 * after the actor had reported `onClientDisconnected` was still decoded and
 * told to the hub, which ran `onMessage` for a connection it had already said
 * goodbye to: the documented per-connection order,
 * `onClientConnected → onMessage* → onClientDisconnected`, broken by the
 * transport rather than by the application.  A frame pipelined right behind
 * the one that made the server close reached the hub the same way, only
 * earlier.
 *
 * **The socket here keeps the closing handshake's schedule**, the way `ws`
 * does: `close()` moves it to CLOSING and the close event waits for the
 * peer's answer.  It is wrapped in the same chain a backend's socket crosses
 * on its way to the connection actor — `trackSocket` (what `HttpExtension`
 * adds), the `maxConnections` slot wrapper (what a capped route adds) and the
 * accept guard (what `wireConnection` always adds).
 *
 * **Absence is asserted behind a sentinel, never a sleep.**  A frame the
 * connection actor forwards is told to the hub synchronously, on the stack
 * that delivered it, so a sentinel told to the hub *after* that delivery is
 * queued behind it: once the hub has handled the sentinel, a forwarded frame
 * would already have reached `onMessage`.
 *
 * Refs #1431.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { HttpRequest } from '../../../../src/http/Types.js';
import { ConnectionTracker, trackSocket, wireConnection } from '../../../../src/http/websocket/ConnectionWiring.js';
import { WebsocketReadyState, type WebsocketListeners, type WebsocketSocketAdapter } from '../../../../src/http/websocket/SocketAdapter.js';
import type { WebsocketCloseInfo } from '../../../../src/http/websocket/Types.js';
import { jsonCodec } from '../../../../src/http/websocket/WebsocketCodec.js';
import type { WebsocketConnection } from '../../../../src/http/websocket/WebsocketConnection.js';
import type { WebsocketServerRef } from '../../../../src/http/websocket/WebsocketMessages.js';
import { DEFAULT_WEBSOCKET_POLICY, type ResolvedWebsocketPolicy } from '../../../../src/http/websocket/WebsocketPolicy.js';
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type PingMessage = { readonly kind: 'ping'; readonly n: number };
/** Answered with a reply and a close, in that order, in one hub turn. */
type GoodbyeMessage = { readonly kind: 'goodbye'; readonly n: number };
type ClientMessage = PingMessage | GoodbyeMessage;

type PongMessage = { readonly kind: 'pong'; readonly n: number };
type ServerMessage = PongMessage;

/** Ask the hub to record that it got this far — see the header. */
type SentinelCommand = { readonly kind: 'sentinel'; readonly label: string };
type HubCommand = SentinelCommand;

/**
 * A socket that keeps the closing handshake's schedule, as `ws` does.
 *
 * `close()` moves it to CLOSING and the close event waits for the peer's
 * answer, so a frame the peer had already sent can still be delivered after
 * the server closed.
 */
class HandshakeSocket implements WebsocketSocketAdapter {
  readyState: 0 | 1 | 2 | 3 = WebsocketReadyState.OPEN;
  /** Every call the connection actor made on this socket, in order. */
  readonly calls: string[] = [];
  readonly remoteAddress = '127.0.0.1';
  private listeners: WebsocketListeners | null = null;
  private readonly pending: Array<(listeners: WebsocketListeners) => void> = [];

  send(data: string | Uint8Array): void {
    this.calls.push(`send:${typeof data === 'string' ? data : `${data.byteLength} bytes`}`);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState !== WebsocketReadyState.OPEN) return;
    this.readyState = WebsocketReadyState.CLOSING;
    this.calls.push(`close:${code}:${reason}`);
  }

  setListeners(listeners: WebsocketListeners): void {
    this.listeners = listeners;
    for (const replay of this.pending.splice(0)) replay(listeners);
  }

  /** One frame from the peer, encoded the way the route codec expects. */
  deliver(message: ClientMessage): void {
    this.deliverRaw(JSON.stringify(message));
  }

  /** One frame from the peer, verbatim — which need not decode. */
  deliverRaw(data: string): void {
    this.dispatch((listeners) => listeners.onMessage(data));
  }

  private dispatch(event: (listeners: WebsocketListeners) => void): void {
    if (this.listeners) event(this.listeners);
    else this.pending.push(event);
  }
}

/** What the test reads back out of the hub. */
type HubState = {
  /** Every hook the hub ran, in the order it ran them. */
  readonly events: string[];
  /** Connections the hub has seen through `onClientConnected`, in order. */
  readonly connections: WebsocketConnection<ServerMessage>[];
};

class RecordingHub extends WebsocketServerActor<ServerMessage, ClientMessage, HubCommand> {
  constructor(private readonly state: HubState) {
    super();
  }

  onMessage(message: ClientMessage): void {
    this.state.events.push(`message:${this.connection.id}:${message.n}`);
    match(message)
      .with({ kind: 'ping' }, () => this.onPing())
      .with({ kind: 'goodbye' }, (m) => this.onGoodbye(m))
      .exhaustive();
  }

  private onPing(): void { /* recorded above; nothing to answer */ }

  /** The documented shape: answer, then close — nothing in between drains. */
  private onGoodbye(message: GoodbyeMessage): void {
    this.reply({ kind: 'pong', n: message.n });
    this.connection.close(1000, 'bye');
  }

  protected override onClientConnected(client: WebsocketConnection<ServerMessage>): void {
    this.state.connections.push(client);
    this.state.events.push(`connected:${client.id}`);
  }

  protected override onClientDisconnected(client: WebsocketConnection<ServerMessage>, info: WebsocketCloseInfo): void {
    this.state.events.push(`disconnected:${client.id}:${info.code}:${info.reason}:${info.initiatedBy}`);
  }

  protected override onSelfMessage(command: HubCommand): void {
    match(command)
      .with({ kind: 'sentinel' }, (c) => this.onSentinel(c))
      .exhaustive();
  }

  private onSentinel(command: SentinelCommand): void {
    this.state.events.push(`sentinel:${command.label}`);
  }
}

const systems: ActorSystem[] = [];

afterEach(async () => {
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

const upgradeRequest: HttpRequest = {
  method: 'GET',
  path: '/ws',
  headers: {},
  query: {},
  params: {},
  body: null,
};

/**
 * Finite, so the slot wrapper is part of the chain.  Large enough that no
 * test here is ever refused.
 */
const cappedPolicy: ResolvedWebsocketPolicy = { ...DEFAULT_WEBSOCKET_POLICY, maxConnections: 8 };

type Harness = {
  readonly hub: WebsocketServerRef<ServerMessage, ClientMessage, HubCommand>;
  /** The hub's hook log — {@link HubState.events}. */
  readonly events: string[];
  /** Wire `socket` up as a new connection and wait until the hub has it. */
  readonly connect: <TSocket extends HandshakeSocket>(socket: TSocket, policy?: ResolvedWebsocketPolicy) => Promise<{
    readonly connection: WebsocketConnection<ServerMessage>;
    readonly socket: TSocket;
  }>;
  /** Tell the hub a sentinel and wait until it has handled it. */
  readonly sentinel: (label: string) => Promise<void>;
};

function harness(name: string): Harness {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  const state: HubState = { events: [], connections: [] };
  // Factory form, not the class form: the hub takes a constructor argument
  // (the state record the test reads back).
  const hub = system.spawn(() => new RecordingHub(state), 'hub') as WebsocketServerRef<ServerMessage, ClientMessage, HubCommand>;
  const tracker = new ConnectionTracker();

  const connect = async <TSocket extends HandshakeSocket>(
    socket: TSocket,
    policy: ResolvedWebsocketPolicy = cappedPolicy,
  ): Promise<{
    readonly connection: WebsocketConnection<ServerMessage>;
    readonly socket: TSocket;
  }> => {
    const before = state.connections.length;
    wireConnection(system, hub, upgradeRequest, trackSocket(tracker, socket), jsonCodec<ServerMessage, ClientMessage>(), policy);
    await awaitCondition(() => state.connections.length > before, {
      timeoutMs: 4_000,
      label: 'the hub registered the new connection',
    });
    return { connection: state.connections[before]!, socket };
  };

  const sentinel = async (label: string): Promise<void> => {
    hub.tell({ kind: 'sentinel', label });
    await awaitCondition(() => state.events.includes(`sentinel:${label}`), {
      timeoutMs: 4_000,
      label: `the hub handled sentinel ${label}`,
    });
  };

  return { hub, events: state.events, connect, sentinel };
}

describe('inbound frames once this side has closed (#1431)', () => {
  test('a frame pipelined behind the one that made the server close never reaches onMessage', async () => {
    const h = harness('ws-pipelined-after-close');
    const { connection, socket } = await h.connect(new HandshakeSocket());

    // Both in one tick, the way `ws` hands over two frames that arrived in one
    // read: the first fails to decode and closes the connection (1003 under
    // the default policy), the second is already on its way.
    socket.deliverRaw('not json {');
    socket.deliver({ kind: 'ping', n: 7 });

    const disconnected = `disconnected:${connection.id}:1003:unsupported data:server`;
    await awaitCondition(() => h.events.includes(disconnected), {
      timeoutMs: 4_000,
      label: 'the hub heard the 1003 close',
    });
    // A forwarded ping was told before the disconnect was, so it would be in
    // the log by now — ahead of the disconnect.
    expect(h.events).toEqual([`connected:${connection.id}`, disconnected]);
    expect(socket.calls).toEqual(['close:1003:unsupported data']);
  });

  test('a frame the transport delivers after close() has shut the socket never reaches onMessage', async () => {
    const h = harness('ws-late-frame-after-close');
    const { connection, socket } = await h.connect(new HandshakeSocket());

    connection.close(1008, 'rate limited');
    const disconnected = `disconnected:${connection.id}:1008:rate limited:server`;
    await awaitCondition(() => h.events.includes(disconnected), {
      timeoutMs: 4_000,
      label: 'the hub heard the server-side close',
    });
    // The actor has run the close and stopped, and the socket is
    // mid-handshake — the state in which `ws` still hands over a frame.
    expect(socket.calls).toEqual(['close:1008:rate limited']);
    expect(socket.readyState).toBe(WebsocketReadyState.CLOSING);

    socket.deliver({ kind: 'ping', n: 7 });
    await h.sentinel('after-the-late-frame');

    expect(h.events).toEqual([
      `connected:${connection.id}`,
      disconnected,
      'sentinel:after-the-late-frame',
    ]);
  });
});

describe('close() keeps its place behind what was already sent (#1431)', () => {
  test('reply-then-close at the default configuration writes the reply, then closes', async () => {
    const h = harness('ws-reply-then-close');
    // The shipped route policy and an unconfigured system: no route bound and
    // no global one, so the connection actor runs on the default mailbox.
    const { connection, socket } = await h.connect(new HandshakeSocket(), DEFAULT_WEBSOCKET_POLICY);

    // The hub answers inside onMessage: reply(x), then close(1000, 'bye'),
    // in one turn.  The close is queued behind the reply rather than ahead of
    // it — and it has to be, because the connection actor writes nothing
    // after a close: a close that overtook the reply would lose it.
    socket.deliver({ kind: 'goodbye', n: 42 });

    const disconnected = `disconnected:${connection.id}:1000:bye:server`;
    await awaitCondition(() => h.events.includes(disconnected), {
      timeoutMs: 4_000,
      label: 'the hub heard its own close',
    });
    expect(socket.calls).toEqual(['send:{"kind":"pong","n":42}', 'close:1000:bye']);
    expect(h.events).toEqual([`connected:${connection.id}`, `message:${connection.id}:42`, disconnected]);
  });
});
