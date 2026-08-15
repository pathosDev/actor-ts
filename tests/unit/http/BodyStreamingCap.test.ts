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

/** Small enough that the whole exchange fits in a few hundred milliseconds. */
const CAP_BYTES = 16 * 1024;
/** One chunk of the streamed body — three of them already cross the cap. */
const CHUNK_BYTES = 8 * 1024;
/** Ceiling on how much a streaming client writes before it gives up waiting. */
const MAX_CHUNKS = 64;

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Status code off an HTTP/1.1 response line, or `null` if none arrived. */
function statusOf(response: string): number | null {
  const line = /^HTTP\/1\.[01] (\d{3})/.exec(response);
  return line ? Number(line[1]) : null;
}

type RawSocketExchange = {
  readonly socket: net.Socket;
  /** Everything the server has written back so far. */
  read(): string;
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
 */
async function connectRaw(port: number): Promise<RawSocketExchange> {
  const socket = net.connect({ host: '127.0.0.1', port });
  let received = '';
  socket.on('data', (data: Buffer) => { received += data.toString('latin1'); });
  socket.on('error', () => { /* the peer hung up — that is a valid outcome */ });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return {
    socket,
    read: () => received,
    write: (data) => { if (!socket.destroyed && socket.writable) socket.write(data); },
    close: () => socket.destroy(),
  };
}

/** Poll until the server has written a full response head, or the deadline passes. */
async function awaitResponse(exchange: RawSocketExchange, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exchange.read().includes('\r\n\r\n')) return exchange.read();
    await sleep(10);
  }
  return exchange.read().includes('\r\n\r\n') ? exchange.read() : null;
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

      const response = await awaitResponse(exchange, 3000);

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
    const exchange = await connectRaw(port);
    try {
      exchange.write(
        'POST /up HTTP/1.1\r\n'
        + `Host: 127.0.0.1:${port}\r\n`
        + 'Content-Type: application/octet-stream\r\n'
        + 'Transfer-Encoding: chunked\r\n'
        + 'Connection: close\r\n\r\n',
      );

      // Feed chunks until the server answers.  The terminating `0\r\n\r\n` is
      // never written: only a backend counting bytes as they land can decide
      // anything here, and it must decide long before MAX_CHUNKS.
      const frame = `${CHUNK_BYTES.toString(16)}\r\n${'x'.repeat(CHUNK_BYTES)}\r\n`;
      let chunksWritten = 0;
      while (chunksWritten < MAX_CHUNKS && exchange.read() === '') {
        exchange.write(frame);
        chunksWritten += 1;
        await sleep(5);
      }

      const response = await awaitResponse(exchange, 3000);

      expect(response).not.toBeNull();
      expect(statusOf(response!)).toBe(413);
      // Refused while it arrived: the client never got anywhere near writing
      // MAX_CHUNKS, and the handler never saw the body.
      expect(chunksWritten).toBeLessThan(MAX_CHUNKS);
      expect(seen.called).toBe(false);
    } finally {
      exchange.close();
    }
  });
});
