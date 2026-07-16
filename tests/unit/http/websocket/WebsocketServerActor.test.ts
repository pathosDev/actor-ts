import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Props } from '../../../../src/Props.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { HttpRequest } from '../../../../src/http/types.js';
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';
import { wireConnection } from '../../../../src/http/websocket/ConnectionWiring.js';
import { DEFAULT_WEBSOCKET_POLICY, type ResolvedWebsocketPolicy } from '../../../../src/http/websocket/WebsocketPolicy.js';
import { jsonCodec, WebsocketDecodeError } from '../../../../src/http/websocket/WebsocketCodec.js';
import { DEFAULT_WEBSOCKET_MAX_FRAME_BYTES } from '../../../../src/http/websocket/types.js';
import type {
  WebsocketListeners,
  WebsocketSocketAdapter,
} from '../../../../src/http/websocket/SocketAdapter.js';
import type { WebsocketConnection } from '../../../../src/http/websocket/WebsocketConnection.js';
import type { WebsocketServerRef } from '../../../../src/http/websocket/WebsocketMessages.js';

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
    for (const fn of this.pending.splice(0)) fn(l);
  }

  /* test helpers */
  emit(data: string | Uint8Array): void {
    this.deliver((l) => l.onMessage(data));
  }
  private deliver(fn: (l: WebsocketListeners) => void): void {
    if (this.listeners) fn(this.listeners);
    else this.pending.push(fn);
  }
  get textSent(): string[] {
    return this.sent.filter((system): system is string => typeof system === 'string');
  }
}

type In = { kind: 'ping'; n: number } | { kind: 'shout'; text: string };
type Out = { kind: 'pong'; n: number } | { kind: 'msg'; text: string };

interface Rec {
  readonly events: string[];
  readonly connections: WebsocketConnection<Out>[];
  /** Number of child actors the hub had right after each connect/disconnect. */
  readonly childCounts: number[];
}

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
  const hub = system.spawn(Props.create(() => new RecordingServer(rec)), 'hub') as WebsocketServerRef<Out, In>;
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
    await sleep(80);

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
    await sleep(80);

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
    await sleep(60);

    socketA.emit(JSON.stringify({ kind: 'shout', text: 'hi' }));
    await sleep(60);

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
    await sleep(60);
    const connectionA = rec.connections[0]!;

    socketA.close(1000, 'bye');
    await sleep(80);
    expect(rec.events).toContain(`disconnect:${connectionA.id}`);

    // Broadcast now reaches only B.
    socketB.emit(JSON.stringify({ kind: 'shout', text: 'after' }));
    await sleep(60);
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
    await sleep(60);

    expect(sock.closeCalls.some((c) => c.code === 1009)).toBe(true);
    expect(rec.events.some((e) => e.startsWith('shout:'))).toBe(false);
  });

  test('sub-cap frame is delivered normally', async () => {
    const { rec, hub, system } = setup('ws-hub-subcap');
    const sock = new MockSocket();
    wire(system, hub, sock);
    await sleep(40);

    sock.emit(JSON.stringify({ kind: 'shout', text: 'small' }));
    await sleep(60);
    expect(rec.events).toContain('shout:small');
    expect(sock.closeCalls).toHaveLength(0);
  });

  test('invalid JSON closes with 1003 under the default policy', async () => {
    const { hub, system } = setup('ws-hub-badjson');
    const sock = new MockSocket();
    wire(system, hub, sock);
    await sleep(40);

    sock.emit('not json {');
    await sleep(60);
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
    const hub = system.spawn(Props.create(() => new HookServer()), 'hub') as WebsocketServerRef<Out, In>;
    const sock = new MockSocket();
    const policy: ResolvedWebsocketPolicy = { ...DEFAULT_WEBSOCKET_POLICY, onInvalidMessage: 'hook' };
    wireConnection(system, hub, request(), sock, jsonCodec<Out, In>(), policy);
    await sleep(40);

    sock.emit('garbage{');
    await sleep(60);
    expect(invalids.some((system) => system.endsWith(':WebsocketDecodeError'))).toBe(true);
    expect(sock.closeCalls).toHaveLength(0);
  });

  test('sending after close is a no-op (no throw, nothing written)', async () => {
    const { rec, hub, system } = setup('ws-hub-afterclose');
    const sock = new MockSocket();
    wire(system, hub, sock);
    await sleep(40);
    const connection = rec.connections[0]!;

    sock.close(1000, 'gone');
    await sleep(40);
    const before = sock.sent.length;
    expect(() => connection.tell({ kind: 'pong', n: 1 })).not.toThrow();
    await sleep(40);
    expect(sock.sent.length).toBe(before);
  });

  test('each connection is a child actor of the hub, cleaned up on disconnect', async () => {
    const { rec, hub, system } = setup('ws-hub-children');
    const socketA = new MockSocket();
    const socketB = new MockSocket();
    wire(system, hub, socketA);
    wire(system, hub, socketB);
    await sleep(80);

    // Two connections → the hub had 2 children by the second connect.
    expect(rec.connections).toHaveLength(2);
    expect(Math.max(...rec.childCounts)).toBeGreaterThanOrEqual(2);

    // Closing one stops its child → the hub's child count drops.
    socketA.close(1000, 'bye');
    await sleep(80);
    expect(rec.events.some((e) => e.startsWith('disconnect:'))).toBe(true);
    const afterDisconnect = rec.childCounts[rec.childCounts.length - 1]!;
    expect(afterDisconnect).toBe(1);
  });

  test('connection exposes upgrade info (path, params, query, remoteAddress)', async () => {
    const { rec, hub, system } = setup('ws-hub-upgrade');
    const sock = new MockSocket();
    wire(system, hub, sock, request({ path: '/room/42', params: { id: '42' }, query: { token: 'abc' } }));
    await sleep(60);

    const connection = rec.connections[0]!;
    expect(connection.upgrade.path).toBe('/room/42');
    expect(connection.upgrade.params.id).toBe('42');
    expect(connection.upgrade.query.token).toBe('abc');
    expect(connection.remoteAddress).toBe('127.0.0.1');
    expect(connection.isOpen).toBe(true);
  });
});
