import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { HonoBackend, contentLengthExceeds, readBufferedAmount } from '../../../src/http/backend/HonoBackend.js';
import { HonoBackendOptions } from '../../../src/http/backend/HonoBackendOptions.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import {
  complete,
  completeJson,
  concat,
  del,
  get,
  path,
  post,
  put,
} from '../../../src/http/Route.js';
import { entity } from '../../../src/http/Marshalling.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpError, Status } from '../../../src/http/types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import type { Route } from '../../../src/http/Route.js';

const bindings: Array<{ binding: ServerBinding; system: ActorSystem }> = [];

afterEach(async () => {
  while (bindings.length) {
    const { binding, system } = bindings.shift()!;
    await binding.unbind();
    await system.terminate();
  }
});

async function startServer(routes: Route): Promise<{ url: string; system: ActorSystem; binding: ServerBinding }> {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('http-hono-test', sysOptions);
  const ext = system.extension(HttpExtensionId);
  const backend = new HonoBackend();
  const binding = await ext.newServerAt('127.0.0.1', 0).useBackend(backend).bind(routes);
  bindings.push({ binding, system });
  return { url: `http://${binding.host}:${binding.port}`, system, binding };
}

describe('HonoBackend — plain routes', () => {
  test('GET returns the body and status', async () => {
    const { url } = await startServer(get(() => complete(Status.OK, 'hello')));
    const response = await fetch(`${url}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello');
  });

  test('404 on unknown path', async () => {
    const { url } = await startServer(path('known', get(() => complete(Status.OK, ''))));
    const response = await fetch(`${url}/missing`);
    expect(response.status).toBe(404);
  });

  test('JSON body encodes correctly', async () => {
    const { url } = await startServer(get(() => completeJson(Status.OK, { a: 1, b: 'two' })));
    const response = await fetch(`${url}/`);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ a: 1, b: 'two' });
  });

  test('entity() decodes a JSON POST body', async () => {
    const { url } = await startServer(path('echo', post(async (request) => {
      const body = entity<{ who: string }>(request);
      return completeJson(Status.OK, { hi: body.who });
    })));
    const response = await fetch(`${url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ who: 'world' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hi: 'world' });
  });

  test('path parameters are exposed on request.params', async () => {
    const { url } = await startServer(path('users/:id', get(request => completeJson(Status.OK, { id: request.params.id }))));
    const response = await fetch(`${url}/users/42`);
    expect(await response.json()).toEqual({ id: '42' });
  });

  test('HttpError is turned into the right status', async () => {
    const { url } = await startServer(path('fail', get(() => {
      throw new HttpError(Status.BadRequest, 'bad-request', { detail: 'x' });
    })));
    const response = await fetch(`${url}/fail`);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string; detail?: string };
    expect(body.error).toBe('bad-request');
    expect(body.detail).toBe('x');
  });

  test('generic thrown errors become 500', async () => {
    const { url } = await startServer(path('boom', get(() => { throw new Error('kaboom'); })));
    const response = await fetch(`${url}/boom`);
    expect(response.status).toBe(500);
  });

  test('query parameters are exposed on request.query', async () => {
    const { url } = await startServer(path('search', get(request =>
      completeJson(Status.OK, { q: request.query.q ?? null }),
    )));
    const response = await fetch(`${url}/search?q=hello`);
    expect(await response.json()).toEqual({ q: 'hello' });
  });

  test('PUT round-trips raw bytes', async () => {
    const { url } = await startServer(path('raw', put(async (request) => {
      const len = request.body?.byteLength ?? 0;
      return completeJson(Status.OK, { len });
    })));
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const response = await fetch(`${url}/raw`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload,
    });
    expect(await response.json()).toEqual({ len: 8 });
  });

  test('combined CRUD shape serves four routes under one prefix', async () => {
    const state: Record<string, string> = {};
    const routes = path('users', concat(
      get(() => completeJson(Status.OK, state)),
      post(async (request) => {
        const body = entity<{ id: string; name: string }>(request);
        state[body.id] = body.name;
        return completeJson(Status.Created, state);
      }),
      path(':id', concat(
        get(request => {
          const count = state[request.params.id];
          return count ? completeJson(Status.OK, { id: request.params.id, name: count })
                   : complete(Status.NotFound, 'not-found');
        }),
        del(request => { delete state[request.params.id]; return complete(Status.NoContent); }),
      )),
    ));
    const { url } = await startServer(routes);

    const created = await fetch(`${url}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '1', name: 'alice' }),
    });
    expect(created.status).toBe(201);

    const list = await fetch(`${url}/users`);
    expect(await list.json()).toEqual({ '1': 'alice' });

    const one = await fetch(`${url}/users/1`);
    expect(await one.json()).toEqual({ id: '1', name: 'alice' });

    const dropped = await fetch(`${url}/users/1`, { method: 'DELETE' });
    expect(dropped.status).toBe(204);

    const afterDelete = await fetch(`${url}/users/1`);
    expect(afterDelete.status).toBe(404);
  });
});

describe('HonoBackend — remoteAddress wiring (#312)', () => {
  test('populates request.remoteAddress best-effort (Bun runtime, env.requestIP)', async () => {
    let captured: string | undefined;
    const { url } = await startServer(get((request) => {
      captured = request.remoteAddress;
      return complete(Status.OK, 'ok');
    }));
    await fetch(`${url}/`);
    // Hono on Bun: `c.env.requestIP(request.raw)` may or may not be
    // populated depending on the adapter version.  When it IS,
    // we get an IP string; when it isn't, remoteAddress stays
    // undefined — which is correct fail-secure behaviour (the
    // downstream `IpAllowlist` defaults to 403 on missing IP).
    // The acceptance criterion: either undefined OR a string that
    // looks like an IP.  Either is a valid outcome; what we forbid
    // is "garbage non-IP string".
    if (captured !== undefined) {
      expect(typeof captured).toBe('string');
      expect(captured.length).toBeGreaterThan(0);
      expect(/^[0-9a-fA-F.:]+$/.test(captured)).toBe(true);
    }
  });
});

describe('HonoBackend — custom handlers', () => {
  test('setNotFound delivers a custom 404 body', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('http-hono-custom', sysOptions);
    const ext = system.extension(HttpExtensionId);
    const backend = new HonoBackend();
    backend.setNotFound(() => completeJson(Status.NotFound, { oops: true }));
    const binding = await ext.newServerAt('127.0.0.1', 0)
      .useBackend(backend)
      .bind(path('hi', get(() => complete(Status.OK, 'hi'))));
    bindings.push({ binding, system });

    const response = await fetch(`http://127.0.0.1:${binding.port}/missing`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ oops: true });
  });

  test('setErrorHandler overrides the default 500 shape', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('http-hono-err', sysOptions);
    const ext = system.extension(HttpExtensionId);
    const backend = new HonoBackend();
    backend.setErrorHandler((err) =>
      completeJson(Status.InternalServerError, { custom: true, name: (err as Error).name }),
    );
    const binding = await ext.newServerAt('127.0.0.1', 0)
      .useBackend(backend)
      .bind(path('boom', get(() => { throw new Error('x'); })));
    bindings.push({ binding, system });

    const response = await fetch(`http://127.0.0.1:${binding.port}/boom`);
    const body = await response.json() as { custom: boolean; name: string };
    expect(body.custom).toBe(true);
    expect(body.name).toBe('Error');
  });
});

