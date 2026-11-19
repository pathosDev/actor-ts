import { readFileSync } from 'node:fs';
import { connect as http2Connect, type ClientHttp2Session } from 'node:http2';
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { setHttp2SessionIdleDefaultOverride } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { HttpServerOptions } from '../../../src/http/HttpServerOptions.js';
import { completeText, get, path } from '../../../src/http/Route.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { setRuntimeOverride } from '../../../src/runtime/Detect.js';
import { resetHonoRunnerCache } from '../../../src/runtime/http/index.js';

/**
 * #1757 — an idle HTTP/2 session on a listener with `idle-timeout` **unset**,
 * driven live: a client that opens no stream and sends a PING every 50 ms.
 *
 * Unset, the session used to be the backend's and the runtime's: on Fastify
 * under Bun the runtime's own session timer, which a PING resets, so such a
 * client held the connection for as long as it liked; on Hono under Node no
 * timer at all.  The framework now arms its own PING-blind timer at
 * `DEFAULT_HTTP2_SESSION_IDLE_TIMEOUT_MS`.  That default is 72 s, so the
 * internal seam `setHttp2SessionIdleDefaultOverride` shortens it for the run —
 * the path is the unset one all the same, since a set `idle-timeout` never
 * reads the seam.
 *
 * The pairs `bun test` can reach: Fastify on Bun's `node:http2`, and Hono on
 * the Node runner (`@hono/node-server` over `http2.createSecureServer`), which
 * runs under Bun with the runtime forced to `node`.  Hono on Bun is `Bun.serve`,
 * whose own idle timeout already bounds the session and hands no server back.
 * Node's own `node:http2` is driven by
 * `tests/smoke/cases/49-http2-connection-bounds.mjs`.
 */

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
const CERT = readFileSync(new URL('localhost-cert.pem', FIXTURES), 'utf8');
const KEY = readFileSync(new URL('localhost-key.pem', FIXTURES), 'utf8');
const CA = readFileSync(new URL('test-ca.pem', FIXTURES), 'utf8');

/** The default the seam stands in for 72 s. */
const DEFAULT_STAND_IN_MS = 300;
/** A client that pings well inside the default. */
const PING_INTERVAL_MS = 50;
/** The latest the session may close: the default plus slack for a loaded runner. */
const CLOSE_WITHIN_MS = DEFAULT_STAND_IN_MS + 1_200;
/** The earliest: half the default, so a session closed at once reads as wrong. */
const CLOSE_NOT_BEFORE_MS = DEFAULT_STAND_IN_MS / 2;
/** How long the session is watched: past {@link CLOSE_WITHIN_MS}, so one never closed reports as still open. */
const WATCH_MS = 3_000;
/** Real sockets and a multi-second watch: stated rather than inherited from bun's 5 s default. */
const LIVE_TEST_TIMEOUT_MS = 15_000;

/**
 * `@hono/node-server` replaces `globalThis.Request` and `Response` the first
 * time `serve()` runs, and the override outlives the case; put back after it,
 * as `HonoOnNodePong.test.ts` does.
 */
const nativeGlobals = { Request: globalThis.Request, Response: globalThis.Response };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  setHttp2SessionIdleDefaultOverride(null);
  setRuntimeOverride(null);
  resetHonoRunnerCache();
  Object.defineProperty(globalThis, 'Request', { value: nativeGlobals.Request, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'Response', { value: nativeGlobals.Response, configurable: true, writable: true });
});

/** Bind `backend` over TLS + HTTP/2 with `idle-timeout` unset; resolves with the port. */
async function boundUnset(backend: 'fastify' | 'hono', name: string): Promise<number> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { http: { backend } } });
  const system = ActorSystem.create(name, systemOptions);
  cleanups.push(() => system.terminate());
  const serverOptions = HttpServerOptions.create()
    .withTls({ cert: CERT, key: KEY })
    .withHttp2();
  const binding = await system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .withServerOptions(serverOptions)
    .bind(path('', get(() => completeText(200, 'ok'))));
  cleanups.push(() => binding.unbind(0));
  expect(binding.serverOptionsReport?.http2SessionIdleDefaultMs).toBe(DEFAULT_STAND_IN_MS);
  return binding.port;
}

/** An HTTP/2 client session, verified against the test CA, connected, and destroyed after the test whatever happened. */
async function connectedClient(port: number): Promise<ClientHttp2Session> {
  const session = http2Connect(`https://127.0.0.1:${port}`, { ca: CA, servername: 'localhost' });
  session.on('error', () => { /* observed as the 'close' that follows */ });
  cleanups.push(() => { session.destroy(); });
  await new Promise<void>((resolve, reject) => {
    session.once('connect', () => { resolve(); });
    session.once('close', () => { reject(new Error('the session closed before it connected')); });
  });
  return session;
}

/**
 * Ping `session` every {@link PING_INTERVAL_MS} and resolve with how long after
 * the start it was closed, or `null` while still open after {@link WATCH_MS}.
 */
function pingedUntilClosed(session: ClientHttp2Session): Promise<number | null> {
  const since = performance.now();
  const pinger = setInterval(() => {
    if (!session.closed && !session.destroyed) session.ping(() => { /* the answer is not the point */ });
  }, PING_INTERVAL_MS);
  cleanups.push(() => { clearInterval(pinger); });
  return new Promise((resolve) => {
    const watch = setTimeout(() => { resolve(null); }, WATCH_MS);
    session.once('close', () => {
      clearTimeout(watch);
      resolve(performance.now() - since);
    });
  });
}

function expectClosedAtTheDefault(closedAfterMs: number | null): void {
  expect(closedAfterMs, `an idle HTTP/2 session pinged every ${PING_INTERVAL_MS} ms was still open ${WATCH_MS} ms in, with idle-timeout unset`).not.toBeNull();
  expect(closedAfterMs!, 'the idle session was closed later than the default allows').toBeLessThanOrEqual(CLOSE_WITHIN_MS);
  expect(closedAfterMs!, 'the idle session was closed long before the default').toBeGreaterThanOrEqual(CLOSE_NOT_BEFORE_MS);
}

describe('idle-timeout unset: a pinged HTTP/2 session with no stream is closed at the default (#1757)', () => {
  test('on Fastify under Bun', async () => {
    setHttp2SessionIdleDefaultOverride(DEFAULT_STAND_IN_MS);
    const session = await connectedClient(await boundUnset('fastify', 'http2-idle-default-fastify'));

    // Over h2, or the case proves nothing about sessions.
    expect(session.alpnProtocol).toBe('h2');
    expectClosedAtTheDefault(await pingedUntilClosed(session));
  }, LIVE_TEST_TIMEOUT_MS);

  test('on Hono over the Node runner', async () => {
    setRuntimeOverride('node');
    resetHonoRunnerCache();
    setHttp2SessionIdleDefaultOverride(DEFAULT_STAND_IN_MS);
    const session = await connectedClient(await boundUnset('hono', 'http2-idle-default-hono'));

    expect(session.alpnProtocol).toBe('h2');
    expectClosedAtTheDefault(await pingedUntilClosed(session));
  }, LIVE_TEST_TIMEOUT_MS);
});
