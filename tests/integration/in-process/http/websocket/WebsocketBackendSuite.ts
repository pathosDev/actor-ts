/**
 * Shared WebSocket integration suite, parameterised per HTTP backend.
 * Each backend's *.test.ts calls `runWebsocketBackendSuite(label, makeBackend)`.
 * Clients use the runtime's native `WebSocket` global (Bun provides one).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
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
import { Status } from '../../../../../src/http/Types.js';
import { WebsocketServerActor } from '../../../../../src/http/websocket/WebsocketServerActor.js';
import { websocket } from '../../../../../src/http/websocket/WebsocketRoute.js';
import { WebsocketRouteOptions } from '../../../../../src/http/websocket/WebsocketRouteOptions.js';
import type { WebsocketConnection } from '../../../../../src/http/websocket/WebsocketConnection.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

type SIn = { kind: 'ping'; n: number } | { kind: 'broadcast'; text: string };
type SOut = { kind: 'pong'; n: number } | { kind: 'bcast'; text: string };

class TestServer extends WebsocketServerActor<SOut, SIn> {
  constructor(private readonly events: string[]) {
    super();
  }
  onMessage(message: SIn): void {
    if (message.kind === 'ping') this.reply({ kind: 'pong', n: message.n });
    else this.broadcast({ kind: 'bcast', text: message.text });
  }
  override onClientConnected(c: WebsocketConnection<SOut>): void {
    this.events.push(`connect:${c.id}`);
  }
  override onClientDisconnected(c: WebsocketConnection<SOut>): void {
    this.events.push(`disconnect:${c.id}`);
  }
}

function wsOpen(url: string, timeoutMs = 3000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('timeout opening ws')), timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.onopen = null;
      ws.onerror = null;
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('ws errored before open'));
    };
    ws.onclose = (e) => {
      clearTimeout(timer);
      reject(new Error(`ws closed before open (code ${e.code})`));
    };
  });
}

function nextMessage<T = unknown>(ws: WebSocket, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
    ws.addEventListener(
      'message',
      (e: MessageEvent) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(e.data)) as T);
      },
      { once: true },
    );
  });
}

function nextClose(ws: WebSocket, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for close')), timeoutMs);
    ws.addEventListener(
      'close',
      (e: CloseEvent) => {
        clearTimeout(timer);
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
    const timer = setTimeout(() => (opened ? reject(new Error('opened unexpectedly')) : resolve()), timeoutMs);
    ws.onopen = () => {
      opened = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error('upgrade should have been rejected but opened'));
    };
    ws.onerror = () => { clearTimeout(timer); resolve(); };
    ws.onclose = () => { if (!opened) { clearTimeout(timer); resolve(); } };
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
      const server = system.spawn(() => new TestServer(events), 'ws-server');
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
      expect(await nextMessage<{ kind: string; n: number }>(ws)).toEqual({ kind: 'pong', n: 42 });
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
      const wsA = await wsOpen(`${base}/ws`);
      const wsB = await wsOpen(`${base}/ws`);
      const aGot = nextMessage(wsA);
      const bGot = nextMessage(wsB);
      wsA.send(JSON.stringify({ kind: 'broadcast', text: 'hello all' }));
      expect(await aGot).toEqual({ kind: 'bcast', text: 'hello all' });
      expect(await bGot).toEqual({ kind: 'bcast', text: 'hello all' });
      wsA.close();
      wsB.close();
    });

    test('oversize inbound frame closes the connection', async () => {
      const { base } = await bindServer([], (s) => {
        const routeOptions = WebsocketRouteOptions.create()
          .withMaxFrameBytes(64 * 1024);
        return websocket('/ws', s, routeOptions);
      });
      const ws = await wsOpen(`${base}/ws`);
      const closed = nextClose(ws);
      ws.send(JSON.stringify({ kind: 'broadcast', text: 'x'.repeat(80 * 1024) }));
      // Which layer refuses it — and therefore which close code the client
      // sees — is a property of the runtime, not of the guarantee.  Since #373
      // the transport is asked for the route's own 64 KiB rather than the 1 MiB
      // framework default, and where that is honoured the frame never reaches
      // the connection actor: Hono on Bun drops the connection and the client
      // synthesises 1006, Hono on Node gets a clean 1009 out of `ws`.  On
      // **Bun with Express or Fastify** it is not honoured — `ws` is Bun's
      // built-in shim there and ignores `maxPayload` — so the frame is
      // buffered whole and the connection actor sends the 1009 itself.  That
      // is the only runtime this suite ever executes on
      // (`package.json`: `test = bun test`), so on two of the three backends
      // the code below is the actor's, not the transport's.  Either way the
      // frame is refused before it is decoded, which is what this pins;
      // `BackendTransportFrameCap.test.ts` is where the layers are told apart.
      expect([1006, 1009]).toContain(await closed);
    });

    test('a route that raises maxFrameBytes past the framework default receives that frame (#373)', async () => {
      // The transport cap used to be the 1 MiB framework default on every
      // backend whatever the route asked for, so a frame in this band was cut
      // off by the runtime before the connection actor — which admits it —
      // ever saw it.  2 MiB is over that default and well under the route's
      // own cap, so only a transport sized from the route can deliver it.
      const { base } = await bindServer([], (s) => {
        const routeOptions = WebsocketRouteOptions.create()
          .withMaxFrameBytes(8 * 1024 * 1024);
        return websocket('/ws', s, routeOptions);
      });
      const ws = await wsOpen(`${base}/ws`);
      const text = 'x'.repeat(2 * 1024 * 1024);
      const echoed = nextMessage<{ kind: string; text: string }>(ws, 10_000);
      ws.send(JSON.stringify({ kind: 'broadcast', text }));

      const reply = await echoed;
      expect(reply.kind).toBe('bcast');
      // Compared by length: a mismatch on two megabytes of 'x' is unreadable
      // as a diff, and the length is what the cap is about anyway.
      expect(reply.text.length).toBe(text.length);
      ws.close();
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
      await awaitCondition(
        () => events.some((e) => e.startsWith('connect:'))
          && events.some((e) => e.startsWith('disconnect:')),
        { timeoutMs: 4_000, intervalMs: 10, label: 'the server saw both connect and disconnect' },
      );
      expect(events.some((e) => e.startsWith('connect:'))).toBe(true);
      expect(events.some((e) => e.startsWith('disconnect:'))).toBe(true);
    });

    test('a burst of open-then-close connections all disconnect (#570)', async () => {
      // The connection actor attaches its socket listeners from preStart —
      // two mailbox hops after the upgrade returns — and a client may close
      // inside that window.  An adapter that buffers messages but drops
      // close never stops the actor, never frees its maxConnections slot,
      // and reports one disconnect for the whole burst.
      //
      // The sequential test above cannot catch that: `await wsOpen(...)`
      // hands the server enough time to attach before the close arrives, so
      // it wins the race every time.  Concurrency is what widens the window.
      const events: string[] = [];
      const { base } = await bindServer(events, (s) => websocket('/ws', s));
      const burst = 20;

      await Promise.all(
        Array.from({ length: burst }, () => new Promise<void>((resolve) => {
          const ws = new WebSocket(`${base}/ws`);
          const done = (): void => { ws.onopen = null; ws.onerror = null; resolve(); };
          ws.onopen = () => { ws.close(); done(); };
          ws.onerror = () => done();
        })),
      );
      // The bug this guards is *missing* disconnects, so wait for them: a
      // fixed second is both slower than the healthy case and, on a loaded
      // runner, not necessarily longer than the unhealthy one.
      await awaitCondition(
        () => events.filter((e) => e.startsWith('disconnect:')).length >= burst,
        { timeoutMs: 4_000, intervalMs: 10, label: `all ${burst} bursted connections disconnected` },
      );
      // Both counts are exact, and a poll returns on the event that reaches
      // the target — so leave a beat for a surplus to show up.
      await sleep(50);

      const connects = events.filter((e) => e.startsWith('connect:')).length;
      const disconnects = events.filter((e) => e.startsWith('disconnect:')).length;
      expect(connects).toBe(burst);
      expect(disconnects).toBe(connects);
    });

    test('unbind with open connections resolves promptly (no hang)', async () => {
      const { base, binding } = await bindServer([], (s) => websocket('/ws', s));
      await wsOpen(`${base}/ws`);
      await wsOpen(`${base}/ws`);
      // Not a wait before an assertion — the elapsed time IS the assertion:
      // the claim is that `unbind` resolves rather than hanging on the two open
      // sockets, and this delay is the losing arm of the race that proves it.
      const done = await Promise.race([
        binding.unbind(500).then(() => 'unbound'),
        sleep(4000).then(() => 'timeout'),  // the elapsed time IS the assertion
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
      expect(await nextMessage<{ kind: string; n: number }>(ws)).toEqual({ kind: 'pong', n: 1 });
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
      const response = await fetch(`${httpBase}/health`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ok');

      const ws = await wsOpen(`${base}/ws`);
      ws.send(JSON.stringify({ kind: 'ping', n: 7 }));
      expect(await nextMessage<{ kind: string; n: number }>(ws)).toEqual({ kind: 'pong', n: 7 });
      ws.close();
    });
  });
}
