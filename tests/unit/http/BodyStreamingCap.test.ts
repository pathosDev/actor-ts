/**
 * #357 — *when* an oversized request body is refused, not only that it is.
 *
 * Every other body-cap test posts a materialised `new Uint8Array(n)` through
 * `fetch`, which always sets `Content-Length`, so all of them take the
 * pre-read fast path and neither of the two mechanisms below is observable:
 * delete the Express pre-read guard and its per-chunk backstop answers with a
 * byte-identical 413; leave Hono buffering the whole body via `arrayBuffer()`
 * and the post-read check answers with the same 413 too.
 *
 * These cases discriminate by *withholding* part of the request, which only a
 * raw socket can do:
 *
 *   - declare a huge `Content-Length` and send **no body at all** — only a
 *     backend that refuses on the declared length can answer;
 *   - send a chunked body with **no terminating chunk** — only a backend that
 *     counts bytes as they arrive can answer.
 *
 * A backend that measures the body afterwards waits forever in both, which is
 * the whole difference these tests exist to pin.
 *
 * What they do *not* pin is the client's luck.  Refusing a body mid-flight
 * means closing a connection the client is still writing to, and a close over
 * unread inbound data goes out as a reset — which discards the receive queue,
 * answer included.  So the chunked case asserts that the backend *settled* the
 * exchange (answered, or hung up) and that the handler never ran, and only
 * checks for 413 when the answer actually survived.  Reading the status back
 * unconditionally is what made this suite flake; see the reset case at the
 * bottom of the file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { ExpressBackendOptions } from '../../../src/http/backend/ExpressBackendOptions.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { HonoBackend } from '../../../src/http/backend/HonoBackend.js';
import { HonoBackendOptions } from '../../../src/http/backend/HonoBackendOptions.js';
import type { HttpServerBackend, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { completeJson, path, post, type Route } from '../../../src/http/Route.js';
import { Status } from '../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { sleep } from '../../util/AwaitCondition.js';

/** Small enough that the whole exchange fits in a few hundred milliseconds. */
const CAP_BYTES = 16 * 1024;
/** One chunk of the streamed body — three of them already cross the cap. */
const CHUNK_BYTES = 8 * 1024;
/**
 * Everything the streaming client ever writes, and deliberately not one frame
 * more.  Enough to put the backend past the cap, so it has to decide; short
 * enough that the client is done writing before it does, so the server's close
 * finds an empty receive queue and goes out as a FIN rather than a reset.
 */
const CHUNKS_TO_EXCEED_CAP = Math.ceil(CAP_BYTES / CHUNK_BYTES) + 1;
/** How long to wait for the backend to end an exchange it will never see the end of. */
const SETTLE_TIMEOUT_MS = 3000;

const backends: Array<[string, () => HttpServerBackend]> = [
  ['fastify', () => new FastifyBackend({ logger: false, bodyLimit: CAP_BYTES })],
  ['express', () => new ExpressBackend(ExpressBackendOptions.create().withMaxBodyBytes(CAP_BYTES))],
  ['hono', () => new HonoBackend(HonoBackendOptions.create().withMaxBodyBytes(CAP_BYTES))],
];

const live: Array<{ binding: ServerBinding; system: ActorSystem }> = [];

afterEach(async () => {
  while (live.length) {
    const { binding, system } = live.shift()!;
    try { await binding.unbind(); } catch { /* already down */ }
    await system.terminate();
  }
});

/** Route that records whether the oversized body ever became its problem. */
function echoLength(seen: { called: boolean }): Route {
  return path('up', post((request) => {
    seen.called = true;
    return completeJson(Status.OK, { length: request.body?.byteLength ?? 0 });
  }));
}

async function start(backend: HttpServerBackend, routes: Route): Promise<number> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('http-body-streaming-cap', systemOptions);
  try {
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(backend)
      .bind(routes);
    live.push({ binding, system });
    return binding.port;
  } catch (e) {
    await system.terminate();
    throw e;
  }
}

/** Status code off an HTTP/1.1 response line, or `null` if none arrived. */
function statusOf(response: string): number | null {
  const line = /^HTTP\/1\.[01] (\d{3})/.exec(response);
  return line ? Number(line[1]) : null;
}

