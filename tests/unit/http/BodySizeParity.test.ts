import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { DEFAULT_HTTP_MAX_BODY_BYTES } from '../../../src/http/Constants.js';
import { FastifyBackend, fastifyFactoryOptions } from '../../../src/http/backend/FastifyBackend.js';
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
import { HttpServerOptions, type HttpServerOptionsType } from '../../../src/http/HttpServerOptions.js';
import { completeJson, path, post, type Route } from '../../../src/http/Route.js';
import { Status } from '../../../src/http/Types.js';
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

/**
 * #1488 — the server-level cap, `actor-ts.http.server.max-content-length`.
 *
 * Before it, a HOCON block naming the key bound without error and capped
 * nothing: a 1 KiB POST under `max-content-length = 16` was answered 200 on
 * the framework-built Fastify.  Each case below is asserted for every backend
 * it applies to, and through both layers that can set the key, because the
 * three backends hold the cap in three different places — Fastify at
 * construction, Express and Hono in their own body readers at `listen()`.
 *
 * Unset is the other half and is pinned above: with no key, a backend keeps
 * its own cap — the shared 1 MiB, or what `withMaxBodyBytes` / `bodyLimit` set
 * (the `cappedAt` cases).  A *set* key that differs from a cap the backend
 * was built with is refused at `bind()` rather than left to pick one.
 */
const KEY_CAP_BYTES = 16;
const OVER_KEY_CAP_BYTES = 1024;
const MAX_CONTENT_LENGTH = 'actor-ts.http.server.max-content-length';

type Setup = {
  /** HOCON for the system, if any. */
  readonly hocon?: string;
  /** The explicit layer, if any. */
  readonly serverOptions?: HttpServerOptions;
  /** A backend built by hand; absent, the framework builds the one `actor-ts.http.backend` names. */
  readonly backend?: HttpServerBackend;
};

/** Bind under `setup`; resolves with the base URL, rejects with whatever `bind()` threw. */
async function startWith(setup: Setup, routes: Route): Promise<string> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(setup.hocon ?? ''));
  const system = ActorSystem.create('http-body-size-key', systemOptions);
  try {
    let builder = system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0);
    if (setup.backend !== undefined) builder = builder.useBackend(setup.backend);
    if (setup.serverOptions !== undefined) builder = builder.withServerOptions(setup.serverOptions);
    const binding = await builder.bind(routes);
    live.push({ binding, system });
    return `http://${binding.host}:${binding.port}`;
  } catch (e) {
    await system.terminate();
    throw e;
  }
}

/** HOCON naming the framework-built backend, with `max-content-length` set when given. */
function onBackend(name: string, maxContentLength?: number): string {
  return maxContentLength === undefined
    ? `actor-ts.http.backend = ${name}`
    : `actor-ts.http.backend = ${name}\n${MAX_CONTENT_LENGTH} = ${maxContentLength}`;
}

/** What `bind()` threw under `setup`, or `undefined` when it bound. */
async function bindRefusal(setup: Setup): Promise<Error | undefined> {
  try {
    await startWith(setup, echoLength());
    return undefined;
  } catch (e) {
    return e as Error;
  }
}

/** Assert the shared refusal, and that the body never became the handler's problem. */
async function expectRefusedBeforeTheHandler(url: string, seen: { called: boolean }): Promise<void> {
  const response = await postBytes(url, OVER_KEY_CAP_BYTES);
  expect(response.status).toBe(PAYLOAD_TOO_LARGE_RESPONSE.status);
  expect(await response.text()).toBe(PAYLOAD_TOO_LARGE_RESPONSE.body as string);
  expect(seen.called).toBe(false);
}

