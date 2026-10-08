import { readFileSync } from 'node:fs';
import { connect as http2Connect, createSecureServer, type ClientHttp2Session } from 'node:http2';
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { applyServerOptions, type NodeHttpServerLike } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { HttpServerOptions } from '../../../src/http/HttpServerOptions.js';
import { completeText, get, path } from '../../../src/http/Route.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

/**
 * #870 — `idle-timeout` on an HTTP/2 session.
 *
 * `idle-timeout` used to reach a server only as `keepAliveTimeout`, which is an
 * HTTP/1.1 property: an HTTP/2 session never reads it.  Measured on node
 * v26.10.0 and bun 1.4.2, an h2 session that completed one request under
 * `keepAliveTimeout = 800` was still open past 5 s — on Fastify, where only
 * Fastify's own 72 s `http2SessionTimeout` was left to close it, and on a bare
 * `http2.createSecureServer`, where nothing was.  Every idle client of an
 * HTTP/2 listener therefore held a connection a configured idle bound said it
 * would not.
 *
 * The bound now reaches the session through the session's own timer.  The two
 * runtimes do not fire it alike, and these cases assert a window rather than
 * an instant because of it: measured from the end of the response, node closed
 * at 0.80 s for 800 ms and 2.00 s for 2000 ms, **bun at 1.60 s and 4.00 s —
 * twice the value**, every time.  Nothing compensates for that; the docs state
 * both numbers.
 *
 * Under `bun test` this is Bun's HTTP/2 server.  Node's own is reached by
 * `tests/smoke/cases/36-http-tls-termination.mjs` under `bun run smoke`.
 */

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
const CERT = readFileSync(new URL('localhost-cert.pem', FIXTURES), 'utf8');
const KEY = readFileSync(new URL('localhost-key.pem', FIXTURES), 'utf8');
const CA = readFileSync(new URL('test-ca.pem', FIXTURES), 'utf8');

const IDLE_TIMEOUT_MS = 800;
/** The latest an idle session may close: twice the value — Bun's measured factor — plus slack for a loaded runner. */
const CLOSE_WITHIN_MS = 2 * IDLE_TIMEOUT_MS + 1_400;
/** The earliest it may: half the value, so a session closed at once — or on some other timer — reads as wrong. */
const CLOSE_NOT_BEFORE_MS = IDLE_TIMEOUT_MS / 2;
/**
 * How long a session is watched: past {@link CLOSE_WITHIN_MS}, so one that is
 * never closed reports itself as still open at 4.5 s rather than as a timeout.
 */
const WATCH_MS = 4_500;
/** A handler that outlasts the session timer on both runtimes, Bun's doubled one included. */
const SLOW_HANDLER_MS = 2 * IDLE_TIMEOUT_MS + 1_400;
/** Real sockets and multi-second windows: well past bun's 5 s default, stated rather than inherited. */
const LIVE_TEST_TIMEOUT_MS = 15_000;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** An HTTP/2 client session, verified against the test CA and destroyed after the test whatever happened. */
function http2Client(port: number): ClientHttp2Session {
  const session = http2Connect(`https://127.0.0.1:${port}`, { ca: CA });
  session.on('error', () => { /* observed as the 'close' that follows */ });
  cleanups.push(() => { session.destroy(); });
  return session;
}

/** One request on `session`; resolves once the response has ended, with what it said and when. */
function requestOnce(session: ClientHttp2Session): Promise<{ status: unknown; body: string; endedAt: number }> {
  return new Promise((resolve, reject) => {
    const request = session.request({ ':path': '/' });
    let status: unknown;
    let body = '';
    request.setEncoding('utf8');
    request.on('response', (headers) => { status = headers[':status']; });
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => { resolve({ status, body, endedAt: performance.now() }); });
    request.on('error', reject);
  });
}

/** How long after `since` the server closed `session`, or `null` while it is still open after `withinMs`. */
function closedAfter(session: ClientHttp2Session, since: number, withinMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (session.closed || session.destroyed) {
      resolve(performance.now() - since);
      return;
    }
    const timer = setTimeout(() => { resolve(null); }, withinMs);
    (timer as { unref?: () => void }).unref?.();
    session.once('close', () => {
      clearTimeout(timer);
      resolve(performance.now() - since);
    });
  });
}