describe('HonoBackend — body size limit', () => {
  test('413 when payload exceeds maxBodyBytes', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('http-hono-413', sysOptions);
    const ext = system.extension(HttpExtensionId);
    const honoOptions = HonoBackendOptions.create()
      .withMaxBodyBytes(16);
    const backend = new HonoBackend(honoOptions);
    const binding = await ext.newServerAt('127.0.0.1', 0)
      .useBackend(backend)
      .bind(path('up', post(() => complete(Status.OK, 'ok'))));
    bindings.push({ binding, system });

    const big = new Uint8Array(64);
    const response = await fetch(`http://127.0.0.1:${binding.port}/up`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: big,
    });
    expect(response.status).toBe(413);
  });

  // security audit HTTP-1: the oversize request must be rejected before
  // the handler runs (previously the whole body was buffered first).
  test('oversize request never reaches the handler', async () => {
    let called = false;
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('http-hono-413-guard', sysOptions);
    const ext = system.extension(HttpExtensionId);
    const honoOptions = HonoBackendOptions.create().withMaxBodyBytes(16);
    const backend = new HonoBackend(honoOptions);
    const binding = await ext.newServerAt('127.0.0.1', 0).useBackend(backend)
      .bind(path('up', post(() => { called = true; return complete(Status.OK, 'ok'); })));
    bindings.push({ binding, system });

    const response = await fetch(`http://127.0.0.1:${binding.port}/up`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(64),
    });
    expect(response.status).toBe(413);
    expect(called).toBe(false);
  });

  test('a body at/under the cap still reaches the handler', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('http-hono-under-cap', sysOptions);
    const ext = system.extension(HttpExtensionId);
    const honoOptions = HonoBackendOptions.create().withMaxBodyBytes(16);
    const backend = new HonoBackend(honoOptions);
    const binding = await ext.newServerAt('127.0.0.1', 0).useBackend(backend)
      .bind(path('up', post((request) => completeJson(Status.OK, { len: request.body?.byteLength ?? 0 }))));
    bindings.push({ binding, system });

    const response = await fetch(`http://127.0.0.1:${binding.port}/up`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(8),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ len: 8 });
  });
});

