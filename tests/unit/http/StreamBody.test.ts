import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { HonoBackend } from '../../../src/http/backend/HonoBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { get, type Route } from '../../../src/http/Route.js';
import type { HttpServerBackend, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { Status } from '../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

const backends: Array<[string, () => HttpServerBackend]> = [
  ['fastify', () => new FastifyBackend({ logger: false })],
  ['express', () => new ExpressBackend()],
  ['hono', () => new HonoBackend()],
];

const live: Array<{ binding: ServerBinding; system: ActorSystem }> = [];
afterEach(async () => {
  while (live.length) {
    const { binding, system } = live.shift()!;
    await binding.unbind();
    await system.terminate();
  }
});

async function start(mk: () => HttpServerBackend, routes: Route): Promise<string> {
  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('http-stream-test', sysOptions);
  const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).useBackend(mk()).bind(routes);
  live.push({ binding, system });
  return `http://${binding.host}:${binding.port}`;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/**
 * The same chunks, but handed out one `pull` at a time and only after the event
 * loop has turned — the shape of a body backed by real I/O (a file read, a
 * database cursor, an upstream response) rather than one already in memory.
 *
 * `setImmediate` rather than a timer on purpose: what matters is that the first
 * chunk is not available in the tick that sent the response, and "one macrotask
 * turn" says exactly that with no duration to be wrong about.
 */
function slowStreamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]!);
      index += 1;
    },
  });
}

/**
 * Backends that put a handler-set `content-length` on the wire for a streamed
 * body.  Measured: Fastify and Express keep it; Hono returns a `Response` to
 * whatever server the runtime supplies, and `Bun.serve` drops the header and
 * re-frames the body as chunked (`node:http` and `Deno.serve` keep it, so the
 * same route IS length-stated there — only `bun test` runs here).
 */
const backendsStatingStreamLength = new Set(['fastify', 'express']);

describe.each(backends)('ReadableStream response body — %s backend', (backendName, mk) => {
  test('streams multiple chunks with an explicit content-type', async () => {
    const enc = new TextEncoder();
    const url = await start(mk, get(() => ({
      status: Status.OK,
      body: streamOf([enc.encode('hello '), enc.encode('streamed '), enc.encode('world')]),
      contentType: 'text/plain; charset=utf-8',
    })));
    const response = await fetch(`${url}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('hello streamed world');
  });

  test('defaults to application/octet-stream and round-trips a large body byte-for-byte', async () => {
    const big = new Uint8Array(256 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 256;
    // hand out the bytes in 16 KiB chunks (slice copies — independent buffers,
    // so the stream can transfer each without detaching the others)
    const chunks: Uint8Array[] = [];
    for (let off = 0; off < big.length; off += 16 * 1024) chunks.push(big.slice(off, off + 16 * 1024));

    const url = await start(mk, get(() => ({ status: Status.OK, body: streamOf(chunks) })));
    const response = await fetch(`${url}/`);
    expect(response.headers.get('content-type')).toContain('application/octet-stream');
    const received = new Uint8Array(await response.arrayBuffer());
    expect(received.length).toBe(big.length);
    expect(received[0]).toBe(0);
    expect(received[257]).toBe(1);
    expect(received[big.length - 1]).toBe((big.length - 1) % 256);
  });

  test('a body whose first chunk is not ready in the same tick is not truncated', async () => {
    /*
     * Both cases above enqueue everything in `start`, so the whole body is
     * already in memory when the backend is handed the stream — and that is the
     * one shape this suite covered.  Anything sourced from real I/O settles a
     * turn later, and on Fastify that used to end the response before the first
     * chunk existed: `wrap-thenable` saw an async handler resolve to `undefined`
     * with `reply.sent` still false and sent an empty body over the top of it.
     * The client got `200`, `content-length: 0` and zero bytes, with nothing
     * logged (#465).  The default backend is Fastify, so this is the case that
     * has to hold.
     */
    const enc = new TextEncoder();
    const url = await start(mk, get(() => ({
      status: Status.OK,
      body: slowStreamOf([enc.encode('slow '), enc.encode('but '), enc.encode('complete')]),
      contentType: 'text/plain; charset=utf-8',
    })));
    const response = await fetch(`${url}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('slow but complete');
  });

  test('a handler-set content-length survives a stream body', async () => {
    // What the streaming static route depends on: a backend has nothing to
    // measure on a stream, so the length only reaches the client if the header
    // the handler set is left alone.
    const body = new Uint8Array(96 * 1024).fill(3);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < body.length; offset += 32 * 1024) chunks.push(body.slice(offset, offset + 32 * 1024));

    const url = await start(mk, get(() => ({
      status: Status.OK,
      headers: { 'content-length': String(body.length) },
      body: slowStreamOf(chunks),
    })));
    const response = await fetch(`${url}/`);
    expect(response.status).toBe(200);
    if (backendsStatingStreamLength.has(backendName)) {
      expect(response.headers.get('content-length')).toBe(String(body.length));
    } else {
      // A *wrong* length would be the real defect; an honest chunked framing is
      // the runtime's choice, and the byte count below is what must hold either way.
      expect(response.headers.get('content-length')).toBeNull();
    }
    expect((await response.arrayBuffer()).byteLength).toBe(body.length);
  });
});
