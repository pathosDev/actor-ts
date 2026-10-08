/**
 * #1488 — `actor-ts.http.server.max-header-bytes`, the cap on a request's
 * header block, on every backend that builds a `node:http` server.
 *
 * Before it, a block setting `max-header-bytes = 1024` bound without error and
 * a request carrying a 4 KiB header reached the handler on every backend.
 * The cap is a *construction* option — `node:http`'s `maxHeaderSize` — so it
 * reaches a server only where actor-ts builds one: Fastify through its factory
 * options, Express through the server the backend now builds itself, and Hono
 * on Node through `@hono/node-server`'s `serverOptions`.  Hono on Bun and Deno
 * has no such option, which `ServerOptionsReport.test.ts` covers.
 *
 * Every case asserts that the handler was **not reached**, never a status.
 * `node:http` answers `431`, but a client still writing when the server gives
 * up can see a reset instead — measured with a `fetch` client against Fastify
 * on Bun — and a test that read the status would flake on the platform's luck
 * rather than on the cap.  A request with a small header is sent first in each
 * case, so a server that refused everything cannot pass.
 *
 * Fastify's TLS case is the one that discriminates the factory bag: once
 * `https` is set, Fastify hands only that bag to the server factory, so a cap
 * placed in `http` is inert there.  Measured on node v26.10.0 and bun 1.4.2: a
 * 4 KiB header reached the handler with `{ http: { maxHeaderSize: 1024 },
 * https }` and was refused with the cap in the `https` bag.
 *
 * Hono on Node is driven through `NodeHonoRunner` directly under `bun test`,
 * as `HttpServerTls.test.ts` does: the backend picks its runner by runtime, and
 * under `bun test` that is Bun's.  The real-Node run of the whole chain is the
 * smoke case `tests/smoke/cases/44-http-server-size-caps.mjs`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { connect as http2Connect } from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { FastifyBackend, fastifyFactoryOptions } from '../../../src/http/backend/FastifyBackend.js';
import type { HttpServerBackend, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { HttpServerOptions, type HttpServerOptionsType } from '../../../src/http/HttpServerOptions.js';
import { completeText, get, path, type Route } from '../../../src/http/Route.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import type { HonoServerHandle } from '../../../src/runtime/http/HonoServerRunner.js';
import { NodeHonoRunner } from '../../../src/runtime/http/NodeHonoRunner.js';

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
const CERT = readFileSync(new URL('localhost-cert.pem', FIXTURES), 'utf8');
const KEY = readFileSync(new URL('localhost-key.pem', FIXTURES), 'utf8');
const CA = readFileSync(new URL('test-ca.pem', FIXTURES), 'utf8');

/** The cap every case sets, well under `node:http`'s own 16 KiB. */
const CAP_BYTES = 1024;
/** A header block four times the cap and still under every runtime's default. */
const OVERSIZED = 'a'.repeat(4 * CAP_BYTES);
const SMALL = 'a'.repeat(16);
const MAX_HEADER_BYTES = 'actor-ts.http.server.max-header-bytes';
/** How long a raw request may take to be answered or hung up on. */
const SETTLE_TIMEOUT_MS = 3_000;

/** A route that counts the requests that reached it — the one observable these cases assert on. */
function countingRoute(reached: { count: number }): Route {
  return path('', get(() => {
    reached.count += 1;
    return completeText(200, 'reached');
  }));
}

/**
 * One HTTP/1.1 request on a raw socket — plain, or TLS verified against the
 * test CA — carrying `headerValue` in an `x-padding` header.  Resolves once
 * the server answered or hung up, or the deadline passed; the socket is
 * destroyed on every path.
 */
