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
import { LogLevel, NoopLogger, type Logger } from '../../../src/Logger.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

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

/**
 * One chunk, then a source that fails — a database cursor dying, an upstream
 * `fetch` aborting.  `pull` runs one macrotask late, like real I/O, so the
 * first chunk is on the wire before the failure (#979).
 */
function failingAfterFirstChunk(first: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!sent) {
        sent = true;
        controller.enqueue(first);
        return;
      }
      throw new Error('upstream row cursor died');
    },
  });
}

/** A source that fails before it has produced a byte. */
function failingAtOnce(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull() {
      await new Promise<void>((resolve) => setImmediate(resolve));
      throw new Error('upstream row cursor died');
    },
  });
}

/**
 * An endless source that records whether it was cancelled — the release of
 * whatever it reads from (a file handle, a cursor, an upstream body).
 */
function endlessStream(onCancel: () => void): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024).fill(7);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5)); // the source's own pace, like real I/O — nothing is asserted on it
      controller.enqueue(chunk.slice());
    },
    cancel() { onCancel(); },
  });
}

/**
 * What a client saw of a response: its status (0 when the connection was reset
 * before one arrived), and whether its body completed cleanly.  A response that
 * never settles is the hang #979 reported on Bun, so the deadline rethrows
 * rather than counting as an aborted response.
 */
async function outcomeOf(url: string): Promise<{ status: number; completed: boolean; body: string }> {
  const signal = AbortSignal.timeout(5_000);
  const rethrowTimeout = (e: unknown): void => {
    if (signal.aborted) throw new Error(`no outcome within 5 s for ${url}: the response hung`, { cause: e });
  };
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (e) {
    rethrowTimeout(e);
    return { status: 0, completed: false, body: '' };
  }
  try {
    const body = await response.text();
    return { status: response.status, completed: true, body };
  } catch (e) {
    rethrowTimeout(e);
    return { status: response.status, completed: false, body: '' };
  }
}

describe.each(backends)('ReadableStream response body that fails — %s backend', (_backendName, mk) => {
  test('a source that fails mid-body ends in a truncated response, and the server keeps serving', async () => {
    const enc = new TextEncoder();
    let served = 0;
    const url = await start(mk, get(() => {
      served += 1;
      return served === 1
        ? { status: Status.OK, body: failingAfterFirstChunk(enc.encode('first chunk;')), contentType: 'text/plain' }
        : { status: Status.OK, body: 'still serving', contentType: 'text/plain' };
    }));
    const failed = await outcomeOf(`${url}/`);
    // A clean 200 carrying only the first chunk would be a response that lies.
    expect(failed.completed).toBe(false);
    const next = await outcomeOf(`${url}/`);
    expect(next).toEqual({ status: 200, completed: true, body: 'still serving' });
  });

  test('a source that fails before its first byte is not answered as a success', async () => {
    const url = await start(mk, get(() => ({ status: Status.OK, body: failingAtOnce() })));
    const outcome = await outcomeOf(`${url}/`);
    expect(outcome.completed && outcome.status < 500).toBe(false);
  });

  test('a client that disconnects mid-body cancels the source', async () => {
    let cancelled = false;
    const url = await start(mk, get(() => ({ status: Status.OK, body: endlessStream(() => { cancelled = true; }) })));
    const controller = new AbortController();
    const response = await fetch(`${url}/`, { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    await awaitCondition(() => cancelled, { timeoutMs: 3_000, label: 'the source was cancelled' });
    expect(cancelled).toBe(true);
  });
});

describe('ReadableStream response body that fails — express error handler', () => {
  test('a failure before the first byte reaches the registered error handler', async () => {
    const seen: unknown[] = [];
    const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('http-stream-error-handler', sysOptions);
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(new ExpressBackend())
      .withErrorHandler((err) => {
        seen.push(err);
        return { status: 502, body: 'upstream failed', contentType: 'text/plain' };
      })
      .bind(get(() => ({ status: Status.OK, body: failingAtOnce() })));
    live.push({ binding, system });
    const outcome = await outcomeOf(`http://${binding.host}:${binding.port}/`);
    expect(outcome).toEqual({ status: 502, completed: true, body: 'upstream failed' });
    expect(seen.length).toBe(1);
    expect((seen[0] as Error).message).toBe('upstream row cursor died');
  });

  test('a failure after the response was committed is logged once, with the error', async () => {
    const errors: Array<{ message: string; args: unknown[] }> = [];
    const recording: Logger = {
      level: LogLevel.Debug,
      debug() {}, info() {}, warn() {},
      error(message: string, ...args: unknown[]) { errors.push({ message, args }); },
      withSource() { return recording; },
      withFields() { return recording; },
    };
    const sysOptions = ActorSystemOptions.create().withLogger(recording).withLogLevel(LogLevel.Debug);
    const system = ActorSystem.create('http-stream-committed-failure', sysOptions);
    const enc = new TextEncoder();
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(new ExpressBackend())
      .bind(get(() => ({ status: Status.OK, body: failingAfterFirstChunk(enc.encode('first chunk;')) })));
    live.push({ binding, system });
    const outcome = await outcomeOf(`http://${binding.host}:${binding.port}/`);
    expect(outcome.completed).toBe(false);
    await awaitCondition(() => errors.length > 0, { timeoutMs: 2_000, label: 'the stream failure was logged' });
    const streamFailures = errors.filter((e) => e.message.includes('response body stream failed'));
    expect(streamFailures.length).toBe(1);
    expect(streamFailures[0]!.message).toContain('GET /:');
    expect((streamFailures[0]!.args[0] as Error).message).toBe('upstream row cursor died');
  });
});
