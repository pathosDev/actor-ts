/**
 * Shared WebSocket integration suite, parameterised per HTTP backend.
 * Each backend's *.test.ts calls `runWebsocketBackendSuite(label, makeBackend)`.
 * Clients use the runtime's native `WebSocket` global (Bun provides one).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Props } from '../../../../../src/Props.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { HttpExtensionId } from '../../../../../src/http/HttpExtension.js';
import type { HttpServerBackend, ServerBinding } from '../../../../../src/http/backend/HttpServerBackend.js';
import {
  complete,
  completeText,
  concat,
  get,
  path,
  queryParam,
  withMiddleware,
  type Middleware,
  type Route,
} from '../../../../../src/http/Route.js';
import { Status } from '../../../../../src/http/types.js';
import { WebsocketServerActor } from '../../../../../src/http/websocket/WebsocketServerActor.js';
import { websocket } from '../../../../../src/http/websocket/WebsocketRoute.js';
import { WebsocketRouteOptions } from '../../../../../src/http/websocket/WebsocketRouteOptions.js';
import type { WebsocketConnection } from '../../../../../src/http/websocket/WebsocketConnection.js';

type SIn = { kind: 'ping'; n: number } | { kind: 'broadcast'; text: string };
type SOut = { kind: 'pong'; n: number } | { kind: 'bcast'; text: string };

class TestServer extends WebsocketServerActor<SOut, SIn> {
  constructor(private readonly events: string[]) {
    super();
  }
  onMessage(msg: SIn): void {
    if (msg.kind === 'ping') this.reply({ kind: 'pong', n: msg.n });
    else this.broadcast({ kind: 'bcast', text: msg.text });
  }
  override onClientConnected(c: WebsocketConnection<SOut>): void {
    this.events.push(`connect:${c.id}`);
  }
  override onClientDisconnected(c: WebsocketConnection<SOut>): void {
    this.events.push(`disconnect:${c.id}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function wsOpen(url: string, timeoutMs = 3000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => reject(new Error('timeout opening ws')), timeoutMs);
    ws.onopen = () => {
      clearTimeout(t);
      ws.onopen = null;
      ws.onerror = null;
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error('ws errored before open'));
    };
    ws.onclose = (e) => {
      clearTimeout(t);
      reject(new Error(`ws closed before open (code ${e.code})`));
    };
  });
}

function nextMessage<T = unknown>(ws: WebSocket, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
    ws.addEventListener(
      'message',
      (e: MessageEvent) => {
        clearTimeout(t);
        resolve(JSON.parse(String(e.data)) as T);
      },
      { once: true },
    );
  });
}

function nextClose(ws: WebSocket, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for close')), timeoutMs);
    ws.addEventListener(
      'close',
      (e: CloseEvent) => {
        clearTimeout(t);
        resolve(e.code);
      },
      { once: true },
    );
  });
}

/** Resolve if the upgrade is rejected (never opens); reject if it opens. */
function expectUpgradeRejected(url: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let opened = false;
    const t = setTimeout(() => (opened ? reject(new Error('opened unexpectedly')) : resolve()), timeoutMs);
    ws.onopen = () => {
      opened = true;
      clearTimeout(t);
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error('upgrade should have been rejected but opened'));
    };
    ws.onerror = () => { clearTimeout(t); resolve(); };
    ws.onclose = () => { if (!opened) { clearTimeout(t); resolve(); } };
  });
}