function rawRequest(port: number, secure: boolean, headerValue: string): Promise<'answered' | 'hung up' | 'timed out'> {
  return new Promise((resolve) => {
    let received = '';
    let settled = false;
    const request = 'GET / HTTP/1.1\r\nHost: localhost\r\n'
      + `X-Padding: ${headerValue}\r\nConnection: close\r\n\r\n`;
    const socket: net.Socket = secure
      ? tls.connect({ host: '127.0.0.1', port, ca: CA, servername: 'localhost' }, () => { socket.write(request); })
      : net.connect({ host: '127.0.0.1', port }, () => { socket.write(request); });
    const finish = (outcome: 'answered' | 'hung up' | 'timed out'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(outcome);
    };
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');
      if (received.includes('\r\n\r\n')) finish('answered');
    });
    // A reset on an oversized request is one of the two valid outcomes.
    socket.on('error', () => { finish('hung up'); });
    socket.on('close', () => { finish('hung up'); });
    const deadline = setTimeout(() => { finish('timed out'); }, SETTLE_TIMEOUT_MS);
  });
}

/** One HTTP/2 request carrying `headerValue`; resolves with whether it was answered. */
function http2Request(port: number, headerValue: string): Promise<'answered' | 'refused'> {
  return new Promise((resolve) => {
    let settled = false;
    const session = http2Connect(`https://127.0.0.1:${port}`, { ca: CA, servername: 'localhost' });
    const finish = (outcome: 'answered' | 'refused'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      session.destroy();
      resolve(outcome);
    };
    session.on('error', () => { finish('refused'); });
    const stream = session.request({ ':path': '/', 'x-padding': headerValue });
    stream.on('response', () => { finish('answered'); });
    stream.on('error', () => { finish('refused'); });
    stream.end();
    const deadline = setTimeout(() => { finish('refused'); }, SETTLE_TIMEOUT_MS);
  });
}

const running: Array<{ system: ActorSystem; binding?: ServerBinding }> = [];
afterEach(async () => {
  while (running.length) {
    const { system, binding } = running.pop()!;
    if (binding) await binding.unbind().catch(() => {});
    await system.terminate();
  }
});

type Setup = {
  readonly hocon?: string;
  readonly serverOptions?: HttpServerOptions;
  readonly backend?: HttpServerBackend;
};

/** Bind `routes` under `setup`; resolves with the binding, rejects with whatever `bind()` threw. */
async function bindWith(setup: Setup, routes: Route): Promise<ServerBinding> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(setup.hocon ?? ''));
  const system = ActorSystem.create('http-header-size-parity', systemOptions);
  const entry: { system: ActorSystem; binding?: ServerBinding } = { system };
  running.push(entry);
  let builder = system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0);
  if (setup.backend !== undefined) builder = builder.useBackend(setup.backend);
  if (setup.serverOptions !== undefined) builder = builder.withServerOptions(setup.serverOptions);
  entry.binding = await builder.bind(routes);
  return entry.binding;
}

/** HOCON naming the framework-built backend, with the header cap set. */
const capped = (backend: string): string => `actor-ts.http.backend = ${backend}\n${MAX_HEADER_BYTES} = ${CAP_BYTES}`;

/** A small header reaches the handler, then an oversized one does not. */
async function expectOnlyTheOversizedRequestRefused(port: number, secure: boolean, reached: { count: number }): Promise<void> {
  expect(await rawRequest(port, secure, SMALL)).toBe('answered');
  expect(reached.count, 'a request well under the cap did not reach the handler').toBe(1);

  const outcome = await rawRequest(port, secure, OVERSIZED);

  expect(outcome, 'the server neither answered nor hung up on an oversized header block').not.toBe('timed out');
  expect(reached.count, 'a 4 KiB header block reached the handler through a 1 KiB max-header-bytes').toBe(1);
}

