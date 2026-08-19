import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { HttpRequest } from '../../../../src/http/Types.js';
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';
import { wireConnection } from '../../../../src/http/websocket/ConnectionWiring.js';
import { DEFAULT_WEBSOCKET_POLICY, type ResolvedWebsocketPolicy } from '../../../../src/http/websocket/WebsocketPolicy.js';
import { jsonCodec, WebsocketDecodeError } from '../../../../src/http/websocket/WebsocketCodec.js';
import { DEFAULT_WEBSOCKET_MAX_FRAME_BYTES } from '../../../../src/http/Constants.js';
import type {
  WebsocketListeners,
  WebsocketSocketAdapter,
} from '../../../../src/http/websocket/SocketAdapter.js';
import type { WebsocketConnection } from '../../../../src/http/websocket/WebsocketConnection.js';
import type { WebsocketServerRef } from '../../../../src/http/websocket/WebsocketMessages.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * In-memory socket adapter with test hooks.  Like the real adapters, it
 * BUFFERS inbound events until `setListeners` runs — the per-connection
 * actor attaches its listeners a mailbox-tick after `wireConnection`.
 */
class MockSocket implements WebsocketSocketAdapter {
  readyState: 0 | 1 | 2 | 3 = 1;
  readonly sent: Array<string | Uint8Array> = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  remoteAddress = '127.0.0.1';
  private listeners: WebsocketListeners | null = null;
  private readonly pending: Array<(l: WebsocketListeners) => void> = [];

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.deliver((l) => l.onClose(code ?? 1000, reason ?? ''));
  }
  setListeners(l: WebsocketListeners): void {
    this.listeners = l;
    for (const callback of this.pending.splice(0)) callback(l);
  }

  /* test helpers */
  emit(data: string | Uint8Array): void {
    this.deliver((l) => l.onMessage(data));
  }
  private deliver(callback: (l: WebsocketListeners) => void): void {
    if (this.listeners) callback(this.listeners);
    else this.pending.push(callback);
  }
  get textSent(): string[] {
    return this.sent.filter((system): system is string => typeof system === 'string');
  }
}

type In = { kind: 'ping'; n: number } | { kind: 'shout'; text: string };
type Out = { kind: 'pong'; n: number } | { kind: 'msg'; text: string };

type Rec = {
  readonly events: string[];
  readonly connections: WebsocketConnection<Out>[];
  /** Number of child actors the hub had right after each connect/disconnect. */
  readonly childCounts: number[];
};

class RecordingServer extends WebsocketServerActor<Out, In> {
  constructor(private readonly rec: Rec) {
    super();
  }
  onMessage(message: In): void {
    if (message.kind === 'ping') {
      this.rec.events.push(`ping:${message.n}:conn:${this.connection.id}`);
      this.reply({ kind: 'pong', n: message.n });
    } else {
      this.rec.events.push(`shout:${message.text.slice(0, 8)}`);
      this.broadcast({ kind: 'msg', text: message.text });
    }
  }
  protected override onClientConnected(c: WebsocketConnection<Out>): void {
    this.rec.connections.push(c);
    this.rec.events.push(`connect:${c.id}`);
    // The per-connection actor is spawned as THIS hub's child.
    this.rec.childCounts.push(this.context.children.length);
  }
  protected override onClientDisconnected(c: WebsocketConnection<Out>): void {
    this.rec.events.push(`disconnect:${c.id}`);
    this.rec.childCounts.push(this.context.children.length);
  }
}

const request = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  method: 'GET',
  path: '/ws',
  headers: {},
  query: {},
  params: {},
  body: null,
  ...overrides,
});

