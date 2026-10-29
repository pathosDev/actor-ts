import { readFileSync } from 'node:fs';
import { connect as http2Connect, createSecureServer, type ClientHttp2Session } from 'node:http2';
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import {
  applyServerOptions,
  enforceSessionIdleTimeout,
  type Http2SessionLike,
  type NodeHttpServerLike,
} from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { HttpServerOptions } from '../../../src/http/HttpServerOptions.js';
import { completeText, get, path } from '../../../src/http/Route.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import type { HostTimers } from '../../../src/Scheduler.js';

/**
 * #870 — `idle-timeout` on an HTTP/2 session.
 *
 * `idle-timeout` used to reach a server only as `keepAliveTimeout`, which is an
 * HTTP/1.1 property: an HTTP/2 session never reads it.  Measured on node
 * v26.10.0 and bun 1.4.2, an h2 session that completed one request under
 * `keepAliveTimeout = 800` was still open past 5 s — on Fastify, where only
 * Fastify's own `http2SessionTimeout` was left to close it, and on a bare
 * `http2.createSecureServer`, where nothing was.
 *
 * The first repair armed the session's own timer, and that timer turned out
 * to be three different bounds.  It counts quiet time on the whole
 * connection, so it fired under a request whose handler was still working and
 * sent a GOAWAY mid-request; Bun fires it at twice its value (1.60 s for
 * 800 ms, against node's 0.80 s); and on Bun a PING frame counts as activity,
 * so a client pinging every 300 ms held an idle session open indefinitely —
 * 19 pings and still open at 6 s, where node closed at 0.81 s.
 *
 * The bound is now a timer of the framework's own, armed while the session has
 * no stream open: the HTTP/2 counterpart of `keepAliveTimeout`, which counts
 * only between requests.  The same value on both runtimes, no frame but a
 * stream's resets it, and a request in flight never sees a GOAWAY.  These
 * cases assert a window rather than an instant, and the window is narrow
 * enough that the doubled timer reads as wrong.
 *
 * Under `bun test` this is Bun's HTTP/2 server.  Node's own is reached by
 * `tests/smoke/cases/36-http-tls-termination.mjs` and
 * `tests/smoke/cases/49-http2-connection-bounds.mjs` under `bun run smoke`.
 */

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
const CERT = readFileSync(new URL('localhost-cert.pem', FIXTURES), 'utf8');
const KEY = readFileSync(new URL('localhost-key.pem', FIXTURES), 'utf8');
const CA = readFileSync(new URL('test-ca.pem', FIXTURES), 'utf8');

const IDLE_TIMEOUT_MS = 1_200;
/**
 * The latest an idle session may close: the value plus slack for a loaded
 * runner, and short of twice the value — the runtime timer Bun doubles.
 */
const CLOSE_WITHIN_MS = IDLE_TIMEOUT_MS + 1_000;
/** The earliest it may: half the value, so a session closed at once — or on some other timer — reads as wrong. */
const CLOSE_NOT_BEFORE_MS = IDLE_TIMEOUT_MS / 2;
/**
 * How long a session is watched: past {@link CLOSE_WITHIN_MS}, so one that is
 * never closed reports itself as still open rather than as a timeout.
 */
const WATCH_MS = 3_000;
/**
 * A handler that outlasts the idle timeout — and the doubled runtime timer
 * Bun fires — by a margin no runner's jitter closes.
 */
const SLOW_HANDLER_MS = 2 * IDLE_TIMEOUT_MS + 1_000;
/** A client that pings well inside the idle timeout. */
const PING_INTERVAL_MS = 300;
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

/** The framework-built Fastify backend over TLS + HTTP/2 under `idle-timeout`. */
async function fastifyHttp2(name: string): Promise<number> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
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
  return binding.port;
}

function expectClosedInsideTheWindow(closedAfterMs: number | null): void {
  expect(closedAfterMs, `an idle HTTP/2 session was still open ${WATCH_MS} ms after its last response`).not.toBeNull();
  expect(closedAfterMs!, 'the idle session was closed later than its idle-timeout allows').toBeLessThanOrEqual(CLOSE_WITHIN_MS);
  expect(closedAfterMs!, 'the session was closed long before its idle-timeout').toBeGreaterThanOrEqual(CLOSE_NOT_BEFORE_MS);
}

