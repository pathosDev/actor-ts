/**
 * What happens to a WebSocket connection once this side has decided to close
 * it (#1431).
 *
 * **`close()` is ordered, `abort()` is immediate.**  `close()` queues behind
 * whatever was already sent to the connection, so a reply followed by a close
 * reaches the peer first — the shape the WebSocket page documents, pinned here
 * at the default configuration.  That is the wrong answer for a peer the hub
 * has stopped serving: under a flood, `close(1008)` hands it the whole backlog
 * before the close.  `abort()` acts on the socket before it returns, and the
 * backlog is never written.
 *
 * **One hub turn.**  The abort tests queue their frames and abort inside ONE
 * turn of the hub, the stack `reply`, `broadcast` and `closeAll` run on.
 * `connection.tell` enqueues on the caller's stack and only *schedules* a
 * drain, so nothing reaches the socket before that turn is over — the way
 * `CloseCommandUndroppable.test.ts` holds a queue full.
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
 * **The sockets here keep the closing handshake's schedule**, the way `ws`
 * does: `close()` moves one to CLOSING and the close event waits for the
 * peer's answer.  Each is wrapped in the same chain a backend's socket crosses
 * on its way to the connection actor — `trackSocket` (what `HttpExtension`
 * adds), the `maxConnections` slot wrapper (what a capped route adds) and the
 * accept guard (what `wireConnection` always adds) — so a `terminate` that
 * reaches the socket has crossed all three.
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
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { DeadLetter, Terminated } from '../../../../src/SystemMessages.js';
import type { HttpRequest } from '../../../../src/http/Types.js';
import { ConnectionTracker, trackSocket, wireConnection } from '../../../../src/http/websocket/ConnectionWiring.js';
import { WebsocketReadyState, type WebsocketListeners, type WebsocketSocketAdapter } from '../../../../src/http/websocket/SocketAdapter.js';
import type { WebsocketCloseInfo } from '../../../../src/http/websocket/Types.js';
import { jsonCodec } from '../../../../src/http/websocket/WebsocketCodec.js';
import type { OutCommand, WebsocketConnection } from '../../../../src/http/websocket/WebsocketConnection.js';
import type { WebsocketServerRef } from '../../../../src/http/websocket/WebsocketMessages.js';
import { DEFAULT_WEBSOCKET_POLICY, type ResolvedWebsocketPolicy } from '../../../../src/http/websocket/WebsocketPolicy.js';
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type PingMessage = { readonly kind: 'ping'; readonly n: number };
/** Answered with a reply and a close, in that order, in one hub turn. */
type GoodbyeMessage = { readonly kind: 'goodbye'; readonly n: number };
/** Answered with `abort(1008, 'rate limited')`: a peer the hub stops serving. */
type ViolationMessage = { readonly kind: 'violation'; readonly n: number };
type ClientMessage = PingMessage | GoodbyeMessage | ViolationMessage;

type PongMessage = { readonly kind: 'pong'; readonly n: number };
type ServerMessage = PongMessage;

/** Ask the hub to record that it got this far — see the header. */
type SentinelCommand = { readonly kind: 'sentinel'; readonly label: string };
/**
 * Run `body` inside one hub turn.  Recorded as `ran:<label>`, or as
 * `threw:<label>:<message>` — so an exception out of a connection method shows
 * up in the hook log instead of restarting the hub.
 */
type RunOnHubTurnCommand = { readonly kind: 'run-on-hub-turn'; readonly label: string; readonly body: () => void };
type HubCommand = SentinelCommand | RunOnHubTurnCommand;

/**
 * How many frames the abort tests queue ahead of the abort.  The backlog a
 * flooded connection would otherwise be handed first, at a size no stray
 * frame could be mistaken for.
 */
const BURST = 200;

/**
 * A socket that keeps the closing handshake's schedule, as `ws` does.
 *
 * `close()` moves it to CLOSING and the close event waits for the peer's
 * answer, so a frame the peer had already sent can still be delivered after
 * the server closed.  No `terminate` — the shape of the Hono adapter, which
 * cannot hard-close a socket.
 */
class HandshakeSocket implements WebsocketSocketAdapter {
  /** Every call the connection actor made on this socket, in order. */
  readonly calls: string[] = [];
  /** Every close event the transport raised, as `<code>:<reason>`. */
  readonly closeEvents: string[] = [];
  readonly remoteAddress = '127.0.0.1';
  /** What the transport really is; {@link readyState} is what it reports. */
  protected state: 0 | 1 | 2 | 3 = WebsocketReadyState.OPEN;
  private listeners: WebsocketListeners | null = null;
  private readonly pending: Array<(listeners: WebsocketListeners) => void> = [];

