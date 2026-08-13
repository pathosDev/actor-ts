import { afterEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import express, { type RequestHandler } from 'express';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { HttpExtensionId } from '../../../../../src/http/HttpExtension.js';
import { ExpressBackend } from '../../../../../src/http/backend/ExpressBackend.js';
import { ExpressBackendOptions } from '../../../../../src/http/backend/ExpressBackendOptions.js';
import type { ServerBinding } from '../../../../../src/http/backend/HttpServerBackend.js';
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
import { runWebsocketBackendSuite } from './websocketBackendSuite.js';

runWebsocketBackendSuite('express', () => new ExpressBackend());

/*
 * #623 — a WebSocket handshake is dispatched through the Express app, so
 * everything the application installed with `app.use(...)` runs before the
 * socket is upgraded.  Before the fix the backend answered Node's `'upgrade'`
 * event itself and the whole middleware chain was skipped, which made an
 * `app.use(requireLogin)` silently ineffective for `/ws`.
 *
 * These live in the Express file rather than the shared backend suite because
 * "native middleware" means something different on each backend; the shared
 * suite covers the DSL guard that all three have.
 */

type Ping = { kind: 'ping'; n: number };
type Pong = { kind: 'pong'; n: number };

class EchoServer extends WebsocketServerActor<Pong, Ping> {
  onMessage(message: Ping): void {
    this.reply({ kind: 'pong', n: message.n });
  }
}

function openSocket(url: string, timeoutMs = 4000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('timeout opening ws')), timeoutMs);
    socket.onopen = () => { clearTimeout(timer); resolve(socket); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('ws errored before open')); };
    socket.onclose = (e) => { clearTimeout(timer); reject(new Error(`ws closed before open (code ${e.code})`)); };
  });
}

function nextMessage<T>(socket: WebSocket, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
    socket.addEventListener('message', (e: MessageEvent) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(e.data)) as T);
    }, { once: true });
  });
}

/** Resolves `true` when the handshake never completes. */
function upgradeRefused(url: string, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    let opened = false;
    const timer = setTimeout(() => resolve(!opened), timeoutMs);
    socket.onopen = () => {
      opened = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* ignore */ }
      resolve(false);
    };
    socket.onerror = () => { clearTimeout(timer); resolve(!opened); };
    socket.onclose = () => { if (!opened) { clearTimeout(timer); resolve(true); } };
  });
}

/**
 * Speak the handshake by hand and return the response's status line.  A
 * `WebSocket` client cannot express a non-GET upgrade, and never surfaces the
 * rejecting status to the page either.
 */