describe('idle-timeout bounds an idle HTTP/2 session', () => {
  test('on the framework-built Fastify backend, bound with withTls + withHttp2', async () => {
    const session = http2Client(await fastifyHttp2('http2-session-idle-fastify'));
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

  test('a client that sends PINGs more often than idle-timeout still has its idle session closed', async () => {
    // A PING carries no request.  Counted as activity — which Bun's own session
    // timer does — it let a client hold a connection open with no request on
    // it for a few bytes a second.
    const session = http2Client(await fastifyHttp2('http2-session-idle-ping'));
    const answered = await requestOnce(session);
    const pinger = setInterval(() => {
      if (!session.closed && !session.destroyed) session.ping(() => { /* the answer is not the point */ });
    }, PING_INTERVAL_MS);
    cleanups.push(() => { clearInterval(pinger); });
    const closedAfterMs = await closedAfter(session, answered.endedAt, WATCH_MS);

    expectClosedInsideTheWindow(closedAfterMs);
  }, LIVE_TEST_TIMEOUT_MS);

  test('a session that never opens a stream is closed at idle-timeout too', async () => {
    const port = await bareHttp2Server(IDLE_TIMEOUT_MS);
    const session = http2Client(port);
    await new Promise<void>((resolve) => { session.once('connect', () => { resolve(); }); });

    expectClosedInsideTheWindow(await closedAfter(session, performance.now(), WATCH_MS));
  }, LIVE_TEST_TIMEOUT_MS);

  test('a handler that outlasts idle-timeout is answered with no GOAWAY under it, and the session closes after it', async () => {
    // An open stream is a request in flight, not idleness — the HTTP/1.1 rule,
    // where keepAliveTimeout counts only between requests.  The runtime's own
    // session timer counted quiet time on the connection instead, fired while
    // the handler was still working, and sent the GOAWAY mid-request.
    const port = await bareHttp2Server(IDLE_TIMEOUT_MS, SLOW_HANDLER_MS);

    const session = http2Client(port);
    let goawayAt: number | null = null;
    session.on('goaway', () => { goawayAt ??= performance.now(); });
    const answered = await requestOnce(session);
    const closedAfterMs = await closedAfter(session, answered.endedAt, WATCH_MS);

    expect(answered.status, 'a request in flight was cut by the session closing').toBe(200);
    expect(answered.body).toBe('late but whole');
    expect(goawayAt === null || goawayAt >= answered.endedAt, 'a GOAWAY arrived while the handler was still working').toBe(true);
    expectClosedInsideTheWindow(closedAfterMs);
  }, LIVE_TEST_TIMEOUT_MS);
});

/**
 * The timer's bookkeeping against stand-ins for a session and its streams, on
 * host timers the test fires itself — what a live server cannot be made to
 * show on demand: which stream holds the session open, and that the
 * runtime's own session timer is out of the way.
 */
describe('the idle timer counts open streams', () => {
  type FakeStream = { once: (event: 'close', listener: () => void) => FakeStream; close: () => void };

  function fakeSession() {
    const streamListeners: Array<(...args: ReadonlyArray<unknown>) => void> = [];
    const closeListeners: Array<() => void> = [];
    const runtimeTimeouts: number[] = [];
    let closes = 0;
    const session: Http2SessionLike = {
      setTimeout: (milliseconds: number) => { runtimeTimeouts.push(milliseconds); },
      close: () => { closes++; },
      destroy: () => { /* not the idle timer's to call */ },
      on: (_event, listener) => { streamListeners.push(listener); return session; },
      once: (_event, listener) => { closeListeners.push(listener); return session; },
    };
    return {
      session,
      runtimeTimeouts,
      get closes() { return closes; },
      openStream: (): FakeStream => {
        const listeners: Array<() => void> = [];
        const stream: FakeStream = {
          once: (_event, listener) => { listeners.push(listener); return stream; },
          close: () => { for (const listener of listeners) listener(); },
        };
        for (const listener of streamListeners) listener(stream, {}, 0);
        return stream;
      },
      end: (): void => { for (const listener of closeListeners) listener(); },
    };
  }

  function guarded(idleTimeoutMs: number) {
    const sessionListeners: Array<(session: Http2SessionLike) => void> = [];
    const server = {
      on: ((event: string, listener: (session: Http2SessionLike) => void) => {
        if (event === 'session') sessionListeners.push(listener);
        return server;
      }) as NodeHttpServerLike['on'],
    } as NodeHttpServerLike;
    const pending = new Map<number, () => void>();
    let nextHandle = 0;
    const hostTimers: HostTimers = {
      setTimeout: (callback) => { nextHandle++; pending.set(nextHandle, callback); return nextHandle; },
      clearTimeout: (handle) => { pending.delete(handle as number); },
      setInterval: () => { throw new Error('the idle timer arms no interval'); },
      clearInterval: () => { /* nothing to clear */ },
    };
    enforceSessionIdleTimeout(server, idleTimeoutMs, hostTimers);
    return {
      connect: () => {
        const fake = fakeSession();
        for (const listener of sessionListeners) listener(fake.session);
        return fake;
      },
      get armed(): number { return pending.size; },
      fire: (): void => {
        const due = [...pending];
        pending.clear();
        for (const [, callback] of due) callback();
      },
    };
  }

  test('a new session is armed, and closed when the timer fires', () => {
    const server = guarded(IDLE_TIMEOUT_MS);
    const connection = server.connect();
    expect(server.armed).toBe(1);
    server.fire();

    expect(connection.closes).toBe(1);
  });

  test('a stream disarms it while open, and its close arms it again', () => {
    const server = guarded(IDLE_TIMEOUT_MS);
    const connection = server.connect();
    const stream = connection.openStream();
    expect(server.armed, 'the timer stayed armed under an open stream').toBe(0);
    server.fire();
    expect(connection.closes, 'the session was closed under an open stream').toBe(0);

    stream.close();
    expect(server.armed).toBe(1);
    server.fire();
    expect(connection.closes).toBe(1);
  });

  test('the session is idle only once its last stream has closed', () => {
    const server = guarded(IDLE_TIMEOUT_MS);
    const connection = server.connect();
    const first = connection.openStream();
    const second = connection.openStream();
    first.close();
    expect(server.armed, 'one stream closing armed the timer while another was open').toBe(0);

    second.close();
    expect(server.armed).toBe(1);
  });

  test('the runtime\'s own session timer is cleared, so the configured value is the one that governs', () => {
    // Fastify arms one at construction — 72 s, which Bun runs at 144 s — and a
    // value longer than that would otherwise be cut short by it.
    const connection = guarded(IDLE_TIMEOUT_MS).connect();

    expect(connection.runtimeTimeouts).toEqual([0]);
  });

  test('0 arms nothing and clears the runtime\'s timer: no idle bound at all', () => {
    const server = guarded(0);
    const connection = server.connect();

    expect(server.armed).toBe(0);
    expect(connection.runtimeTimeouts).toEqual([0]);
  });

  test('a session that ends takes its pending timer with it', () => {
    const server = guarded(IDLE_TIMEOUT_MS);
    const connection = server.connect();
    connection.end();

    expect(server.armed, 'a closed session left its idle timer armed').toBe(0);
  });
});
