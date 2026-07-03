import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { Props } from '../../../../src/Props.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { HttpRequest } from '../../../../src/http/types.js';
import { WebSocketServerActor } from '../../../../src/http/ws/WebSocketServerActor.js';
import { wireConnection } from '../../../../src/http/ws/ConnectionWiring.js';
import { DEFAULT_WS_POLICY, type ResolvedWsPolicy } from '../../../../src/http/ws/WsPolicy.js';
import { jsonCodec, WsDecodeError } from '../../../../src/http/ws/WsCodec.js';
import { DEFAULT_WS_MAX_FRAME_BYTES } from '../../../../src/http/ws/types.js';
import type {
  WebSocketListeners,
  WebSocketSocketAdapter,
} from '../../../../src/http/ws/SocketAdapter.js';
import type { WsConnection } from '../../../../src/http/ws/WsConnection.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** In-memory socket adapter with test hooks. */
class MockSocket implements WebSocketSocketAdapter {
  readyState: 0 | 1 | 2 | 3 = 1;
  readonly sent: Array<string | Uint8Array> = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  remoteAddress = '127.0.0.1';
  private listeners: WebSocketListeners | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.listeners?.onClose(code ?? 1000, reason ?? '');
  }
  setListeners(l: WebSocketListeners): void {
    this.listeners = l;
  }

  /* test helpers */
  emit(data: string | Uint8Array): void {
    this.listeners?.onMessage(data);
  }
  get textSent(): string[] {
    return this.sent.filter((s): s is string => typeof s === 'string');
  }
}

type In = { kind: 'ping'; n: number } | { kind: 'shout'; text: string };
type Out = { kind: 'pong'; n: number } | { kind: 'msg'; text: string };

class RecordingServer extends WebSocketServerActor<Out, In> {
  constructor(private readonly events: string[]) {
    super();
  }
  onMessage(msg: In): void {
    if (msg.kind === 'ping') {
      this.events.push(`ping:${msg.n}:conn:${this.connection.id}`);
      this.reply({ kind: 'pong', n: msg.n });
    } else {
      this.events.push(`shout:${msg.text.slice(0, 8)}`);
      this.broadcast({ kind: 'msg', text: msg.text });
    }
  }
  override onClientConnected(c: WsConnection<Out>): void {
    this.events.push(`connect:${c.id}`);
  }
  override onClientDisconnected(c: WsConnection<Out>, info: { code: number }): void {
    this.events.push(`disconnect:${c.id}:${info.code}`);
  }
}

const req = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
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
  const s = ActorSystem.create(name, { logger: new NoopLogger(), logLevel: LogLevel.Off });
  systems.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(systems.splice(0).map((s) => s.terminate()));
});