describe.each(['fastify', 'express'])('max-header-bytes — the framework-built %s backend', (backend) => {
  test('a 4 KiB header block under max-header-bytes = 1024 from HOCON never reaches the handler', async () => {
    const reached = { count: 0 };
    const binding = await bindWith({ hocon: capped(backend) }, countingRoute(reached));

    await expectOnlyTheOversizedRequestRefused(binding.port, false, reached);
  });

  test('the same cap from withServerOptions', async () => {
    const reached = { count: 0 };
    const serverOptions = HttpServerOptions.create().withMaxHeaderBytes(CAP_BYTES);
    const binding = await bindWith({ hocon: `actor-ts.http.backend = ${backend}`, serverOptions }, countingRoute(reached));

    await expectOnlyTheOversizedRequestRefused(binding.port, false, reached);
  });

  test('an unset key keeps the runtime\'s own 16 KiB: the same 4 KiB header block is served', async () => {
    const reached = { count: 0 };
    const binding = await bindWith({ hocon: `actor-ts.http.backend = ${backend}` }, countingRoute(reached));

    expect(await rawRequest(binding.port, false, OVERSIZED)).toBe('answered');
    expect(reached.count).toBe(1);
  });
});

describe('max-header-bytes — Fastify over TLS', () => {
  test('a 4 KiB header block never reaches the handler on a TLS listener', async () => {
    // The case that tells the two factory bags apart: with `https` set, a cap
    // in `http` is never handed to the server factory.
    const reached = { count: 0 };
    const serverOptions = HttpServerOptions.create().withTls({ cert: CERT, key: KEY });
    const binding = await bindWith({ hocon: capped('fastify'), serverOptions }, countingRoute(reached));

    await expectOnlyTheOversizedRequestRefused(binding.port, true, reached);
  });

  test('on an HTTP/2 listener the HTTP/1.1 requests sharing the port are capped', async () => {
    const reached = { count: 0 };
    const serverOptions = HttpServerOptions.create()
      .withTls({ cert: CERT, key: KEY })
      .withHttp2();
    const binding = await bindWith({ hocon: capped('fastify'), serverOptions }, countingRoute(reached));

    await expectOnlyTheOversizedRequestRefused(binding.port, true, reached);
  });

  test('an HTTP/2 stream with a 4 KiB header list is refused on Bun — the runtime\'s doing, documented beside the Node gap', async () => {
    // Pins the documented runtime behaviour, not a guarantee of actor-ts:
    // node v26.10.0 lets the same stream through to the handler — neither
    // `maxHeaderSize` nor `settings.maxHeaderListSize` bounds an h2 header
    // list there — and the configuration reference says so.  The day Bun
    // stops refusing it, the docs' "Bun refuses the stream" goes stale and
    // this case says so first.
    const reached = { count: 0 };
    const serverOptions = HttpServerOptions.create()
      .withTls({ cert: CERT, key: KEY })
      .withHttp2();
    const binding = await bindWith({ hocon: capped('fastify'), serverOptions }, countingRoute(reached));

    expect(await http2Request(binding.port, SMALL)).toBe('answered');
    expect(await http2Request(binding.port, OVERSIZED)).toBe('refused');
    expect(reached.count).toBe(1);
  });
});

