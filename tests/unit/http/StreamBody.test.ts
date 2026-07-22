import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { HonoBackend } from '../../../src/http/backend/HonoBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { get, type Route } from '../../../src/http/Route.js';
import type { HttpServerBackend, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { Status } from '../../../src/http/types.js';
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

describe.each(backends)('ReadableStream response body — %s backend', (_name, mk) => {
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
});