  get readyState(): 0 | 1 | 2 | 3 {
    return this.state;
  }

  send(data: string | Uint8Array): void {
    this.calls.push(`send:${typeof data === 'string' ? data : `${data.byteLength} bytes`}`);
  }

  close(code?: number, reason?: string): void {
    if (this.state !== WebsocketReadyState.OPEN) return;
    this.state = WebsocketReadyState.CLOSING;
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

  /** The peer closed the connection, from its side. */
  peerClosed(code: number, reason: string): void {
    this.raiseClose(code, reason);
  }

  /** The transport reports the socket closed — which it does exactly once. */
  protected raiseClose(code: number, reason: string): void {
    if (this.state === WebsocketReadyState.CLOSED) return;
    this.state = WebsocketReadyState.CLOSED;
    this.closeEvents.push(`${code}:${reason}`);
    this.dispatch((listeners) => listeners.onClose(code, reason));
  }

  private dispatch(event: (listeners: WebsocketListeners) => void): void {
    if (this.listeners) event(this.listeners);
    else this.pending.push(event);
  }
}

/**
 * A socket that can also be hard-closed, as the `ws`-backed adapters can.
 *
 * `terminate()` raises the close event `ws` raises for one — 1006, no reason —
 * and raises it synchronously, inside the call.  `ws` raises it a tick later,
 * once the TCP socket is destroyed; synchronous is the strictest timing an
 * adapter may have, and the one under which the order inside `abort()`
 * decides what the hub is told.
 */
class TerminableSocket extends HandshakeSocket {
  terminate(): void {
    if (this.state === WebsocketReadyState.CLOSED) return;
    this.calls.push('terminate');
    this.raiseClose(1006, '');
  }
}

/**
 * A hard-closable socket whose reported `readyState` never leaves OPEN.
 *
 * The adapter contract does not promise that `readyState` tracks a close, and
 * `websocketPackageAdapter` reports OPEN for a socket that exposes none.  On
 * such an adapter `isOpen` cannot see a close the connection actor made by
 * itself; only the actor's own record of it can.
 */
class StaleStateSocket extends TerminableSocket {
  override get readyState(): 0 | 1 | 2 | 3 {
    return WebsocketReadyState.OPEN;
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
      .with({ kind: 'violation' }, () => this.onViolation())
      .exhaustive();
  }

  private onPing(): void { /* recorded above; nothing to answer */ }

  /** The documented shape: answer, then close — nothing in between drains. */
  private onGoodbye(message: GoodbyeMessage): void {
    this.reply({ kind: 'pong', n: message.n });
    this.connection.close(1000, 'bye');
  }

  private onViolation(): void {
    this.connection.abort(1008, 'rate limited');
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
      .with({ kind: 'run-on-hub-turn' }, (c) => this.onRunOnHubTurn(c))
      .exhaustive();
  }

  private onSentinel(command: SentinelCommand): void {
    this.state.events.push(`sentinel:${command.label}`);
  }

  private onRunOnHubTurn(command: RunOnHubTurnCommand): void {
    try {
      command.body();
      this.state.events.push(`ran:${command.label}`);
    } catch (e) {
      this.state.events.push(`threw:${command.label}:${(e as Error).message}`);
    }
  }
}

/** Keeps every dead letter the system publishes. */
class DeadLetterCollector extends Actor<DeadLetter> {
  constructor(private readonly letters: DeadLetter[]) {
    super();
  }

  override onReceive(letter: DeadLetter): void {
    this.letters.push(letter);
  }
}

/** Death-watches every ref it is told, and records the name of each one that stops. */
class StopWatcher extends Actor<ActorRef | Terminated> {
  constructor(private readonly stopped: string[]) {
    super();
  }

  override onReceive(message: ActorRef | Terminated): void {
    if (message instanceof Terminated) this.onTerminated(message);
    else this.onWatch(message);
  }

  private onWatch(target: ActorRef): void {
    this.context.watch(target);
  }

