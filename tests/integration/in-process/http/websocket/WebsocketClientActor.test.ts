import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { HttpExtensionId } from '../../../../../src/http/HttpExtension.js';
import { FastifyBackend } from '../../../../../src/http/backend/FastifyBackend.js';
import type { ServerBinding } from '../../../../../src/http/backend/HttpServerBackend.js';
import type { Route } from '../../../../../src/http/Route.js';
import { websocket } from '../../../../../src/http/websocket/WebsocketRoute.js';
import { WebsocketServerActor } from '../../../../../src/http/websocket/WebsocketServerActor.js';
import { WebsocketClientActor } from '../../../../../src/http/websocket/WebsocketClientActor.js';
import { WebsocketClientOptions } from '../../../../../src/http/websocket/WebsocketClientOptions.js';
import { websocketSend, type WebsocketClientMessage } from '../../../../../src/http/websocket/WebsocketMessages.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

type CMessage = { kind: 'ping'; n: number };
type SMessage = { kind: 'pong'; n: number };

class PingServer extends WebsocketServerActor<SMessage, CMessage> {
  onMessage(m: CMessage): void { this.reply({ kind: 'pong', n: m.n }); }
}

type Rec = { events: string[]; messages: SMessage[] };

class RecordingClient extends WebsocketClientActor<CMessage, SMessage> {
  constructor(url: string, private readonly rec: Rec) {
    const clientOptions = WebsocketClientOptions.create<CMessage, SMessage>()
      .withUrl(url)
      .withReconnect({ initialDelayMs: 50, maxDelayMs: 200, factor: 2, maxAttempts: 40 });
    super(clientOptions);
  }
  onMessage(m: SMessage): void { this.rec.messages.push(m); }
  protected override onConnected(): void {
    this.rec.events.push('connected');
    this.send({ kind: 'ping', n: this.rec.events.filter((e) => e === 'connected').length });
  }
  protected override onDisconnected(): void { this.rec.events.push('disconnected'); }
}


describe('WebsocketClientActor', () => {
  const systems: ActorSystem[] = [];
  const bindings: ServerBinding[] = [];
  function mkSystem(name: string): ActorSystem {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create(name, sysOptions);
    systems.push(system);
    return system;
  }
  async function bindServer(system: ActorSystem, routes: Route, host = '127.0.0.1', port = 0): Promise<ServerBinding> {
    const binding = await system.extension(HttpExtensionId).newServerAt(host, port).useBackend(new FastifyBackend({ logger: false })).bind(routes);
    bindings.push(binding);
    return binding;
  }
  afterEach(async () => {
    while (bindings.length) { try { await bindings.shift()!.unbind(); } catch { /* ignore */ } }
    await Promise.all(systems.splice(0).map((system) => system.terminate().catch(() => {})));
  });

  test('typed client ↔ server round-trip through a real backend', async () => {
    const srvSys = mkSystem('cli-srv');
    const server = srvSys.spawn(PingServer, 'srv');
    const binding = await bindServer(srvSys, websocket('/ws', server));

    const rec: Rec = { events: [], messages: [] };
    const cliSys = mkSystem('cli');
    cliSys.spawn(() => new RecordingClient(`ws://127.0.0.1:${binding.port}/ws`, rec), 'client');

    await awaitCondition(() => rec.messages.length >= 1, {
      timeoutMs: 4_000, label: 'the first pong reached the client',
    });
    expect(rec.events).toContain('connected');
    expect(rec.messages[0]).toEqual({ kind: 'pong', n: 1 });
  });

  test('another actor can push a typed send via websocketSend(ref)', async () => {
    const srvSys = mkSystem('cli-srv2');
    const server = srvSys.spawn(PingServer, 'srv');
    const binding = await bindServer(srvSys, websocket('/ws', server));

    const rec: Rec = { events: [], messages: [] };
    const cliSys = mkSystem('cli2');
    const clientRef: ActorRef<WebsocketClientMessage<CMessage, SMessage>> =
      cliSys.spawn(() => new RecordingClient(`ws://127.0.0.1:${binding.port}/ws`, rec), 'client');

    await awaitCondition(() => rec.events.includes('connected'), {
      timeoutMs: 4_000, label: 'the client reported its first connect',
    });
    clientRef.tell(websocketSend({ kind: 'ping', n: 99 }));
    await awaitCondition(() => rec.messages.some((m) => m.n === 99), {
      timeoutMs: 4_000, label: 'the pong for the pushed ping reached the client',
    });
    expect(rec.messages.some((m) => m.n === 99)).toBe(true);
  });

  test('reconnects after the server goes away and comes back', async () => {
    const srvSys = mkSystem('cli-srv3');
    const server = srvSys.spawn(PingServer, 'srv');
    const b1 = await bindServer(srvSys, websocket('/ws', server));
    const port = b1.port;

    const rec: Rec = { events: [], messages: [] };
    const cliSys = mkSystem('cli3');
    cliSys.spawn(() => new RecordingClient(`ws://127.0.0.1:${port}/ws`, rec), 'client');
    await awaitCondition(() => rec.events.includes('connected'), {
      timeoutMs: 4_000, label: 'the client reported its first connect',
    });

    // Take the server down; the client should notice and start reconnecting.
    await b1.unbind();
    await awaitCondition(() => rec.events.includes('disconnected'), {
      timeoutMs: 6_000, label: 'the client noticed the server going away',
    });

    // Bring a fresh server up on the same port; the client should reconnect.
    const srvSys2 = mkSystem('cli-srv3b');
    const server2 = srvSys2.spawn(PingServer, 'srv');
    await bindServer(srvSys2, websocket('/ws', server2), '127.0.0.1', port);

    await awaitCondition(() => rec.events.filter((e) => e === 'connected').length >= 2, {
      timeoutMs: 8_000, label: 'the client reconnected to the replacement server',
    });
    const connects = rec.events.filter((e) => e === 'connected').length;
    expect(connects).toBeGreaterThanOrEqual(2);
    // A ping was sent on the second connect → expect a matching pong.
    await awaitCondition(() => rec.messages.some((m) => m.n >= 2), {
      timeoutMs: 4_000, label: 'the pong for the second connect reached the client',
    });
    expect(rec.messages.some((m) => m.n >= 2)).toBe(true);
    // The 8 000 ms budget above is the largest here, and bun kills a test at
    // 5 000 ms unless told otherwise — so without this third argument the
    // reconnect budget could never report its own label
    // (`tests/unit/ci/AwaitConditionBudgets.test.ts`).
  }, 15_000);
});
