import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Props } from '../../../../../src/Props.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { HttpExtensionId } from '../../../../../src/http/HttpExtension.js';
import { FastifyBackend } from '../../../../../src/http/backend/FastifyBackend.js';
import type { ServerBinding } from '../../../../../src/http/backend/HttpServerBackend.js';
import type { Route } from '../../../../../src/http/Route.js';
import { websocket } from '../../../../../src/http/ws/WebSocketRoute.js';
import { WebSocketServerActor } from '../../../../../src/http/ws/WebSocketServerActor.js';
import { WebSocketClientActor } from '../../../../../src/http/ws/WebSocketClientActor.js';
import { WebSocketClientOptions } from '../../../../../src/http/ws/WebSocketClientOptions.js';
import { wsSend, type WsClientMessage } from '../../../../../src/http/ws/WsMessages.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';

type CMsg = { kind: 'ping'; n: number };
type SMsg = { kind: 'pong'; n: number };

class PingServer extends WebSocketServerActor<SMsg, CMsg> {
  onMessage(m: CMsg): void { this.reply({ kind: 'pong', n: m.n }); }
}

interface Rec { events: string[]; msgs: SMsg[] }

class RecordingClient extends WebSocketClientActor<CMsg, SMsg> {
  constructor(url: string, private readonly rec: Rec) {
    super(WebSocketClientOptions.create<CMsg, SMsg>()
      .withUrl(url)
      .withReconnect({ initialDelayMs: 50, maxDelayMs: 200, factor: 2, maxAttempts: 40 }));
  }
  onMessage(m: SMsg): void { this.rec.msgs.push(m); }
  protected override onConnected(): void {
    this.rec.events.push('connected');
    this.send({ kind: 'ping', n: this.rec.events.filter((e) => e === 'connected').length });
  }
  protected override onDisconnected(): void { this.rec.events.push('disconnected'); }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await sleep(25);
  }
}

describe('WebSocketClientActor', () => {
  const systems: ActorSystem[] = [];
  const bindings: ServerBinding[] = [];
  function mkSystem(name: string): ActorSystem {
    const s = ActorSystem.create(name, ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    systems.push(s);
    return s;
  }
  async function bindServer(system: ActorSystem, routes: Route, host = '127.0.0.1', port = 0): Promise<ServerBinding> {
    const b = await system.extension(HttpExtensionId).newServerAt(host, port).useBackend(new FastifyBackend({ logger: false })).bind(routes);
    bindings.push(b);
    return b;
  }
  afterEach(async () => {
    while (bindings.length) { try { await bindings.shift()!.unbind(); } catch { /* ignore */ } }
    await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
  });

  test('typed client ↔ server round-trip through a real backend', async () => {
    const srvSys = mkSystem('cli-srv');
    const server = srvSys.spawn(Props.create(() => new PingServer()), 'srv');
    const binding = await bindServer(srvSys, websocket('/ws', server));

    const rec: Rec = { events: [], msgs: [] };
    const cliSys = mkSystem('cli');
    cliSys.spawn(Props.create(() => new RecordingClient(`ws://127.0.0.1:${binding.port}/ws`, rec)), 'client');

    await waitUntil(() => rec.msgs.length >= 1);
    expect(rec.events).toContain('connected');
    expect(rec.msgs[0]).toEqual({ kind: 'pong', n: 1 });
  });

  test('another actor can push a typed send via wsSend(ref)', async () => {
    const srvSys = mkSystem('cli-srv2');
    const server = srvSys.spawn(Props.create(() => new PingServer()), 'srv');
    const binding = await bindServer(srvSys, websocket('/ws', server));

    const rec: Rec = { events: [], msgs: [] };
    const cliSys = mkSystem('cli2');
    const clientRef: ActorRef<WsClientMessage<CMsg, SMsg>> =
      cliSys.spawn(Props.create(() => new RecordingClient(`ws://127.0.0.1:${binding.port}/ws`, rec)), 'client');

    await waitUntil(() => rec.events.includes('connected'));
    clientRef.tell(wsSend({ kind: 'ping', n: 99 }));
    await waitUntil(() => rec.msgs.some((m) => m.n === 99));
    expect(rec.msgs.some((m) => m.n === 99)).toBe(true);
  });

  test('reconnects after the server goes away and comes back', async () => {
    const srvSys = mkSystem('cli-srv3');
    const server = srvSys.spawn(Props.create(() => new PingServer()), 'srv');
    const b1 = await bindServer(srvSys, websocket('/ws', server));
    const port = b1.port;

    const rec: Rec = { events: [], msgs: [] };
    const cliSys = mkSystem('cli3');
    cliSys.spawn(Props.create(() => new RecordingClient(`ws://127.0.0.1:${port}/ws`, rec)), 'client');
    await waitUntil(() => rec.events.includes('connected'));

    // Take the server down; the client should notice and start reconnecting.
    await b1.unbind();
    await waitUntil(() => rec.events.includes('disconnected'), 6000);

    // Bring a fresh server up on the same port; the client should reconnect.
    const srvSys2 = mkSystem('cli-srv3b');
    const server2 = srvSys2.spawn(Props.create(() => new PingServer()), 'srv');
    await bindServer(srvSys2, websocket('/ws', server2), '127.0.0.1', port);

    await waitUntil(() => rec.events.filter((e) => e === 'connected').length >= 2, 8000);
    const connects = rec.events.filter((e) => e === 'connected').length;
    expect(connects).toBeGreaterThanOrEqual(2);
    // A ping was sent on the second connect → expect a matching pong.
    await waitUntil(() => rec.msgs.some((m) => m.n >= 2), 4000);
    expect(rec.msgs.some((m) => m.n >= 2)).toBe(true);
  });
});