export function runWebsocketBackendSuite(label: string, makeBackend: () => HttpServerBackend): void {
  describe(`WebSocket integration — ${label}`, () => {
    const systems: ActorSystem[] = [];
    const bindings: ServerBinding[] = [];

    afterEach(async () => {
      while (bindings.length) {
        try { await bindings.shift()!.unbind(); } catch { /* ignore */ }
      }
      await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
    });

    // Bind a route tree using a server actor spawned in a fresh system.
    async function bindServer(events: string[], makeRoutes: (server: ReturnType<ActorSystem['spawn']>) => Route): Promise<{ base: string; binding: ServerBinding }> {
      const sysOptions = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off);
      const system = ActorSystem.create(`ws-${label}`, sysOptions);
      systems.push(system);
      const server = system.spawn(Props.create(() => new TestServer(events)), 'ws-server');
      const binding = await system
        .extension(HttpExtensionId)
        .newServerAt('127.0.0.1', 0)
        .useBackend(makeBackend())
        .bind(makeRoutes(server));
      bindings.push(binding);
      return { base: `ws://127.0.0.1:${binding.port}`, binding };
    }

    test('round-trip ping/pong', async () => {
      const { base } = await bindServer([], (s) => websocket('/ws', s));
      const ws = await wsOpen(`${base}/ws`);
      ws.send(JSON.stringify({ kind: 'ping', n: 42 }));
      expect(await nextMessage(ws)).toEqual({ kind: 'pong', n: 42 });
      ws.close();
    });

    test('first frame sent immediately on open is not lost (race)', async () => {
      const { base } = await bindServer([], (s) => websocket('/ws', s));
      for (let i = 0; i < 10; i++) {
        const ws = new WebSocket(`${base}/ws`);
        const got = nextMessage<{ kind: string; n: number }>(ws);
        ws.onopen = () => ws.send(JSON.stringify({ kind: 'ping', n: i }));
        expect(await got).toEqual({ kind: 'pong', n: i });
        ws.close();
      }
    });

    test('broadcast reaches all connected clients', async () => {
      const { base } = await bindServer([], (s) => websocket('/ws', s));
      const a = await wsOpen(`${base}/ws`);
      const b = await wsOpen(`${base}/ws`);
      const aGot = nextMessage(a);
      const bGot = nextMessage(b);
      a.send(JSON.stringify({ kind: 'broadcast', text: 'hello all' }));
      expect(await aGot).toEqual({ kind: 'bcast', text: 'hello all' });
      expect(await bGot).toEqual({ kind: 'bcast', text: 'hello all' });
      a.close();
      b.close();
    });

    test('oversize inbound frame closes the connection (1009)', async () => {
      const { base } = await bindServer([], (s) => {
        const routeOptions = WebsocketRouteOptions.create()
          .withMaxFrameBytes(64 * 1024);
        return websocket('/ws', s, routeOptions);
      });
      const ws = await wsOpen(`${base}/ws`);
      const closed = nextClose(ws);
      ws.send(JSON.stringify({ kind: 'broadcast', text: 'x'.repeat(80 * 1024) }));
      expect(await closed).toBe(1009);
    });

    test('invalid JSON closes the connection (1003) under the default policy', async () => {
      const { base } = await bindServer([], (s) => websocket('/ws', s));
      const ws = await wsOpen(`${base}/ws`);
      const closed = nextClose(ws);
      ws.send('this is not json {');
      expect(await closed).toBe(1003);
    });

    test('client close fires onClientDisconnected on the server', async () => {
      const events: string[] = [];
      const { base } = await bindServer(events, (s) => websocket('/ws', s));
      const ws = await wsOpen(`${base}/ws`);
      ws.close();
      await sleep(200);
      expect(events.some((e) => e.startsWith('connect:'))).toBe(true);
      expect(events.some((e) => e.startsWith('disconnect:'))).toBe(true);
    });

    test('unbind with open connections resolves promptly (no hang)', async () => {
      const { base, binding } = await bindServer([], (s) => websocket('/ws', s));
      await wsOpen(`${base}/ws`);
      await wsOpen(`${base}/ws`);
      const done = await Promise.race([
        binding.unbind(500).then(() => 'unbound'),
        sleep(4000).then(() => 'timeout'),
      ]);
      expect(done).toBe('unbound');
    });

    test('middleware runs at upgrade: rejected without token, accepted with', async () => {
      const auth: Middleware = (req, next) =>
        queryParam(req, 'token') === 'secret' ? next() : complete(Status.Unauthorized, 'denied');
      const { base } = await bindServer([], (s) => withMiddleware(auth, websocket('/ws', s)));

      await expectUpgradeRejected(`${base}/ws`);

      const ws = await wsOpen(`${base}/ws?token=secret`);
      ws.send(JSON.stringify({ kind: 'ping', n: 1 }));
      expect(await nextMessage(ws)).toEqual({ kind: 'pong', n: 1 });
      ws.close();
    });

    test('HTTP and WebSocket routes coexist in one tree', async () => {
      const { base } = await bindServer([], (s) =>
        concat(
          websocket('/ws', s),
          path('health', get(() => completeText(Status.OK, 'ok'))),
        ),
      );
      const httpBase = base.replace('ws://', 'http://');
      const res = await fetch(`${httpBase}/health`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');

      const ws = await wsOpen(`${base}/ws`);
      ws.send(JSON.stringify({ kind: 'ping', n: 7 }));
      expect(await nextMessage(ws)).toEqual({ kind: 'pong', n: 7 });
      ws.close();
    });
  });
}
