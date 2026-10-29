import { readFileSync } from 'node:fs';
import { connect as http2Connect, type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { HttpServerOptions } from '../../../src/http/HttpServerOptions.js';
import { completeText, concat, get, path, post } from '../../../src/http/Route.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { sleep } from '../../util/AwaitCondition.js';

/**
 * #870 — `request-timeout` on an HTTP/2 stream.
 *
 * The bound used to reach a server only as `requestTimeout`, a property of the
 * HTTP/1.1 connection handling that no HTTP/2 stream reads, and the session's
 * idle timer could not stand in for it: a stream waiting on its body is not
 * idle to anything but that timer, whose `close()` lets the open stream
 * finish, and a body trickled a byte at a time never lets it fire at all.
 * Measured at the commit before this one on bun 1.4.2 and node v26.10.0, a
 * POST that announced 1000 bytes and sent 10 was still open 12 s later under
 * `request-timeout = 2s`, as was a body trickled every 500 ms, while the
 * binding reported `requestTimeoutMs: true`.
 *
 * Each stream now carries its own receive deadline, armed when its request
 * opens and spent once the client has finished sending: a stream whose
 * request is still arriving at `request-timeout` is answered `408` and reset.
 * A request already received in full is never cut, however long its handler
 * takes — the HTTP/1.1 rule, where `requestTimeout` bounds the receive and
 * never the response.
 *
 * Under `bun test` this is Bun's HTTP/2 server; Node's own is reached by
 * `tests/smoke/cases/49-http2-connection-bounds.mjs` under `bun run smoke`.
 */

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
const CERT = readFileSync(new URL('localhost-cert.pem', FIXTURES), 'utf8');
const KEY = readFileSync(new URL('localhost-key.pem', FIXTURES), 'utf8');
const CA = readFileSync(new URL('test-ca.pem', FIXTURES), 'utf8');

const REQUEST_TIMEOUT_MS = 1_000;
/** The latest a stalled stream may be answered: the deadline, plus slack for a loaded runner. */
const CUT_WITHIN_MS = REQUEST_TIMEOUT_MS + 1_500;
/** The earliest: half the deadline, so a stream cut at once — or by some other timer — reads as wrong. */
const CUT_NOT_BEFORE_MS = REQUEST_TIMEOUT_MS / 2;
/** A handler that outlasts the deadline by a margin no runner's jitter closes. */
const SLOW_HANDLER_MS = REQUEST_TIMEOUT_MS + 800;
/** How long a stream is watched before it counts as never answered. */
const WATCH_MS = 4_000;
/** Real sockets and multi-second windows: past bun's 5 s default, stated rather than inherited. */
const LIVE_TEST_TIMEOUT_MS = 15_000;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A handler slower than the deadline; the case is that the server lets it finish. */
async function slowAnswer() {
  await sleep(SLOW_HANDLER_MS); // the handler's own work, the thing the deadline must not cut — not a test-side wait
  return completeText(200, 'slow');
}

const routes = concat(
  path('upload', post(() => completeText(200, 'uploaded'))),
  path('slow', concat(post(slowAnswer), get(slowAnswer))),
);

/** Bind the framework-built Fastify backend over TLS + HTTP/2 under `request-timeout`. */
async function bindHttp2(): Promise<number> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('http2-stream-request-timeout', systemOptions);
  cleanups.push(() => system.terminate());
  const serverOptions = HttpServerOptions.create()
    .withTls({ cert: CERT, key: KEY })
    .withHttp2()
    .withRequestTimeoutMs(REQUEST_TIMEOUT_MS);
  const binding = await system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .withServerOptions(serverOptions)
    .bind(routes);
  cleanups.push(() => binding.unbind());
  return binding.port;
}

/** An HTTP/2 client session, verified against the test CA and destroyed after the test whatever happened. */
function http2Client(port: number): ClientHttp2Session {
  const session = http2Connect(`https://127.0.0.1:${port}`, { ca: CA });
  session.on('error', () => { /* observed as the stream's own outcome */ });
  cleanups.push(() => { session.destroy(); });
  return session;
}

type Outcome = {
  /** The status the server answered, or `undefined` when it answered none. */
  readonly status: number | undefined;
  /** When the stream closed, measured from when it opened; `null` when it was still open at the end of the watch. */
  readonly closedAfterMs: number | null;
};

