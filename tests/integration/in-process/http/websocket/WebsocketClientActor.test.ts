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
import { WebsocketClientOptions, type WebsocketClientOptionsType } from '../../../../../src/http/websocket/WebsocketClientOptions.js';
import { websocketSend, type WebsocketClientMessage } from '../../../../../src/http/websocket/WebsocketMessages.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';
import type { ConfigObject } from '../../../../../src/config/HoconParser.js';

type CMessage = { kind: 'ping'; n: number };
type SMessage = { kind: 'pong'; n: number };

class PingServer extends WebsocketServerActor<SMessage, CMessage> {
  onMessage(m: CMessage): void { this.reply({ kind: 'pong', n: m.n }); }
}

/**
 * Accepts the connection and never answers — the observable half of a peer
 * whose path was silently dropped: no `close`, no `error`, no frames (#753).
 */
class MuteServer extends WebsocketServerActor<SMessage, CMessage> {
  onMessage(_m: CMessage): void { /* deliberately mute */ }
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

/**
 * A client with a read-idle deadline.  Records the *cause* it was given, which
 * is what tells an idle timeout apart from an observed `close` (#753).
 */
class LivenessClient extends WebsocketClientActor<CMessage, SMessage> {
  constructor(url: string, idleTimeoutMs: number, private readonly rec: Rec) {
    const clientOptions = WebsocketClientOptions.create<CMessage, SMessage>()
      .withUrl(url)
      .withIdleTimeoutMs(idleTimeoutMs)
      .withReconnect(false);
    super(clientOptions);
  }
  onMessage(m: SMessage): void { this.rec.messages.push(m); }
  protected override onConnected(): void { this.rec.events.push('connected'); }
  protected override onDisconnected(cause?: Error): void {
    this.rec.events.push(`disconnected: ${cause?.message ?? '<none>'}`);
  }
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

  /* --------------------- read-idle deadline (#753) --------------------- */

  test('a server that accepts and then says nothing is reported as lost', async () => {
    const srvSys = mkSystem('cli-mute-srv');
    const server = srvSys.spawn(MuteServer, 'srv');
    const binding = await bindServer(srvSys, websocket('/ws', server));

    const rec: Rec = { events: [], messages: [] };
    const cliSys = mkSystem('cli-mute');
    cliSys.spawn(() => new LivenessClient(`ws://127.0.0.1:${binding.port}/ws`, 80, rec), 'client');

    // `close` and `error` never fire, so before the deadline existed this
    // client reported `connected` for as long as the process ran.
    await awaitCondition(() => rec.events.some((e) => e.startsWith('disconnected')), {
      timeoutMs: 4_000, label: 'the idle deadline reported the mute server as lost',
    });
    expect(rec.events).toContain('connected');
    // Routed through onSocketDown, so the user hook sees the real reason
    // rather than nothing at all.
    expect(rec.events.find((e) => e.startsWith('disconnected'))).toContain('idle timeout');
  });

  test('inbound frames keep the deadline from firing', async () => {
    const srvSys = mkSystem('cli-busy-srv');
    const server = srvSys.spawn(PingServer, 'srv');
    const binding = await bindServer(srvSys, websocket('/ws', server));

    const rec: Rec = { events: [], messages: [] };
    const cliSys = mkSystem('cli-busy');
    const clientRef: ActorRef<WebsocketClientMessage<CMessage, SMessage>> =
      cliSys.spawn(() => new LivenessClient(`ws://127.0.0.1:${binding.port}/ws`, 500, rec), 'client');
    await awaitCondition(() => rec.events.includes('connected'), {
      timeoutMs: 2_000, label: 'the client reported its first connect',
    });

    // Traffic every 50 ms against a 500 ms deadline — a tenfold margin, so a
    // failure here is the deadline ignoring inbound frames rather than a slow
    // machine.  The window spans two deadlines, which is what makes the
    // absence of a disconnect mean something.
    for (let round = 1; round <= 24; round++) {
      clientRef.tell(websocketSend({ kind: 'ping', n: round }));
      await new Promise<void>((resolve) => { setTimeout(resolve, 50); });  // the elapsed time IS the assertion: two deadline windows of traffic
    }
    expect(rec.messages.length).toBeGreaterThan(0);
    expect(rec.events.filter((e) => e.startsWith('disconnected'))).toEqual([]);
  }, 10_000);
});

/* ================== HOCON on-invalid-message (#871) ===================== */

/**
 * `onInvalidMessage` was the WebSocket client's one option with no HOCON
 * reader (#871).  Observed on the resolved options rather than by feeding a
 * malformed frame: the policy itself is covered where it is applied, and what
 * was missing was the read.
 *
 * No server is bound.  The actor resolves its options in `preStart`, before it
 * dials, so an unroutable URL with reconnect off is the cheapest fixture that
 * still runs the real resolution path.
 */
class OptionsProbeClient extends WebsocketClientActor<CMessage, SMessage> {
  /** Null until preStart resolved them — `options` throws before that. */
  resolvedOptions: WebsocketClientOptionsType<CMessage, SMessage> | null = null;
  constructor() {
    const clientOptions = WebsocketClientOptions.create<CMessage, SMessage>()
      .withReconnect(false);
    super(clientOptions);
  }
  override async preStart(): Promise<void> {
    await super.preStart();
    this.resolvedOptions = this.options;
  }
  onMessage(_m: SMessage): void { /* never reached */ }
}

describe('WebsocketClientActor — HOCON on-invalid-message (#871)', () => {
  async function resolveWith(
    name: string, websocketConfig: ConfigObject,
  ): Promise<WebsocketClientOptionsType<CMessage, SMessage>> {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      // Nested, never a dotted top-level key: a literal `'actor-ts.io.…'` key
      // stays literal in the parsed tree, so `hasPath` would answer from
      // reference.conf and the assertion would prove nothing.
      .withConfig({ 'actor-ts': { io: { broker: { websocket: websocketConfig } } } });
    const system = ActorSystem.create(name, sysOptions);
    try {
      const client = new OptionsProbeClient();
      system.spawn(() => client, 'client');
      await awaitCondition(() => client.resolvedOptions !== null, {
        timeoutMs: 4_000, label: 'the client resolved its options in preStart',
      });
      return client.resolvedOptions!;
    } finally {
      await system.terminate();
    }
  }

  test('the client block feeds onInvalidMessage', async () => {
    const resolved = await resolveWith('ws-client-on-invalid-message', {
      url: 'ws://127.0.0.1:1/ws',
      'on-invalid-message': 'disconnect',
    });
    // `disconnect` is the client's arm; the server-side key of the same name
    // spells its third value `close`, and the two lists are not swappable.
    expect(resolved.onInvalidMessage).toBe('disconnect');
  });

  test('an unset leaf stays unset, so the built-in default applies', async () => {
    const resolved = await resolveWith('ws-client-on-invalid-message-unset', {
      url: 'ws://127.0.0.1:1/ws',
    });
    // The reader must not punch a default in, or `undefined` would stop
    // meaning "not set" to the layer above it.
    expect(resolved.onInvalidMessage).toBeUndefined();
  });
});