function rawUpgrade(port: number, method: string, target: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const connection = net.connect(port, '127.0.0.1', () => {
      connection.write(
        `${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    const finish = (): void => {
      if (!connection.destroyed) connection.destroy();
      resolve(Buffer.concat(chunks).toString('utf8').split('\r\n')[0] ?? '');
    };
    connection.on('data', (d: Buffer) => { chunks.push(d); if (chunks.length > 0) setTimeout(finish, 50); });
    connection.on('close', finish);
    connection.on('error', finish);
    setTimeout(finish, timeoutMs);
  });
}

describe('ExpressBackend — native app.use middleware at the WebSocket upgrade (#623)', () => {
  const systems: ActorSystem[] = [];
  const bindings: ServerBinding[] = [];

  afterEach(async () => {
    while (bindings.length) {
      try { await bindings.shift()!.unbind(); } catch { /* ignore */ }
    }
    await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
  });

  /** Bind `routes` on an injected Express app carrying `middleware`. */
  async function bindWithApp(
    middleware: RequestHandler,
    makeRoutes: (server: ReturnType<ActorSystem['spawn']>) => Route,
  ): Promise<{ base: string; port: number }> {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('ws-express-native', systemOptions);
    systems.push(system);
    const application = express();
    application.use(middleware);
    const backendOptions = ExpressBackendOptions.create().withApp(application);
    const server = system.spawn(EchoServer, 'echo');
    const binding = await system
      .extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(new ExpressBackend(backendOptions))
      .bind(makeRoutes(server));
    bindings.push(binding);
    return { base: `ws://127.0.0.1:${binding.port}`, port: binding.port };
  }

  test('the chain runs for a handshake and a rejecting middleware cancels it', async () => {
    const seen: string[] = [];
    const { base } = await bindWithApp(
      (request, response, next) => {
        seen.push(String(request.url));
        if (request.headers['x-token'] !== 'secret') { response.status(401).end('denied'); return; }
        next();
      },
      (s) => websocket('/ws', s),
    );

    // The browser WebSocket client cannot set headers, so the token is never
    // there: every handshake must be refused by the native middleware.
    expect(await upgradeRefused(`${base}/ws`)).toBe(true);
    expect(await upgradeRefused(`${base}/ws`)).toBe(true);

    // Guards the guard: a middleware that never ran would leave this empty
    // and the assertions above would pass for the wrong reason.  A floor
    // rather than an equality — some WebSocket clients retry a refused
    // handshake, which legitimately shows up as an extra invocation.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((url) => url.startsWith('/ws'))).toBe(true);
  });

  test('a middleware that calls next() lets the handshake through', async () => {
    let calls = 0;
    const { base } = await bindWithApp(
      (_request, _response, next) => { calls++; next(); },
      (s) => websocket('/ws', s),
    );

    const socket = await openSocket(`${base}/ws`);
    socket.send(JSON.stringify({ kind: 'ping', n: 5 }));
    expect(await nextMessage<Pong>(socket)).toEqual({ kind: 'pong', n: 5 });
    socket.close();
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  test('native middleware runs before the DSL guard, and the DSL guard still applies', async () => {
    const order: string[] = [];
    const dslGuard: Middleware = (request, next) => {
      order.push('dsl');
      return queryParam(request, 'token') === 'ok' ? next() : complete(Status.Unauthorized, 'denied');
    };
    const { base } = await bindWithApp(
      (_request, _response, next) => { order.push('native'); next(); },
      (s) => withMiddleware(dslGuard, websocket('/ws', s)),
    );

    expect(await upgradeRefused(`${base}/ws`)).toBe(true);
    expect(order.slice(0, 2)).toEqual(['native', 'dsl']);

    const socket = await openSocket(`${base}/ws?token=ok`);
    socket.send(JSON.stringify({ kind: 'ping', n: 1 }));
    expect(await nextMessage<Pong>(socket)).toEqual({ kind: 'pong', n: 1 });
    socket.close();
    // Every handshake contributes exactly this pair, in this order — the
    // slice keeps the assertion true if a client retried the refused one.
    expect(order.length).toBeGreaterThanOrEqual(4);
    expect(order.slice(-2)).toEqual(['native', 'dsl']);
  });

  test('a plain GET to a websocket path still falls through to the HTTP tree', async () => {
    let calls = 0;
    const { port } = await bindWithApp(
      (_request, _response, next) => { calls++; next(); },
      (s) => concat(websocket('/ws', s), path('health', get(() => completeText(Status.OK, 'ok')))),
    );

    // No `Upgrade:` header — this is an ordinary request and must not be
    // mistaken for a parked handshake.
    const response = await fetch(`http://127.0.0.1:${port}/ws`);
    expect(response.status).toBe(404);
    await response.text();

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test('an upgrade to an unrouted path is answered 404, a non-GET upgrade 405', async () => {
    const { port } = await bindWithApp(
      (_request, _response, next) => { next(); },
      (s) => websocket('/ws', s),
    );

    expect(await rawUpgrade(port, 'GET', '/nope')).toContain('404');
    // A POST carrying `Upgrade:` must never enter the app: the raw-body
    // middleware would try to drain a body from a socket the HTTP parser has
    // already handed over, and the handshake would hang instead of failing.
    expect(await rawUpgrade(port, 'POST', '/ws')).toContain('405');
  });
});
