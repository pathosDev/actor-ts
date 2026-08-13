import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { DEFAULT_HTTP_MAX_BODY_BYTES } from '../../../src/http/Constants.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { ExpressBackendOptions } from '../../../src/http/backend/ExpressBackendOptions.js';
import { HonoBackend } from '../../../src/http/backend/HonoBackend.js';
import { HonoBackendOptions } from '../../../src/http/backend/HonoBackendOptions.js';
import {
  contentLengthExceeds,
  PAYLOAD_TOO_LARGE_RESPONSE,
} from '../../../src/http/backend/HttpServerBackend.js';
import type { HttpServerBackend, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { completeJson, path, post, type Route } from '../../../src/http/Route.js';
import { Status } from '../../../src/http/types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

/**
 * #357 — the three shipped backends used to disagree on how big a request
 * body may be (Fastify 1 MiB, Express and Hono 10 MiB each) and on what a
 * client got back when it sent too much.  Every case below is asserted for
 * all three, so the cap and the refusal are properties of the framework
 * rather than of whichever backend happens to be mounted.
 *
 * Each entry: name, a backend on the shared default cap, and a backend
 * capped through that backend's own knob — the builders for Express and
 * Hono, Fastify's native `bodyLimit` (it has no options family yet, #667).
 */
const backends: Array<[string, () => HttpServerBackend, (bytes: number) => HttpServerBackend]> = [
  [
    'fastify',
    () => new FastifyBackend({ logger: false }),
    (bytes) => new FastifyBackend({ logger: false, bodyLimit: bytes }),
  ],
  [
    'express',
    () => new ExpressBackend(),
    (bytes) => new ExpressBackend(ExpressBackendOptions.create().withMaxBodyBytes(bytes)),
  ],
  [
    'hono',
    () => new HonoBackend(),
    (bytes) => new HonoBackend(HonoBackendOptions.create().withMaxBodyBytes(bytes)),
  ],
];

const live: Array<{ binding: ServerBinding; system: ActorSystem }> = [];

afterEach(async () => {
  while (live.length) {
    const { binding, system } = live.shift()!;
    await binding.unbind();
    await system.terminate();
  }
});

async function start(backend: HttpServerBackend, routes: Route): Promise<string> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('http-body-size-parity', systemOptions);
  try {
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(backend)
      .bind(routes);
    live.push({ binding, system });
    return `http://${binding.host}:${binding.port}`;
  } catch (e) {
    await system.terminate();
    throw e;
  }
}

/** Route that reports how many bytes of body actually reached the handler. */
function echoLength(seen?: { called: boolean }): Route {
  return path('up', post((request) => {
    if (seen) seen.called = true;
    return completeJson(Status.OK, { length: request.body?.byteLength ?? 0 });
  }));
}

async function postBytes(url: string, byteLength: number): Promise<Response> {
  return fetch(`${url}/up`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(byteLength),
  });
}

describe('shared body-size cap (#357)', () => {
  test('the default is 1 MiB', () => {
    // Pinned deliberately: the number is the framework's answer for a server
    // nobody configured, and moving it is a behaviour change for every
    // application that never called withMaxBodyBytes.
    expect(DEFAULT_HTTP_MAX_BODY_BYTES).toBe(1024 * 1024);
  });

  describe('contentLengthExceeds — the pre-read fast path', () => {
    test('true when the declared length is over the cap', () => {
      expect(contentLengthExceeds('64', 16)).toBe(true);
      expect(contentLengthExceeds('17', 16)).toBe(true);
    });

    test('false at or under the cap', () => {
      expect(contentLengthExceeds('16', 16)).toBe(false);
      expect(contentLengthExceeds('0', 16)).toBe(false);
    });

    test('false for a missing or non-numeric header (the byte counter handles those)', () => {
      expect(contentLengthExceeds(undefined, 16)).toBe(false);
      expect(contentLengthExceeds('not-a-number', 16)).toBe(false);
    });
  });
});

describe.each([...backends])('body-size parity — %s backend', (_name, defaultCapped, cappedAt) => {
  test('refuses a body one byte over the shared default', async () => {
    const seen = { called: false };
    const url = await start(defaultCapped(), echoLength(seen));

    const response = await postBytes(url, DEFAULT_HTTP_MAX_BODY_BYTES + 1);

    expect(response.status).toBe(413);
    // The point of the cap: the oversized body never becomes the handler's
    // problem.  A 413 written after the handler ran would protect nothing.
    expect(seen.called).toBe(false);
  });

  test('accepts a body exactly at the shared default', async () => {
    const url = await start(defaultCapped(), echoLength());

    const response = await postBytes(url, DEFAULT_HTTP_MAX_BODY_BYTES);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ length: DEFAULT_HTTP_MAX_BODY_BYTES });
  });

  test('the refusal is identical across backends — status, body, content type and default headers', async () => {
    const url = await start(cappedAt(16), echoLength());

    const response = await postBytes(url, 64);

    expect(response.status).toBe(PAYLOAD_TOO_LARGE_RESPONSE.status);
    expect(await response.text()).toBe(PAYLOAD_TOO_LARGE_RESPONSE.body as string);
    expect(response.headers.get('content-type')).toBe(PAYLOAD_TOO_LARGE_RESPONSE.contentType as string);
    // The server-wide default headers ride along on the 413 like on any
    // other response — it is written through the backend's own writer.
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('an installed error handler does not see — or reshape — the refusal', async () => {
    // Regression (#357): on Fastify the body-too-large error reached the
    // app-level hook, which mapped every non-HttpError to 500, so installing
    // withErrorHandler turned a 413 into a 500.  A body cap is a transport
    // decision; Express and Hono never consulted the handler for it either.
    const backend = cappedAt(16);
    let handlerCalls = 0;
    expect(backend.setErrorHandler).toBeDefined();
    backend.setErrorHandler!(() => {
      handlerCalls += 1;
      return completeJson(Status.InternalServerError, { custom: true });
    });
    const url = await start(backend, echoLength());

    const response = await postBytes(url, 64);

    expect(response.status).toBe(413);
    expect(await response.text()).toBe('Payload Too Large');
    expect(handlerCalls).toBe(0);
  });

  test('a per-backend cap still overrides the shared default', async () => {
    const url = await start(cappedAt(DEFAULT_HTTP_MAX_BODY_BYTES * 2), echoLength());

    const response = await postBytes(url, DEFAULT_HTTP_MAX_BODY_BYTES + 1);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ length: DEFAULT_HTTP_MAX_BODY_BYTES + 1 });
  });
});

describe('FastifyBackend — error handling around the cap', () => {
  test('a route error still reaches the installed error handler', async () => {
    // The 413 short-circuit must not swallow the ordinary path: the hook is
    // now installed for every server, so this is what proves it still
    // delegates everything that is not a body-size refusal.
    const backend = new FastifyBackend({ logger: false });
    backend.setErrorHandler((err) => completeJson(Status.InternalServerError, {
      custom: true,
      name: (err as Error).name,
    }));
    const url = await start(backend, path('boom', post(() => { throw new Error('x'); })));

    const response = await fetch(`${url}/boom`, { method: 'POST' });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ custom: true, name: 'Error' });
  });

  test('without an error handler a route error is still the opaque 500', async () => {
    // The hook is installed for every server now, including ones that never
    // called withErrorHandler — this pins that it changed nothing about the
    // shape a bare server answers a thrown handler error with.
    const url = await start(new FastifyBackend({ logger: false }), path('boom', post(() => { throw new Error('leaky detail'); })));

    const response = await fetch(`${url}/boom`, { method: 'POST' });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal Server Error' });
  });
});
