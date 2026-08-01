import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { ExpressBackendOptions } from '../../../src/http/backend/ExpressBackendOptions.js';
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
  const system = ActorSystem.create('http-express-test', sysOptions);
  const ext = system.extension(HttpExtensionId);
  const backend = new ExpressBackend();
  const binding = await ext.newServerAt('127.0.0.1', 0).useBackend(backend).bind(routes);
  bindings.push({ binding, system });
  return { url: `http://${binding.host}:${binding.port}`, system, binding };
}

describe('ExpressBackend — plain routes', () => {
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

describe('ExpressBackend — remoteAddress wiring (#312)', () => {
  test('populates request.remoteAddress from request.ip', async () => {
    let captured: string | undefined;
    const { url } = await startServer(get((request) => {
      captured = request.remoteAddress;
      return complete(Status.OK, 'ok');
    }));
    await fetch(`${url}/`);
    expect(typeof captured).toBe('string');
    expect(captured!.length).toBeGreaterThan(0);
    expect(/^[0-9a-fA-F.:]+$/.test(captured!)).toBe(true);
  });
});

describe('ExpressBackend — custom handlers', () => {
  test('setNotFound delivers a custom 404 body', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('http-express-custom', sysOptions);
    const ext = system.extension(HttpExtensionId);
    const backend = new ExpressBackend();
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
    const system = ActorSystem.create('http-express-err', sysOptions);
    const ext = system.extension(HttpExtensionId);
    const backend = new ExpressBackend();
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

describe('ExpressBackend — body size limit', () => {
  test('413 when payload exceeds maxBodyBytes', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('http-express-413', sysOptions);
    const ext = system.extension(HttpExtensionId);
    const expressOptions = ExpressBackendOptions.create()
      .withMaxBodyBytes(16);
    const backend = new ExpressBackend(expressOptions);
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
});

describe('HttpExtension + ExpressBackend — client round-trip', () => {
  test('HttpClient.post round-trips JSON through an Express server', async () => {
    const { url, system } = await startServer(path('echo', post(async (request) =>
      completeJson(Status.OK, entity(request) as object),
    )));
    const client = system.extension(HttpExtensionId).client;
    const response = await client.post(`${url}/echo`, { body: { hello: 'world' } });
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ hello: 'world' });
  });
});