/** A bare `http2.createSecureServer({ allowHTTP1 })`, as Hono on Node builds it, with the policy applied after `listen`. */
async function bareHttp2Server(idleTimeoutMs: number, handlerDelayMs = 0): Promise<number> {
  const server = createSecureServer({ cert: CERT, key: KEY, allowHTTP1: true }, (_request, response) => {
    if (handlerDelayMs === 0) {
      response.end('ok');
      return;
    }
    const timer = setTimeout(() => { response.end('late but whole'); }, handlerDelayMs);
    (timer as { unref?: () => void }).unref?.();
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  applyServerOptions(server as unknown as NodeHttpServerLike, { idleTimeoutMs });
  cleanups.push(() => { server.close(); });
  return (server.address() as { port: number }).port;
}

function expectClosedInsideTheWindow(closedAfterMs: number | null): void {
  expect(closedAfterMs, `an idle HTTP/2 session was still open ${WATCH_MS} ms after its last response`).not.toBeNull();
  expect(closedAfterMs!, 'the idle session was closed later than twice its idle-timeout').toBeLessThanOrEqual(CLOSE_WITHIN_MS);
  expect(closedAfterMs!, 'the session was closed long before its idle-timeout').toBeGreaterThanOrEqual(CLOSE_NOT_BEFORE_MS);
}

describe('idle-timeout bounds an idle HTTP/2 session', () => {
  test('on the framework-built Fastify backend, bound with withTls + withHttp2', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('http2-session-idle-fastify', systemOptions);
    cleanups.push(() => system.terminate());
    const serverOptions = HttpServerOptions.create()
      .withTls({ cert: CERT, key: KEY })
      .withHttp2()
      .withIdleTimeoutMs(IDLE_TIMEOUT_MS);
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .withServerOptions(serverOptions)
      .bind(path('', get(() => completeText(200, 'ok'))));
    cleanups.push(() => binding.unbind());

    const session = http2Client(binding.port);
    const answered = await requestOnce(session);
    const closedAfterMs = await closedAfter(session, answered.endedAt, WATCH_MS);

    // Over h2, or the case proves nothing about sessions: HTTP/1.1 on the same
    // port was already bounded by keepAliveTimeout.
    expect(session.alpnProtocol).toBe('h2');
    expect(answered.status).toBe(200);
    expectClosedInsideTheWindow(closedAfterMs);
  }, LIVE_TEST_TIMEOUT_MS);

  test('on a bare http2.createSecureServer handed to applyServerOptions', async () => {
    // The shape Hono on Node hands back, and a backend built by hand: the bound
    // has to reach a server whose construction actor-ts never saw.
    const port = await bareHttp2Server(IDLE_TIMEOUT_MS);

    const session = http2Client(port);
    const answered = await requestOnce(session);
    const closedAfterMs = await closedAfter(session, answered.endedAt, WATCH_MS);

    expect(session.alpnProtocol).toBe('h2');
    expect(answered.status).toBe(200);
    expectClosedInsideTheWindow(closedAfterMs);
  }, LIVE_TEST_TIMEOUT_MS);

  test('a handler that outlasts idle-timeout is still answered — the session closes after it, never under it', async () => {
    // The session timer counts quiet time on the connection, and a request whose
    // handler has not answered yet is quiet: measured on both runtimes, the
    // timer fires while the stream is still open.  A graceful close sends the
    // GOAWAY then and lets the stream finish; tearing the session down instead
    // would cut every slow handler, long poll and SSE stream at idle-timeout,
    // which HTTP/1.1's keepAliveTimeout — counted only between requests — never
    // did.  The GOAWAY arriving before the response is what proves the timer
    // fired mid-request rather than after it.
    const port = await bareHttp2Server(IDLE_TIMEOUT_MS, SLOW_HANDLER_MS);

    const session = http2Client(port);
    let goawayAt: number | null = null;
    session.on('goaway', () => { goawayAt ??= performance.now(); });
    const answered = await requestOnce(session);

    expect(goawayAt, 'the session timer never fired while the handler was busy').not.toBeNull();
    expect(goawayAt!, 'the session timer fired only after the response').toBeLessThan(answered.endedAt);
    expect(answered.status, 'a request in flight was cut by the session closing').toBe(200);
    expect(answered.body).toBe('late but whole');
    expect(await closedAfter(session, answered.endedAt, WATCH_MS), 'the closing session outlived its last stream').not.toBeNull();
  }, LIVE_TEST_TIMEOUT_MS);
});