const systems: ActorSystem[] = [];
function newSystem(name: string): ActorSystem {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, sysOptions);
  systems.push(system);
  return system;
}
afterEach(async () => {
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

/** Spawn a recording hub and wire a mock connection to it. */
function setup(name: string): { rec: Rec; hub: WebsocketServerRef<Out, In>; system: ActorSystem } {
  const system = newSystem(name);
  const rec: Rec = { events: [], connections: [], childCounts: [] };
  const hub = system.spawn(() => new RecordingServer(rec), 'hub') as WebsocketServerRef<Out, In>;
  return { rec, hub, system };
}

function wire(system: ActorSystem, hub: WebsocketServerRef<Out, In>, sock: MockSocket, r: HttpRequest = request(), policy: ResolvedWebsocketPolicy = DEFAULT_WEBSOCKET_POLICY): void {
  wireConnection(system, hub, r, sock, jsonCodec<Out, In>(), policy);
}

describe('WebsocketServerActor via wireConnection (child-per-connection)', () => {
  test('connected fires, onMessage receives decoded msg, reply reaches the socket', async () => {
    const { rec, hub, system } = setup('ws-hub-1');
    const sock = new MockSocket();
    wire(system, hub, sock);
    sock.emit(JSON.stringify({ kind: 'ping', n: 5 }));
    // Wait on the send, not on the handler's own recording: `reply` is a
    // `tell` to the per-connection actor, so `sock.send` runs in a LATER turn
    // than the `rec.events.push` beside it.  Waiting on the push returns while
    // the pong is still sitting in a mailbox (#1145).  This subsumes the
    // recording — the pong cannot be sent before the ping was handled.
    await awaitCondition(() => sock.textSent.length >= 1, {
      timeoutMs: 4_000,
      label: 'the pong reached the socket',
    });

    expect(rec.connections).toHaveLength(1);
    expect(rec.events).toContain(`connect:${rec.connections[0]!.id}`);
    expect(rec.events).toContain(`ping:5:conn:${rec.connections[0]!.id}`);
    expect(sock.textSent).toContain(JSON.stringify({ kind: 'pong', n: 5 }));
  });

  test('connected is mailbox-ordered before the first message (race)', async () => {
    const { rec, hub, system } = setup('ws-hub-race');
    const sock = new MockSocket();
    // Emit the first frame immediately after wiring — buffered by the
    // adapter until the child attaches its listeners.
    wire(system, hub, sock);
    sock.emit(JSON.stringify({ kind: 'ping', n: 1 }));
    await awaitCondition(() => rec.events.some((e) => e.startsWith('ping:')), {
      timeoutMs: 4_000,
      label: 'the ping was recorded',
    });

    const connectIndex = rec.events.findIndex((e) => e.startsWith('connect:'));
    const pingIndex = rec.events.findIndex((e) => e.startsWith('ping:'));
    expect(connectIndex).toBeGreaterThanOrEqual(0);
    expect(pingIndex).toBeGreaterThan(connectIndex);
  });

  test('broadcast reaches every open connection', async () => {
    const { rec, hub, system } = setup('ws-hub-bcast');
    const socketA = new MockSocket();
    const socketB = new MockSocket();
    wire(system, hub, socketA);
    wire(system, hub, socketB);
    await awaitCondition(() => rec.connections.length === 2, {
      timeoutMs: 4_000,
      label: 'both sockets connected',
    });

    socketA.emit(JSON.stringify({ kind: 'shout', text: 'hi' }));
    await awaitCondition(() => socketA.textSent.length >= 1 && socketB.textSent.length >= 1, {
      timeoutMs: 4_000,
      label: 'the broadcast reached both sockets',
    });

    const expected = JSON.stringify({ kind: 'msg', text: 'hi' });
    expect(rec.connections).toHaveLength(2);
    expect(socketA.textSent).toContain(expected);
    expect(socketB.textSent).toContain(expected);
  });

  test('client close fires onClientDisconnected and leaves the broadcast set', async () => {
    const { rec, hub, system } = setup('ws-hub-disc');
    const socketA = new MockSocket();
    const socketB = new MockSocket();
    wire(system, hub, socketA);
    wire(system, hub, socketB);
    await awaitCondition(() => rec.connections.length === 2, {
      timeoutMs: 4_000,
      label: 'both sockets connected',
    });
    const connectionA = rec.connections[0]!;

    socketA.close(1000, 'bye');
    await awaitCondition(() => rec.events.includes(`disconnect:${connectionA.id}`), {
      timeoutMs: 4_000,
      label: 'the closed socket was recorded as disconnected',
    });
    expect(rec.events).toContain(`disconnect:${connectionA.id}`);

    // Broadcast now reaches only B.
    socketB.emit(JSON.stringify({ kind: 'shout', text: 'after' }));
    await awaitCondition(() => socketB.textSent.length >= 1, {
      timeoutMs: 4_000,
      label: 'the second broadcast reached B',
    });
    // A must not have received it — nothing to poll for, so a short settle.
    await sleep(30);
    const expected = JSON.stringify({ kind: 'msg', text: 'after' });
    expect(socketB.textSent).toContain(expected);
    expect(socketA.textSent).not.toContain(expected);
  });

  test('oversize inbound frame is closed (1009) and not delivered', async () => {
    const { rec, hub, system } = setup('ws-hub-oversize');
    const sock = new MockSocket();
    wire(system, hub, sock);
    await sleep(40);

    const big = 'x'.repeat(DEFAULT_WEBSOCKET_MAX_FRAME_BYTES + 16);
    sock.emit(JSON.stringify({ kind: 'shout', text: big }));
    await awaitCondition(() => sock.closeCalls.some((c) => c.code === 1009), {
      timeoutMs: 4_000,
      label: 'the oversize frame closed the socket with 1009',
    });

    expect(sock.closeCalls.some((c) => c.code === 1009)).toBe(true);
    expect(rec.events.some((e) => e.startsWith('shout:'))).toBe(false);
  });

  test('sub-cap frame is delivered normally', async () => {
    const { rec, hub, system } = setup('ws-hub-subcap');
    const sock = new MockSocket();
    wire(system, hub, sock);
    await sleep(40);

    sock.emit(JSON.stringify({ kind: 'shout', text: 'small' }));
    await awaitCondition(() => rec.events.includes('shout:small'), {
      timeoutMs: 4_000,
      label: 'the in-limit frame was delivered',
    });
    // The socket must stay open, which only a settle can show.
    await sleep(30);
    expect(rec.events).toContain('shout:small');
    expect(sock.closeCalls).toHaveLength(0);
  });

  test('invalid JSON closes with 1003 under the default policy', async () => {
    const { hub, system } = setup('ws-hub-badjson');
    const sock = new MockSocket();
    wire(system, hub, sock);
    await sleep(40);

    sock.emit('not json {');
    await awaitCondition(() => sock.closeCalls.some((c) => c.code === 1003), {
      timeoutMs: 4_000,
      label: 'the malformed frame closed the socket with 1003',
    });
    expect(sock.closeCalls.some((c) => c.code === 1003)).toBe(true);
  });

  test("invalid JSON with 'hook' policy invokes onInvalidMessage and keeps the socket open", async () => {
    const system = newSystem('ws-hub-hook');
    const invalids: string[] = [];
    class HookServer extends WebsocketServerActor<Out, In> {
      onMessage(): void {}
      protected override onInvalidMessage(c: WebsocketConnection<Out>, e: WebsocketDecodeError): void {
        invalids.push(`${c.id}:${e.name}`);
      }
    }
    const hub = system.spawn(HookServer, 'hub') as WebsocketServerRef<Out, In>;
    const sock = new MockSocket();
    const policy: ResolvedWebsocketPolicy = { ...DEFAULT_WEBSOCKET_POLICY, onInvalidMessage: 'hook' };
    wireConnection(system, hub, request(), sock, jsonCodec<Out, In>(), policy);
    await sleep(40);

    sock.emit('garbage{');
    await awaitCondition(() => invalids.some((entry) => entry.endsWith(':WebsocketDecodeError')), {
      timeoutMs: 4_000,
      label: 'the decode error reached the hook',
    });
    // The hook policy must not close the socket — that half needs a settle.
    await sleep(30);
    expect(invalids.some((system) => system.endsWith(':WebsocketDecodeError'))).toBe(true);
    expect(sock.closeCalls).toHaveLength(0);
  });

  test('sending after close is a no-op (no throw, nothing written)', async () => {
    const { rec, hub, system } = setup('ws-hub-afterclose');
    const sock = new MockSocket();
    wire(system, hub, sock);
    await awaitCondition(() => rec.connections.length === 1, {
      timeoutMs: 4_000,
      label: 'the socket connected',
    });
    const connection = rec.connections[0]!;

    sock.close(1000, 'gone');
    await awaitCondition(() => rec.events.some((e) => e.startsWith('disconnect:')), {
      timeoutMs: 4_000,
      label: 'the close was recorded as a disconnect',
    });
    const before = sock.sent.length;
    expect(() => connection.tell({ kind: 'pong', n: 1 })).not.toThrow();
    // A settle, not a wait: the assertion is that nothing arrives, and there
    // is no condition to poll for an absence.  So this one stays a `sleep` —
    // it can only ever pass too easily (a write that was merely slow reads as
    // a write that never happened), never flake.
    await sleep(40);
    expect(sock.sent.length).toBe(before);
  });

  test('each connection is a child actor of the hub, cleaned up on disconnect', async () => {
    const { rec, hub, system } = setup('ws-hub-children');
    const socketA = new MockSocket();
    const socketB = new MockSocket();
    wire(system, hub, socketA);
    wire(system, hub, socketB);
    await awaitCondition(() => rec.connections.length === 2, {
      timeoutMs: 4_000,
      label: 'both sockets connected',
    });

    // Two connections → the hub had 2 children by the second connect.
    expect(rec.connections).toHaveLength(2);
    expect(Math.max(...rec.childCounts)).toBeGreaterThanOrEqual(2);

    // Closing one stops its child, and the hub's child count drops.
    //
    // Read at the *next* event rather than inside `onClientDisconnected`, and
    // that distinction is the interesting part.  A connection actor reports its
    // disconnect from `postStop`, while the `childTerminated` that unregisters
    // it from the parent is sent afterwards, from the rest of the same
    // termination.  So the hook can run before the child is off the parent's
    // list — the hub's own `clients` map is already correct, but the raw
    // `context.children` view still counts a child that is finishing stopping,
    // because it genuinely is still finishing stopping.  Whether the hook sees
    // that transient depends purely on how fast the hub's next turn is
    // scheduled, so asserting on it pins the scheduler rather than the
    // cleanup.  Connecting a third socket reads the count once the dust has
    // settled, which is the durable property this test is named for: 2 means
    // B and C, with A's child gone; a leak would read 3.
    socketA.close(1000, 'bye');
    await awaitCondition(() => rec.events.some((e) => e.startsWith('disconnect:')), {
      timeoutMs: 4_000,
      label: 'the disconnect hook fired',
    });

    const socketC = new MockSocket();
    wire(system, hub, socketC);
    await awaitCondition(() => rec.connections.length === 3, {
      timeoutMs: 4_000,
      label: 'the third socket connected',
    });
    expect(rec.childCounts[rec.childCounts.length - 1]).toBe(2);
  });

  test('connection exposes upgrade info (path, params, query, remoteAddress)', async () => {
    const { rec, hub, system } = setup('ws-hub-upgrade');
    const sock = new MockSocket();
    wire(system, hub, sock, request({ path: '/room/42', params: { id: '42' }, query: { token: 'abc' } }));
    await awaitCondition(() => rec.connections.length === 1, {
      timeoutMs: 4_000,
      label: 'the socket connected',
    });

    const connection = rec.connections[0]!;
    expect(connection.upgrade.path).toBe('/room/42');
    expect(connection.upgrade.params.id).toBe('42');
    expect(connection.upgrade.query.token).toBe('abc');
    expect(connection.remoteAddress).toBe('127.0.0.1');
    expect(connection.isOpen).toBe(true);
  });
});