describe('HonoBackend — contentLengthExceeds (HTTP-1 fast-path predicate)', () => {
  test('true when the declared length is over the cap', () => {
    expect(contentLengthExceeds('64', 16)).toBe(true);
    expect(contentLengthExceeds('17', 16)).toBe(true);
  });

  test('false at or under the cap', () => {
    expect(contentLengthExceeds('16', 16)).toBe(false);
    expect(contentLengthExceeds('0', 16)).toBe(false);
  });

  test('false for missing/non-numeric header (backstop handles those)', () => {
    expect(contentLengthExceeds(undefined, 16)).toBe(false);
    expect(contentLengthExceeds('not-a-number', 16)).toBe(false);
  });
});

describe('HonoBackend — readBufferedAmount (WS-4 backpressure signal)', () => {
  test('Bun-style getBufferedAmount()', () => {
    expect(readBufferedAmount({ getBufferedAmount: () => 42 })).toBe(42);
  });
  test('Node/Deno-style numeric .bufferedAmount', () => {
    expect(readBufferedAmount({ bufferedAmount: 17 })).toBe(17);
  });
  test('unknown / missing / bogus shapes → 0 (guard stays off)', () => {
    expect(readBufferedAmount(undefined)).toBe(0);
    expect(readBufferedAmount(null)).toBe(0);
    expect(readBufferedAmount({})).toBe(0);
    expect(readBufferedAmount({ bufferedAmount: 'nope' })).toBe(0);
    expect(readBufferedAmount({ getBufferedAmount: () => NaN })).toBe(0);
  });
});

describe('HttpExtension + HonoBackend — client round-trip', () => {
  test('HttpClient.post round-trips JSON through a Hono server', async () => {
    const { url, system } = await startServer(path('echo', post(async (request) =>
      completeJson(Status.OK, entity(request) as object),
    )));
    const client = system.extension(HttpExtensionId).client;
    const response = await client.post(`${url}/echo`, { body: { hello: 'world' } });
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ hello: 'world' });
  });
});
