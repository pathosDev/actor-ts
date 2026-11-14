/**
 * #1756 — `idle-timeout` and `request-timeout` bound the HTTP/1.1 connections
 * on Fastify's HTTP/2 listener under Bun.
 *
 * With `withTls(...)` and `withHttp2()` a client can still negotiate HTTP/1.1
 * through ALPN on the same port.  Bun's HTTP/2 server hands such a connection
 * to handling that reads neither `keepAliveTimeout` nor `requestTimeout`, so on
 * bun 1.4.2 a keep-alive connection stayed open 6 s past its response under
 * `idle-timeout = 800ms`, and a body that stalled after 10 of its announced
 * 1000 bytes was still open after 40 s under `request-timeout = 2s` — where the
 * same policy on the TLS listener without HTTP/2 closed both.
 *
 * The bounds are now timers of the framework's own, armed per HTTP/1.1
 * connection, as HTTP/2 sessions and streams already were.  Under `bun test`
 * this is Bun's listener; on Node the runtime reads both properties itself,
 * which `tests/smoke/cases/49-http2-connection-bounds.mjs` holds.
 */
import { readFileSync } from 'node:fs';
import { connect, type TLSSocket } from 'node:tls';
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { HttpServerOptions } from '../../../src/http/HttpServerOptions.js';
import { completeText, concat, get, path, post } from '../../../src/http/Route.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
const CERT = readFileSync(new URL('localhost-cert.pem', FIXTURES), 'utf8');
const KEY = readFileSync(new URL('localhost-key.pem', FIXTURES), 'utf8');
const CA = readFileSync(new URL('test-ca.pem', FIXTURES), 'utf8');

const IDLE_TIMEOUT_MS = 800;
const REQUEST_TIMEOUT_MS = 1_500;
/** Slack on top of a bound for a loaded runner. */
const SLACK_MS = 1_200;
/** A handler that outlasts the idle timeout by a margin no jitter closes. */
const SLOW_HANDLER_MS = IDLE_TIMEOUT_MS * 3;
const LIVE_TEST_TIMEOUT_MS = 20_000;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Fastify over TLS + HTTP/2, framework-built, under `hocon`'s server block. */
async function fastifyHttp2(name: string, serverBlock: string): Promise<number> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(`actor-ts.http.backend = fastify\nactor-ts.http.server { ${serverBlock} }`));
  const system = ActorSystem.create(name, systemOptions);
  cleanups.push(() => system.terminate());
  const serverOptions = HttpServerOptions.create()
    .withTls({ cert: CERT, key: KEY })
    .withHttp2();
  const routes = concat(
    path('', get(() => completeText(200, 'ok'))),
    path('slow', get(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, SLOW_HANDLER_MS)); // the handler's own work, which the bound must not cut
      return completeText(200, 'late but whole');
    })),
    path('upload', post(() => completeText(200, 'received'))),
  );
  const binding = await system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .withServerOptions(serverOptions)
    .bind(routes);
  cleanups.push(() => binding.unbind(0));
  return binding.port;
}

/** A TLS connection that negotiated HTTP/1.1, destroyed after the test whatever happened. */
async function http1Connection(port: number): Promise<TLSSocket> {
  const socket = connect({ host: '127.0.0.1', port, ca: CA, servername: 'localhost', ALPNProtocols: ['http/1.1'] });
  socket.on('error', () => { /* observed as the 'close' that follows */ });
  cleanups.push(() => { socket.destroy(); });
  await new Promise<void>((resolve) => { socket.once('secureConnect', () => { resolve(); }); });
  expect(socket.alpnProtocol).toBe('http/1.1');
  return socket;
}

/** Everything the server sent until it closed the connection, and when it closed — or `null` while open after `withinMs`. */
function closedWithin(socket: TLSSocket, since: number, withinMs: number): Promise<{ afterMs: number | null; received: string }> {
  return new Promise((resolve) => {
    let received = '';
    socket.on('data', (chunk: Buffer) => { received += chunk.toString('latin1'); });
    if (socket.destroyed) {
      resolve({ afterMs: performance.now() - since, received });
      return;
    }
    const timer = setTimeout(() => { resolve({ afterMs: null, received }); }, withinMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve({ afterMs: performance.now() - since, received });
    });
  });
}

/** Send one GET and resolve when its whole response is in, with when that was. */
function getOnce(socket: TLSSocket, requestPath: string, bodyMarker: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let received = '';
    const onData = (chunk: Buffer): void => {
      received += chunk.toString('latin1');
      if (received.includes(bodyMarker)) {
        socket.off('data', onData);
        resolve(performance.now());
      }
    };
    socket.on('data', onData);
    socket.once('close', () => { reject(new Error(`closed before the response completed: ${JSON.stringify(received.slice(0, 120))}`)); });
    socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n`);
  });
}

describe('Fastify\'s HTTP/2 listener bounds the HTTP/1.1 connections on its port (#1756)', () => {
  test('idle-timeout closes a keep-alive HTTP/1.1 connection after its response', async () => {
    const port = await fastifyHttp2('h1-on-h2-idle', `idle-timeout = ${IDLE_TIMEOUT_MS}ms`);
    const socket = await http1Connection(port);
    const answeredAt = await getOnce(socket, '/', 'ok');

    const { afterMs } = await closedWithin(socket, answeredAt, IDLE_TIMEOUT_MS + SLACK_MS + 4_000);

    expect(afterMs, 'an idle HTTP/1.1 connection outlived idle-timeout').not.toBeNull();
    expect(afterMs!).toBeLessThanOrEqual(IDLE_TIMEOUT_MS + SLACK_MS);
    expect(afterMs!).toBeGreaterThanOrEqual(IDLE_TIMEOUT_MS / 2);
  }, LIVE_TEST_TIMEOUT_MS);

  test('a handler that outlasts idle-timeout is answered in full: the bound counts between requests only', async () => {
    const port = await fastifyHttp2('h1-on-h2-slow', `idle-timeout = ${IDLE_TIMEOUT_MS}ms`);
    const socket = await http1Connection(port);

    await getOnce(socket, '/slow', 'late but whole');
  }, LIVE_TEST_TIMEOUT_MS);

  test('request-timeout closes an HTTP/1.1 request whose body stalls', async () => {
    const port = await fastifyHttp2('h1-on-h2-stall', `request-timeout = ${REQUEST_TIMEOUT_MS}ms`);
    const socket = await http1Connection(port);
    const sentAt = performance.now();
    socket.write('POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: 1000\r\n\r\n0123456789');

    const { afterMs, received } = await closedWithin(socket, sentAt, REQUEST_TIMEOUT_MS + SLACK_MS + 6_000);

    expect(afterMs, 'a stalled HTTP/1.1 body outlived request-timeout').not.toBeNull();
    expect(afterMs!).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS + SLACK_MS);
    expect(received).toContain('408');
  }, LIVE_TEST_TIMEOUT_MS);

  test('a slow GET is not cut by request-timeout: its request was received in full', async () => {
    // request-timeout bounds the receive, never the handler: a GET has no body.
    const port = await fastifyHttp2('h1-on-h2-slow-get', `request-timeout = ${IDLE_TIMEOUT_MS}ms`);
    const socket = await http1Connection(port);

    await getOnce(socket, '/slow', 'late but whole');
  }, LIVE_TEST_TIMEOUT_MS);
});