describe.each(['fastify', 'express', 'hono'])('max-content-length — the framework-built %s backend', (name) => {
  test('a 1 KiB body under max-content-length = 16 from HOCON is refused before the handler runs', async () => {
    const seen = { called: false };
    const url = await startWith({ hocon: onBackend(name, KEY_CAP_BYTES) }, echoLength(seen));

    await expectRefusedBeforeTheHandler(url, seen);
  });

  test('the same cap from withServerOptions', async () => {
    const seen = { called: false };
    const serverOptions = HttpServerOptions.create().withMaxContentLength(KEY_CAP_BYTES);
    const url = await startWith({ hocon: onBackend(name), serverOptions }, echoLength(seen));

    await expectRefusedBeforeTheHandler(url, seen);
  });

  test('a body exactly at the key\'s cap is accepted', async () => {
    const url = await startWith({ hocon: onBackend(name, KEY_CAP_BYTES) }, echoLength());

    const response = await postBytes(url, KEY_CAP_BYTES);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ length: KEY_CAP_BYTES });
  });

  test('the key raises the cap too — a body over the shared 1 MiB is accepted under a 2 MiB key', async () => {
    // Not only a lowering knob: a deployment that legitimately takes larger
    // bodies sets the key and every backend follows, Fastify included.
    const url = await startWith({ hocon: onBackend(name, DEFAULT_HTTP_MAX_BODY_BYTES * 2) }, echoLength());

    const response = await postBytes(url, DEFAULT_HTTP_MAX_BODY_BYTES + 1);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ length: DEFAULT_HTTP_MAX_BODY_BYTES + 1 });
  });
});

describe.each([
  ['express', () => new ExpressBackend()],
  ['hono', () => new HonoBackend()],
] as const)('max-content-length — a %s backend built by hand with no cap of its own', (_name, make) => {
  test('adopts the key: a 1 KiB body under max-content-length = 16 is refused before the handler runs', async () => {
    const seen = { called: false };
    const url = await startWith({ hocon: `${MAX_CONTENT_LENGTH} = ${KEY_CAP_BYTES}`, backend: make() }, echoLength(seen));

    await expectRefusedBeforeTheHandler(url, seen);
  });
});

describe('max-content-length — a backend built with a different cap of its own is refused at bind()', () => {
  test('a Fastify built by hand carries the built-in 1 MiB, and is refused naming the key and the remedy', async () => {
    const refusal = await bindRefusal({ hocon: `${MAX_CONTENT_LENGTH} = ${KEY_CAP_BYTES}`, backend: new FastifyBackend() });

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal!.message).toContain(MAX_CONTENT_LENGTH);
    expect(refusal!.message).toContain('fastifyFactoryOptions(serverOptions)');
  });

  test('a Fastify built by hand from fastifyFactoryOptions(serverOptions) binds and caps', async () => {
    const serverOptions = HttpServerOptions.create().withMaxContentLength(KEY_CAP_BYTES);
    const seen = { called: false };
    const url = await startWith({
      serverOptions,
      backend: new FastifyBackend(fastifyFactoryOptions(serverOptions as Partial<HttpServerOptionsType>)),
    }, echoLength(seen));

    await expectRefusedBeforeTheHandler(url, seen);
  });

  test.each([
    ['ExpressBackend', () => new ExpressBackend(ExpressBackendOptions.create().withMaxBodyBytes(4096))],
    ['HonoBackend', () => new HonoBackend(HonoBackendOptions.create().withMaxBodyBytes(4096))],
  ] as const)('%s built withMaxBodyBytes(4096) under max-content-length = 16 is refused naming both', async (name, make) => {
    const refusal = await bindRefusal({ hocon: `${MAX_CONTENT_LENGTH} = ${KEY_CAP_BYTES}`, backend: make() });

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal!.message).toContain(name);
    expect(refusal!.message).toContain(MAX_CONTENT_LENGTH);
    expect(refusal!.message).toContain('withMaxBodyBytes(4096)');
  });

  test.each([
    ['fastify', () => new FastifyBackend({ bodyLimit: KEY_CAP_BYTES })],
    ['express', () => new ExpressBackend(ExpressBackendOptions.create().withMaxBodyBytes(KEY_CAP_BYTES))],
    ['hono', () => new HonoBackend(HonoBackendOptions.create().withMaxBodyBytes(KEY_CAP_BYTES))],
  ] as const)('a %s backend built with the same cap binds — two numbers that agree are one cap', async (_name, make) => {
    const seen = { called: false };
    const url = await startWith({ hocon: `${MAX_CONTENT_LENGTH} = ${KEY_CAP_BYTES}`, backend: make() }, echoLength(seen));

    await expectRefusedBeforeTheHandler(url, seen);
  });

  test('an unset key refuses nothing: a Fastify built with its own bodyLimit binds under no key at all', async () => {
    // The comment-only leaf is what makes this possible — a published default
    // would set the key for every deployment and refuse this backend.
    const url = await startWith({ backend: new FastifyBackend({ bodyLimit: KEY_CAP_BYTES }) }, echoLength());

    expect((await postBytes(url, OVER_KEY_CAP_BYTES)).status).toBe(413);
  });
});