type RawSocketExchange = {
  readonly socket: net.Socket;
  /** Everything the server has written back so far. */
  read(): string;
  /** True once a complete response head is readable. */
  answered(): boolean;
  /** True once the connection is gone — reset or graceful FIN alike. */
  hungUp(): boolean;
  /** Best-effort write; a server that already hung up is not an error here. */
  write(data: string): void;
  close(): void;
};

/**
 * Open a raw connection and start collecting whatever comes back.
 *
 * The `error` listener is not optional: once the server refuses the body it
 * destroys the socket, and the next write lands on a closed peer — an
 * unhandled `ECONNRESET`/`EPIPE` would take the test process down rather than
 * report the refusal these tests are looking for.
 *
 * `close` and `error` both feed `hungUp`, because the two runtimes disagree
 * about which one a reset is: Node raises `ECONNRESET` and closes with
 * `hadError`, Bun reports a plain close.  What they agree on is that the
 * connection ended, which is the signal these tests actually need.
 */
async function connectRaw(port: number): Promise<RawSocketExchange> {
  const socket = net.connect({ host: '127.0.0.1', port });
  let received = '';
  let gone = false;
  socket.on('data', (data: Buffer) => { received += data.toString('latin1'); });
  socket.on('error', () => { gone = true; /* the peer hung up — a valid outcome */ });
  socket.on('close', () => { gone = true; });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return {
    socket,
    read: () => received,
    answered: () => received.includes('\r\n\r\n'),
    hungUp: () => gone,
    write: (data) => { if (!socket.destroyed && socket.writable) socket.write(data); },
    close: () => socket.destroy(),
  };
}

/** Poll until the server has written a full response head, or the deadline passes. */
async function awaitResponse(exchange: RawSocketExchange, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exchange.read().includes('\r\n\r\n')) return exchange.read();
    // Deliberately not `awaitCondition`: reaching the deadline is a *valid
    // outcome* here (the caller reports it as `never`), and `awaitCondition`
    // throws instead of returning, which would lose that third case.
    await sleep(10);
  }
  return exchange.read().includes('\r\n\r\n') ? exchange.read() : null;
}

/**
 * How the server ended a chunked exchange it was never given a last chunk for.
 *
 * `response` and `hangup` are both refusals — the server decided without the
 * body being complete, which is the whole point of these tests.  Only `never`
 * says the backend is still waiting for a body that will not come.
 */
type ChunkedExchangeOutcome = {
  readonly settled: 'response' | 'hangup' | 'never';
  readonly status: number | null;
  readonly chunksWritten: number;
  readonly bytesWritten: number;
};

/**
 * Post a chunked body that never terminates and report how the server ended it.
 *
 * Owns its socket so every caller releases it on every path.
 */
async function streamChunkedBody(port: number): Promise<ChunkedExchangeOutcome> {
  const exchange = await connectRaw(port);
  let chunksWritten = 0;
  let bytesWritten = 0;
  try {
    exchange.write(
      'POST /up HTTP/1.1\r\n'
      + `Host: 127.0.0.1:${port}\r\n`
      + 'Content-Type: application/octet-stream\r\n'
      + 'Transfer-Encoding: chunked\r\n'
      + 'Connection: close\r\n\r\n',
    );

    // Put the backend past the cap and then stop.  The terminating `0\r\n\r\n`
    // is never written, so only a backend counting bytes as they land can
    // decide anything here at all — while a client that kept writing past the
    // decision would turn the server's close into a reset and lose the answer.
    const frame = `${CHUNK_BYTES.toString(16)}\r\n${'x'.repeat(CHUNK_BYTES)}\r\n`;
    while (chunksWritten < CHUNKS_TO_EXCEED_CAP && !exchange.answered() && !exchange.hungUp()) {
      exchange.write(frame);
      chunksWritten += 1;
      bytesWritten += frame.length;
      // A fixture: the writes have to be paced so the server gets turns to count
      // the bytes as they land and can decide mid-stream.  Writing the whole
      // body in one go would test a different thing.
      await sleep(5);
    }

    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    // Same as `awaitResponse`: the deadline expiring is the `never` outcome the
    // caller asserts on, so this cannot become an `awaitCondition` that throws.
    while (Date.now() < deadline && !exchange.answered() && !exchange.hungUp()) await sleep(10);

    // A readable answer beats a bare hangup, but both are the server deciding.
    const settled = exchange.answered() ? 'response' : exchange.hungUp() ? 'hangup' : 'never';
    return {
      settled,
      status: exchange.answered() ? statusOf(exchange.read()) : null,
      chunksWritten,
      bytesWritten,
    };
  } finally {
    exchange.close();
  }
}