describe('WebSocketServerActor via wireConnection', () => {
  test('connected fires, onMessage receives decoded msg, reply reaches the socket', async () => {
    const system = newSystem('ws-hub-1');
    const events: string[] = [];
    const hub = system.spawn(Props.create(() => new RecordingServer(events)), 'hub');
    const sock = new MockSocket();
    const conn = wireConnection(system, hub, req(), sock, jsonCodec<Out, In>(), DEFAULT_WS_POLICY);

    sock.emit(JSON.stringify({ kind: 'ping', n: 5 }));
    await sleep(60);

    expect(events).toContain(`connect:${conn.id}`);
    expect(events).toContain(`ping:5:conn:${conn.id}`);
    expect(sock.textSent).toContain(JSON.stringify({ kind: 'pong', n: 5 }));
  });

  test('connected is mailbox-ordered before the first message (race)', async () => {
    const system = newSystem('ws-hub-race');
    const events: string[] = [];
    const hub = system.spawn(Props.create(() => new RecordingServer(events)), 'hub');
    const sock = new MockSocket();
    // Emit the first frame immediately after wiring — no gap.
    wireConnection(system, hub, req(), sock, jsonCodec<Out, In>(), DEFAULT_WS_POLICY);
    sock.emit(JSON.stringify({ kind: 'ping', n: 1 }));
    await sleep(60);

    const connectIdx = events.findIndex((e) => e.startsWith('connect:'));
    const pingIdx = events.findIndex((e) => e.startsWith('ping:'));
    expect(connectIdx).toBeGreaterThanOrEqual(0);
    expect(pingIdx).toBeGreaterThan(connectIdx);
  });

  test('broadcast reaches every open connection', async () => {
    const system = newSystem('ws-hub-bcast');
    const events: string[] = [];
    const hub = system.spawn(Props.create(() => new RecordingServer(events)), 'hub');
    const a = new MockSocket();
    const b = new MockSocket();
    wireConnection(system, hub, req(), a, jsonCodec<Out, In>(), DEFAULT_WS_POLICY);
    wireConnection(system, hub, req(), b, jsonCodec<Out, In>(), DEFAULT_WS_POLICY);
    await sleep(30);

    a.emit(JSON.stringify({ kind: 'shout', text: 'hi' }));
    await sleep(60);

    const expected = JSON.stringify({ kind: 'msg', text: 'hi' });
    expect(a.textSent).toContain(expected);
    expect(b.textSent).toContain(expected);
  });

  test('disconnect fires and the connection leaves the broadcast set', async () => {
    const system = newSystem('ws-hub-disc');
    const events: string[] = [];
    const hub = system.spawn(Props.create(() => new RecordingServer(events)), 'hub');
    const a = new MockSocket();
    const b = new MockSocket();
    const connA = wireConnection(system, hub, req(), a, jsonCodec<Out, In>(), DEFAULT_WS_POLICY);
    wireConnection(system, hub, req(), b, jsonCodec<Out, In>(), DEFAULT_WS_POLICY);
    await sleep(30);

    a.close(1000, 'bye');
    await sleep(60);
    expect(events).toContain(`disconnect:${connA.id}:1000`);

    // Broadcast now reaches only B.
    b.emit(JSON.stringify({ kind: 'shout', text: 'after' }));
    await sleep(60);
    const expected = JSON.stringify({ kind: 'msg', text: 'after' });
    expect(b.textSent).toContain(expected);
    expect(a.textSent).not.toContain(expected);
  });

  test('oversize inbound frame is closed (1009) and not delivered', async () => {
    const system = newSystem('ws-hub-oversize');
    const events: string[] = [];
    const hub = system.spawn(Props.create(() => new RecordingServer(events)), 'hub');
    const sock = new MockSocket();
    wireConnection(system, hub, req(), sock, jsonCodec<Out, In>(), DEFAULT_WS_POLICY);
    await sleep(20);

    const big = 'x'.repeat(DEFAULT_WS_MAX_FRAME_BYTES + 16);
    sock.emit(JSON.stringify({ kind: 'shout', text: big }));
    await sleep(40);

    expect(sock.closeCalls.some((c) => c.code === 1009)).toBe(true);
    expect(events.some((e) => e.startsWith('shout:'))).toBe(false);
  });

  test('sub-cap frame is delivered normally', async () => {
    const system = newSystem('ws-hub-subcap');
    const events: string[] = [];
    const hub = system.spawn(Props.create(() => new RecordingServer(events)), 'hub');
    const sock = new MockSocket();
    wireConnection(system, hub, req(), sock, jsonCodec<Out, In>(), DEFAULT_WS_POLICY);
    await sleep(20);

    sock.emit(JSON.stringify({ kind: 'shout', text: 'small' }));
    await sleep(40);
    expect(events).toContain('shout:small');
    expect(sock.closeCalls).toHaveLength(0);
  });

  test('invalid JSON closes with 1003 under the default policy', async () => {
    const system = newSystem('ws-hub-badjson');
    const events: string[] = [];
    const hub = system.spawn(Props.create(() => new RecordingServer(events)), 'hub');
    const sock = new MockSocket();
    wireConnection(system, hub, req(), sock, jsonCodec<Out, In>(), DEFAULT_WS_POLICY);
    await sleep(20);

    sock.emit('not json {');
    await sleep(40);
    expect(sock.closeCalls.some((c) => c.code === 1003)).toBe(true);
  });

  test("invalid JSON with 'hook' policy invokes onInvalidMessage and keeps the socket open", async () => {
    const system = newSystem('ws-hub-hook');
    const invalids: string[] = [];
    class HookServer extends WebSocketServerActor<Out, In> {
      onMessage(): void {}
      protected override onInvalidMessage(c: WsConnection<Out>, e: WsDecodeError): void {
        invalids.push(`${c.id}:${e.name}`);
      }
    }
    const hub = system.spawn(Props.create(() => new HookServer()), 'hub');
    const sock = new MockSocket();
    const policy: ResolvedWsPolicy = { ...DEFAULT_WS_POLICY, onInvalidMessage: 'hook' };
    const conn = wireConnection(system, hub, req(), sock, jsonCodec<Out, In>(), policy);
    await sleep(20);

    sock.emit('garbage{');
    await sleep(40);
    expect(invalids).toContain(`${conn.id}:WsDecodeError`);
    expect(sock.closeCalls).toHaveLength(0);
  });

  test('sending after close is a no-op (no throw, nothing written)', async () => {
    const system = newSystem('ws-hub-afterclose');
    const events: string[] = [];
    const hub = system.spawn(Props.create(() => new RecordingServer(events)), 'hub');
    const sock = new MockSocket();
    const conn = wireConnection(system, hub, req(), sock, jsonCodec<Out, In>(), DEFAULT_WS_POLICY);
    await sleep(20);

    sock.close(1000, 'gone');
    await sleep(30);
    const before = sock.sent.length;
    expect(() => conn.tell({ kind: 'pong', n: 1 })).not.toThrow();
    await sleep(30);
    expect(sock.sent.length).toBe(before);
  });

  test('connection exposes upgrade info (path, remoteAddress)', async () => {
    const system = newSystem('ws-hub-upgrade');
    const events: string[] = [];
    const hub = system.spawn(Props.create(() => new RecordingServer(events)), 'hub');
    const sock = new MockSocket();
    const conn = wireConnection(
      system,
      hub,
      req({ path: '/room/42', params: { id: '42' }, query: { token: 'abc' } }),
      sock,
      jsonCodec<Out, In>(),
      DEFAULT_WS_POLICY,
    );
    expect(conn.upgrade.path).toBe('/room/42');
    expect(conn.upgrade.params.id).toBe('42');
    expect(conn.upgrade.query.token).toBe('abc');
    expect(conn.remoteAddress).toBe('127.0.0.1');
    expect(conn.isOpen).toBe(true);
  });
});