/**
 * Open `headers` on `session`, let `feed` write to the stream, and resolve with
 * what the server did within {@link WATCH_MS}.  The stream is destroyed on every
 * path, so a case never leaves one open.
 */
function watchStream(
  session: ClientHttp2Session,
  headers: Record<string, string>,
  feed: (stream: ClientHttp2Stream) => (() => void) | void,
): Promise<Outcome> {
  return new Promise((resolve) => {
    const openedAt = performance.now();
    const stream = session.request(headers, { endStream: false });
    let status: number | undefined;
    stream.on('response', (response) => { status = Number(response[':status']); });
    stream.on('data', () => { /* drained so the stream can end */ });
    stream.on('error', () => { /* a reset is an outcome, read from 'close' */ });
    const stopFeeding = feed(stream);
    const finish = (closedAfterMs: number | null): void => {
      clearTimeout(watch);
      stopFeeding?.();
      stream.destroy();
      resolve({ status, closedAfterMs });
    };
    const watch = setTimeout(() => { finish(null); }, WATCH_MS);
    stream.once('close', () => { finish(performance.now() - openedAt); });
  });
}

function expectCutInsideTheWindow(outcome: Outcome): void {
  expect(outcome.closedAfterMs, `a stream whose request never finished was still open ${WATCH_MS} ms after it opened`).not.toBeNull();
  expect(outcome.status, 'the stalled request was not answered 408').toBe(408);
  expect(outcome.closedAfterMs!, 'the stream was cut later than request-timeout allows').toBeLessThanOrEqual(CUT_WITHIN_MS);
  expect(outcome.closedAfterMs!, 'the stream was cut long before request-timeout').toBeGreaterThanOrEqual(CUT_NOT_BEFORE_MS);
}

describe('request-timeout bounds the receive of an HTTP/2 stream', () => {
  test('a body that stalls is answered 408 and the stream reset at the deadline', async () => {
    const session = http2Client(await bindHttp2());
    const outcome = await watchStream(
      session,
      { ':method': 'POST', ':path': '/upload', 'content-length': '1000' },
      (stream) => { stream.write(Buffer.alloc(10, 0x61)); },
    );

    expect(session.alpnProtocol).toBe('h2');
    expectCutInsideTheWindow(outcome);
  }, LIVE_TEST_TIMEOUT_MS);

  test('a body trickled a byte at a time is cut at the same deadline, though the connection is never quiet', async () => {
    const session = http2Client(await bindHttp2());
    const outcome = await watchStream(
      session,
      { ':method': 'POST', ':path': '/upload', 'content-length': '1000' },
      (stream) => {
        const trickle = setInterval(() => { if (!stream.destroyed) stream.write('a'); }, 150);
        return () => { clearInterval(trickle); };
      },
    );

    expectCutInsideTheWindow(outcome);
  }, LIVE_TEST_TIMEOUT_MS);
});

describe('…and never the response: a request received in full is not cut, however long its handler takes', () => {
  test('a body sent whole', async () => {
    const session = http2Client(await bindHttp2());
    const outcome = await watchStream(
      session,
      { ':method': 'POST', ':path': '/slow', 'content-length': '5' },
      (stream) => { stream.end('hello'); },
    );

    expect(outcome.status, 'a request received in full was cut while its handler worked').toBe(200);
  }, LIVE_TEST_TIMEOUT_MS);

  test('a request with no body at all', async () => {
    const session = http2Client(await bindHttp2());
    const outcome = await watchStream(session, { ':method': 'GET', ':path': '/slow' }, (stream) => { stream.end(); });

    expect(outcome.status, 'a body-less request was cut while its handler worked').toBe(200);
  }, LIVE_TEST_TIMEOUT_MS);

  test('a body that arrived whole but that nothing reads', async () => {
    // The route takes no body, so nothing consumes the five bytes and the
    // stream's readable side never emits 'end'.  The deadline asks whether
    // the client has finished sending, not whether a reader has finished
    // reading — the request is in, and the handler gets all the time it takes.
    const session = http2Client(await bindHttp2());
    const outcome = await watchStream(
      session,
      { ':method': 'GET', ':path': '/slow', 'content-length': '5' },
      (stream) => { stream.end('hello'); },
    );

    expect(outcome.status, 'a request whose body was in but unread was cut while its handler worked').toBe(200);
  }, LIVE_TEST_TIMEOUT_MS);
});