describe.each([...backends])('body cap is applied before the body is complete — %s backend', (_name, makeBackend) => {
  test('an over-long declared Content-Length is refused without a body byte being sent', async () => {
    const seen = { called: false };
    const port = await start(makeBackend(), echoLength(seen));
    const exchange = await connectRaw(port);
    try {
      // The head announces four times the cap and then stops.  A backend that
      // waits for the bytes it was promised can never answer this.
      exchange.write(
        'POST /up HTTP/1.1\r\n'
        + `Host: 127.0.0.1:${port}\r\n`
        + 'Content-Type: application/octet-stream\r\n'
        + `Content-Length: ${CAP_BYTES * 4}\r\n`
        + 'Connection: close\r\n\r\n',
      );

      // Nothing is written after the head, so the backend's close finds an
      // empty receive queue and the answer survives — no reset to race here.
      const response = await awaitResponse(exchange, SETTLE_TIMEOUT_MS);

      expect(response).not.toBeNull();
      expect(statusOf(response!)).toBe(413);
      expect(seen.called).toBe(false);
    } finally {
      exchange.close();
    }
  });

  test('a chunked body over the cap is refused before its terminating chunk', async () => {
    const seen = { called: false };
    const port = await start(makeBackend(), echoLength(seen));

    const outcome = await streamChunkedBody(port);

    // Refused while it arrived.  What is determinable is that the backend
    // ended the exchange without ever seeing a terminating chunk, and that the
    // body never became the handler's problem; *reading* the 413 back is not,
    // because the refusal closes a connection the client is still writing to
    // and the platform may drop the answer with it.
    expect(outcome.settled).not.toBe('never');
    expect(seen.called).toBe(false);
    // When the answer did survive the teardown, it says what it should.
    if (outcome.settled === 'response') expect(outcome.status).toBe(413);
  });
});

/**
 * The client above, against a server whose answer the platform throws away.
 *
 * A backend that refuses a body mid-flight stops reading and closes while the
 * client is still writing, and a close with unread data in the receive queue
 * is a reset, not a graceful FIN — on which the platform discards whatever it
 * had buffered for the client, including a 413 that really was sent.  So
 * "no response arrived" does not mean "the server never answered", and a test
 * that reads the refusal off the socket is reading a coin flip.
 *
 * The stub reproduces exactly that, deterministically and on every runtime:
 * it never reads the body (`pause`), then destroys the connection, which is
 * the same unread-data-then-close the real backends perform.  Measured on this
 * machine the real Hono backend loses the answer 15 times out of 15 on a cold
 * Node process, and the suite below flaked 2 times in 80 contended Bun runs.
 */
describe('the raw-socket client the cases above share', () => {
  const stubs: net.Server[] = [];

  afterEach(async () => {
    while (stubs.length) {
      const stub = stubs.shift()!;
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });

  async function startHangUpServer(): Promise<number> {
    const stub = net.createServer((socket) => {
      // Never consume the body, then close: unread inbound data is what makes
      // the stack emit a reset and drop what it had queued for the client.
      socket.pause();
      setTimeout(() => socket.destroy(), 60);
    });
    stubs.push(stub);
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
    return (stub.address() as net.AddressInfo).port;
  }

  test('reads a server that hangs up mid-body as a refusal, not as silence', async () => {
    const port = await startHangUpServer();

    const outcome = await streamChunkedBody(port);

    // The server decided without ever seeing a terminating chunk.  That the
    // decision was unreadable is the platform's doing, not the backend's.
    expect(outcome.settled).toBe('hangup');
    expect(outcome.chunksWritten).toBeLessThanOrEqual(CHUNKS_TO_EXCEED_CAP);
  });
});