describe('max-header-bytes — a Fastify built by hand', () => {
  test('without the cap it is refused at bind(), naming the key and the remedy', async () => {
    const attempt = bindWith({ hocon: `${MAX_HEADER_BYTES} = ${CAP_BYTES}`, backend: new FastifyBackend() }, countingRoute({ count: 0 }));

    await expect(attempt).rejects.toThrow(MAX_HEADER_BYTES);
    await expect(attempt).rejects.toThrow('fastifyFactoryOptions(serverOptions)');
  });

  test('a TLS Fastify with the cap in the http bag is refused — its server holds no cap at all', async () => {
    // The shape that reads as capped and is not: Fastify hands the server
    // factory only the `https` bag once it is set.
    const literal = new FastifyBackend({ http: { maxHeaderSize: CAP_BYTES }, https: { cert: CERT, key: KEY } });
    const serverOptions = HttpServerOptions.create()
      .withTls({ cert: CERT, key: KEY })
      .withMaxHeaderBytes(CAP_BYTES);
    const attempt = bindWith({ serverOptions, backend: literal }, countingRoute({ count: 0 }));

    await expect(attempt).rejects.toThrow(MAX_HEADER_BYTES);
  });

  test('built from fastifyFactoryOptions(serverOptions) it binds and caps, plain and over TLS', async () => {
    for (const secure of [false, true]) {
      const builder = HttpServerOptions.create().withMaxHeaderBytes(CAP_BYTES);
      const serverOptions = secure ? builder.withTls({ cert: CERT, key: KEY }) : builder;
      const reached = { count: 0 };
      const backend = new FastifyBackend(fastifyFactoryOptions(serverOptions as Partial<HttpServerOptionsType>));
      const binding = await bindWith({ serverOptions, backend }, countingRoute(reached));

      await expectOnlyTheOversizedRequestRefused(binding.port, secure, reached);
    }
  });

  test('built with the same cap by hand it binds: two numbers that agree are one cap', async () => {
    const reached = { count: 0 };
    const backend = new FastifyBackend({ http: { maxHeaderSize: CAP_BYTES } });
    const binding = await bindWith({ hocon: `${MAX_HEADER_BYTES} = ${CAP_BYTES}`, backend }, countingRoute(reached));

    await expectOnlyTheOversizedRequestRefused(binding.port, false, reached);
  });
});

describe('max-header-bytes — an Express backend built by hand', () => {
  test('adopts the key: the backend builds the server, so there is nothing to disagree with', async () => {
    const reached = { count: 0 };
    const binding = await bindWith({ hocon: `${MAX_HEADER_BYTES} = ${CAP_BYTES}`, backend: new ExpressBackend() }, countingRoute(reached));

    await expectOnlyTheOversizedRequestRefused(binding.port, false, reached);
  });
});

/**
 * `@hono/node-server` replaces `globalThis.Request` and `Response` the first
 * time `serve()` runs, and the override outlives the case — a later
 * `Bun.serve` then refuses the Hono backend's return value.  Captured before
 * any runner runs and put back after each, as `HttpServerTls.test.ts` does.
 */
const nativeGlobals = { Request: globalThis.Request, Response: globalThis.Response };
function restoreNativeGlobals(): void {
  Object.defineProperty(globalThis, 'Request', { value: nativeGlobals.Request, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'Response', { value: nativeGlobals.Response, configurable: true, writable: true });
}

describe('max-header-bytes — Hono on Node, through NodeHonoRunner', () => {
  const handles: HonoServerHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop(false).catch(() => {});
    restoreNativeGlobals();
  });

  test.each([
    ['plain', false],
    ['TLS', true],
  ] as const)('%s: a 4 KiB header block never reaches the handler, and the handle says the cap was built in', async (_label, secure) => {
    const reached = { count: 0 };
    const handle = await new NodeHonoRunner().serve({
      host: '127.0.0.1',
      port: 0,
      fetch: () => {
        reached.count += 1;
        return new Response('reached');
      },
      maxHeaderBytes: CAP_BYTES,
      ...(secure ? { tls: { cert: CERT, key: KEY } } : {}),
    });
    handles.push(handle);

    expect(handle.appliedServeOptions?.maxHeaderBytes).toBe(true);
    await expectOnlyTheOversizedRequestRefused(handle.port, secure, reached);
  });

  test('unset, the handle claims nothing and the runtime\'s own cap stays', async () => {
    const reached = { count: 0 };
    const handle = await new NodeHonoRunner().serve({
      host: '127.0.0.1',
      port: 0,
      fetch: () => {
        reached.count += 1;
        return new Response('reached');
      },
    });
    handles.push(handle);

    expect(handle.appliedServeOptions?.maxHeaderBytes ?? false).toBe(false);
    expect(await rawRequest(handle.port, false, OVERSIZED)).toBe('answered');
    expect(reached.count).toBe(1);
  });
});