  private onTerminated(message: Terminated): void {
    this.stopped.push(message.actor.path.name);
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
  /** Every dead letter published since the harness started. */
  readonly deadLetters: DeadLetter[];
  /** Names of the actors {@link watchStop} was asked about that have stopped. */
  readonly stopped: string[];
  /** Wire `socket` up as a new connection and wait until the hub has it. */
  readonly connect: <TSocket extends HandshakeSocket>(socket: TSocket, policy?: ResolvedWebsocketPolicy) => Promise<{
    readonly connection: WebsocketConnection<ServerMessage>;
    readonly socket: TSocket;
  }>;
  /** Tell the hub a sentinel and wait until it has handled it. */
  readonly sentinel: (label: string) => Promise<void>;
  /** Run `body` inside one hub turn and wait until that turn is over. */
  readonly runOnHubTurn: (label: string, body: () => void) => Promise<void>;
  /** Death-watch the connection actor behind `connection` — see {@link stopped}. */
  readonly watchStop: (connection: WebsocketConnection<ServerMessage>) => Promise<void>;
};

function harness(name: string): Harness {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  const state: HubState = { events: [], connections: [] };
  // Factory form, not the class form: each of these takes a constructor
  // argument (the record the test reads back).
  const hub = system.spawn(() => new RecordingHub(state), 'hub') as WebsocketServerRef<ServerMessage, ClientMessage, HubCommand>;
  const deadLetters: DeadLetter[] = [];
  system.eventStream.subscribe(system.spawn(() => new DeadLetterCollector(deadLetters), 'dead-letters'), DeadLetter);
  const stopped: string[] = [];
  const watcher = system.spawn(() => new StopWatcher(stopped), 'stop-watcher');
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

  const runOnHubTurn = async (label: string, body: () => void): Promise<void> => {
    hub.tell({ kind: 'run-on-hub-turn', label, body });
    await awaitCondition(
      () => state.events.some((event) => event === `ran:${label}` || event.startsWith(`threw:${label}:`)),
      { timeoutMs: 4_000, label: `the hub ran ${label}` },
    );
  };

  const watchStop = async (connection: WebsocketConnection<ServerMessage>): Promise<void> => {
    // The hub spawns each connection actor as its own child, named after the
    // connection's id.
    const connectionActor = await system.actorSelection(`/user/hub/${connection.id}`).resolveOne(2_000);
    watcher.tell(connectionActor);
  };

  return { hub, events: state.events, deadLetters, stopped, connect, sentinel, runOnHubTurn, watchStop };
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

describe('abort() acts before it returns (#1431)', () => {
  test(`${BURST} frames told in one hub turn, then abort(): none is written, and the socket is terminated before abort() returns`, async () => {
    const h = harness('ws-abort-burst');
    const { connection, socket } = await h.connect(new TerminableSocket());

    // Read on the stack abort() returned to, before the hub's turn is over.
    const atReturn: Array<{ readonly isOpen: boolean; readonly calls: readonly string[] }> = [];
    await h.runOnHubTurn('flood-then-abort', () => {
      for (let n = 0; n < BURST; n++) connection.tell({ kind: 'pong', n });
      connection.abort(1008, 'rate limited');
      atReturn.push({ isOpen: connection.isOpen, calls: [...socket.calls] });
    });
    expect(atReturn).toEqual([{ isOpen: false, calls: ['terminate'] }]);

    // The backlog never got a turn: the actor was stopped ahead of it, and a
    // stopped actor's queue is dead-lettered — every frame, in order.
    const backlog = (): DeadLetter[] => h.deadLetters.filter((letter) => letter.recipient.path.name === connection.id);
    await awaitCondition(() => backlog().length === BURST, {
      timeoutMs: 4_000,
      label: 'the aborted backlog was dead-lettered',
    });
    expect(backlog().map((letter) => (letter.message as OutCommand<ServerMessage>).message.n))
      .toEqual(Array.from({ length: BURST }, (_, n) => n));
    expect(socket.calls).toEqual(['terminate']);
  });

  test('the hub hears one onClientDisconnected, with the abort\'s code and reason as the server\'s — not the 1006 the socket\'s own close event carries', async () => {
    const h = harness('ws-abort-disconnect-info');
    const { connection, socket } = await h.connect(new TerminableSocket());

    await h.runOnHubTurn('abort', () => connection.abort(1008, 'rate limited'));
    // terminate() raised the transport's close event inside abort(), before it
    // returned: the event that, reported as it stands, would read as a close
    // the client made.
    expect(socket.closeEvents).toEqual(['1006:']);

    const disconnected = `disconnected:${connection.id}:1008:rate limited:server`;
    await awaitCondition(() => h.events.includes(disconnected), {
      timeoutMs: 4_000,
      label: 'the hub heard the abort',
    });
    await h.sentinel('after-the-abort');
    expect(h.events).toEqual([
      `connected:${connection.id}`,
      'ran:abort',
      disconnected,
      'sentinel:after-the-abort',
    ]);
  });

  test('without terminate, abort() closes with its code and reason before it returns, and no frame delivered afterwards reaches onMessage', async () => {
    const h = harness('ws-abort-without-terminate');
    const { connection, socket } = await h.connect(new HandshakeSocket());

    let callsAtReturn: readonly string[] = [];
    await h.runOnHubTurn('abort', () => {
      connection.abort(1008, 'rate limited');
      callsAtReturn = [...socket.calls];
      // Still the hub's turn, so the connection actor has not run yet.  The
      // socket is CLOSING, and `ws` still hands over a frame the peer sent
      // before it saw the close frame.
      socket.deliver({ kind: 'ping', n: 7 });
    });
    expect(callsAtReturn).toEqual(['close:1008:rate limited']);

    const disconnected = `disconnected:${connection.id}:1008:rate limited:server`;
    await awaitCondition(() => h.events.includes(disconnected), {
      timeoutMs: 4_000,
      label: 'the hub heard the abort',
    });
    // And once more, after the actor has stopped and reported.
    socket.deliver({ kind: 'ping', n: 8 });
    await h.sentinel('after-the-late-frames');

    expect(h.events).toEqual([
      `connected:${connection.id}`,
      'ran:abort',
      disconnected,
      'sentinel:after-the-late-frames',
    ]);
    expect(socket.calls).toEqual(['close:1008:rate limited']);
  });

  test('without arguments, abort() closes with 1008 and no reason', async () => {
    const h = harness('ws-abort-defaults');
    const { connection, socket } = await h.connect(new HandshakeSocket());

    connection.abort();
    expect(socket.calls).toEqual(['close:1008:']);

    const disconnected = `disconnected:${connection.id}:1008::server`;
    await awaitCondition(() => h.events.includes(disconnected), {
      timeoutMs: 4_000,
      label: 'the hub heard the abort',
    });
    await h.sentinel('after-the-abort');
    expect(h.events).toEqual([`connected:${connection.id}`, disconnected, 'sentinel:after-the-abort']);
  });

  test('isOpen reads false once abort() returns, even where readyState does not show the close', async () => {
    const h = harness('ws-abort-is-open');
    const { connection, socket } = await h.connect(new StaleStateSocket());

    connection.abort(1008, 'rate limited');
    // The adapter still reports OPEN, so only the connection's own record of
    // the abort can answer — and `broadcast` selects on this answer.
    expect(socket.readyState).toBe(WebsocketReadyState.OPEN);
    expect(connection.isOpen).toBe(false);

    const disconnected = `disconnected:${connection.id}:1008:rate limited:server`;
    await awaitCondition(() => h.events.includes(disconnected), {
      timeoutMs: 4_000,
      label: 'the hub heard the abort',
    });
    expect(socket.calls).toEqual(['terminate']);
  });
});

describe('abort() keeps the hub\'s per-connection order (#1431)', () => {
  test('frames the peer sent before the abort still reach onMessage, ahead of the one onClientDisconnected', async () => {
    const h = harness('ws-abort-inbound-order');
    const { connection, socket } = await h.connect(new TerminableSocket());

    // Three frames in one read, all forwarded to the hub before it runs: it
    // aborts the peer on the first, with the other two already queued for it.
    socket.deliver({ kind: 'violation', n: 0 });
    socket.deliver({ kind: 'ping', n: 1 });
    socket.deliver({ kind: 'ping', n: 2 });

    const disconnected = `disconnected:${connection.id}:1008:rate limited:server`;
    await awaitCondition(() => h.events.includes(disconnected), {
      timeoutMs: 4_000,
      label: 'the hub heard the abort',
    });
    await h.sentinel('after-the-abort');
    // The abort's disconnect queues behind them, as every disconnect does:
    // onClientConnected → onMessage* → onClientDisconnected still holds.
    expect(h.events).toEqual([
      `connected:${connection.id}`,
      `message:${connection.id}:0`,
      `message:${connection.id}:1`,
      `message:${connection.id}:2`,
      disconnected,
      'sentinel:after-the-abort',
    ]);
    expect(socket.calls).toEqual(['terminate']);
  });
});

describe('abort() on a connection that is no longer open does nothing (#1431)', () => {
  test('after close(): the ordered close stands, and the frame queued ahead of it is still written', async () => {
    const h = harness('ws-abort-after-close');
    const { connection, socket } = await h.connect(new TerminableSocket());

    await h.runOnHubTurn('close-then-abort', () => {
      connection.tell({ kind: 'pong', n: 1 });
      connection.close(1000, 'bye');
      connection.abort(1008, 'rate limited');
    });

    const disconnected = `disconnected:${connection.id}:1000:bye:server`;
    await awaitCondition(() => h.events.includes(disconnected), {
      timeoutMs: 4_000,
      label: 'the hub heard the ordered close',
    });
    await h.sentinel('after-the-close');
    expect(h.events).toEqual([
      `connected:${connection.id}`,
      'ran:close-then-abort',
      disconnected,
      'sentinel:after-the-close',
    ]);
    expect(socket.calls).toEqual(['send:{"kind":"pong","n":1}', 'close:1000:bye']);
  });

  test('a second abort(): the first one\'s code and reason stand, and the socket is terminated once', async () => {
    const h = harness('ws-abort-twice');
    const { connection, socket } = await h.connect(new TerminableSocket());

    await h.runOnHubTurn('abort-twice', () => {
      connection.abort(1008, 'rate limited');
      connection.abort(1011, 'second thoughts');
    });

    const disconnected = `disconnected:${connection.id}:1008:rate limited:server`;
    await awaitCondition(() => h.events.includes(disconnected), {
      timeoutMs: 4_000,
      label: 'the hub heard the first abort',
    });
    await h.sentinel('after-both-aborts');
    expect(h.events).toEqual([
      `connected:${connection.id}`,
      'ran:abort-twice',
      disconnected,
      'sentinel:after-both-aborts',
    ]);
    expect(socket.calls).toEqual(['terminate']);
  });

  test('after the connection actor has stopped: nothing is thrown, and no second disconnect is reported', async () => {
    const h = harness('ws-abort-after-stop');
    const { connection, socket } = await h.connect(new TerminableSocket());
    await h.watchStop(connection);

    socket.peerClosed(1000, 'bye');
    const disconnected = `disconnected:${connection.id}:1000:bye:client`;
    await awaitCondition(() => h.stopped.includes(connection.id) && h.events.includes(disconnected), {
      timeoutMs: 4_000,
      label: 'the connection actor stopped and the hub heard the client leave',
    });

    await h.runOnHubTurn('abort-after-stop', () => connection.abort(1008, 'rate limited'));
    await h.sentinel('after-the-abort');
    expect(h.events).toEqual([
      `connected:${connection.id}`,
      disconnected,
      'ran:abort-after-stop',
      'sentinel:after-the-abort',
    ]);
    expect(socket.calls).toEqual([]);
  });

  test('after the connection closed itself: its own code and reason stand, even where readyState does not show the close', async () => {
    const h = harness('ws-abort-after-own-close');
    const { connection, socket } = await h.connect(new StaleStateSocket());

    // The undecodable frame makes the connection actor close the socket
    // itself (1003 under the default policy), and the abort follows in the
    // same tick, before that actor has stopped.  This adapter still reports
    // OPEN, so `isOpen` reads true and the abort reaches the actor.
    socket.deliverRaw('not json {');
    expect(connection.isOpen).toBe(true);
    connection.abort(1008, 'rate limited');

    const disconnected = `disconnected:${connection.id}:1003:unsupported data:server`;
    await awaitCondition(() => h.events.some((event) => event.startsWith(`disconnected:${connection.id}:`)), {
      timeoutMs: 4_000,
      label: 'the hub heard the connection close',
    });
    // A frame the transport still hands over is dropped on the actor's own
    // record of the close, which this adapter's readyState would not show.
    socket.deliver({ kind: 'ping', n: 9 });
    await h.sentinel('after-the-abort');
    expect(h.events).toEqual([`connected:${connection.id}`, disconnected, 'sentinel:after-the-abort']);
    expect(socket.calls).toEqual(['close:1003:unsupported data']);
  });

  test('after the client closed it: the client\'s code and reason stand, even where readyState does not show the close', async () => {
    const h = harness('ws-abort-after-client-close');
    const { connection, socket } = await h.connect(new StaleStateSocket());

    // The peer's close event has reached the connection actor, which has not
    // stopped yet, and the abort follows in the same tick.  The adapter still
    // reports OPEN, so the abort reaches the actor here too.
    socket.peerClosed(1000, 'bye');
    expect(connection.isOpen).toBe(true);
    connection.abort(1008, 'rate limited');

    const disconnected = `disconnected:${connection.id}:1000:bye:client`;
    await awaitCondition(() => h.events.some((event) => event.startsWith(`disconnected:${connection.id}:`)), {
      timeoutMs: 4_000,
      label: 'the hub heard the connection close',
    });
    await h.sentinel('after-the-abort');
    expect(h.events).toEqual([`connected:${connection.id}`, disconnected, 'sentinel:after-the-abort']);
    expect(socket.calls).toEqual([]);
  });
});
