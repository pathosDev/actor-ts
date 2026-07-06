import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem, ActorSystemOptions } from '../../../src/ActorSystem.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import {
  complete,
  completeJson,
  concat,
  del,
  get,
  path,
  post,
} from '../../../src/http/Route.js';
import { entity } from '../../../src/http/Marshalling.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpError, Status } from '../../../src/http/types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

const bindings: ServerBinding[] = [];

afterEach(async () => {
  while (bindings.length) await bindings.shift()!.unbind();
});

async function startServer(routes: Parameters<ReturnType<ReturnType<typeof newHttp>['newServerAt']>['bind']>[0]): Promise<{ url: string; system: ActorSystem; binding: ServerBinding }> {
  const system = ActorSystem.create('http-test', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
  const ext = system.extension(HttpExtensionId);
  const backend = new FastifyBackend({ logger: false });
  const binding = await ext.newServerAt('127.0.0.1', 0).useBackend(backend).bind(routes);
  bindings.push(binding);
  return { url: `http://${binding.host}:${binding.port}`, system, binding };
}

function newHttp(): ReturnType<ActorSystem['extension']> extends object ? any : never {
  // Only used for the type inference helper above.
  return null as unknown as never;
}

describe('FastifyBackend — plain routes', () => {
  test('GET returns the body and status', async () => {
    const { url } = await startServer(get(() => complete(Status.OK, 'hello')));
    const res = await fetch(`${url}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });

  test('404 on unknown path', async () => {
    const { url } = await startServer(path('known', get(() => complete(Status.OK, ''))));
    const res = await fetch(`${url}/missing`);
    expect(res.status).toBe(404);
  });

  test('JSON body encodes correctly', async () => {
    const { url } = await startServer(get(() => completeJson(Status.OK, { a: 1, b: 'two' })));
    const res = await fetch(`${url}/`);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ a: 1, b: 'two' });
  });

  test('entity() decodes a JSON POST body', async () => {
    const { url } = await startServer(path('echo', post(async (req) => {
      const body = entity<{ who: string }>(req);
      return completeJson(Status.OK, { hi: body.who });
    })));
    const res = await fetch(`${url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ who: 'world' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hi: 'world' });
  });

  test('path parameters are exposed on req.params', async () => {
    const { url } = await startServer(path('users/:id', get(req => completeJson(Status.OK, { id: req.params.id }))));
    const res = await fetch(`${url}/users/42`);
    expect(await res.json()).toEqual({ id: '42' });
  });

  test('HttpError is turned into the right status', async () => {
    const { url } = await startServer(path('fail', get(() => {
      throw new HttpError(Status.BadRequest, 'bad-request', { detail: 'x' });
    })));
    const res = await fetch(`${url}/fail`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; detail?: string };
    expect(body.error).toBe('bad-request');
    expect(body.detail).toBe('x');
  });

  test('generic thrown errors become 500', async () => {
    const { url } = await startServer(path('boom', get(() => { throw new Error('kaboom'); })));
    const res = await fetch(`${url}/boom`);
    expect(res.status).toBe(500);
  });

  test('combined CRUD shape serves four routes under one prefix', async () => {
    const state: Record<string, string> = {};
    const routes = path('users', concat(
      get(() => completeJson(Status.OK, state)),
      post(async (req) => {
        const body = entity<{ id: string; name: string }>(req);
        state[body.id] = body.name;
        return completeJson(Status.Created, state);
      }),
      path(':id', concat(
        get(req => {
          const n = state[req.params.id];
          return n ? completeJson(Status.OK, { id: req.params.id, name: n })
                   : complete(Status.NotFound, 'not-found');
        }),
        del(req => { delete state[req.params.id]; return complete(Status.NoContent); }),
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

describe('FastifyBackend — remoteAddress wiring (#312)', () => {
  test('populates req.remoteAddress from the socket peer', async () => {
    let captured: string | undefined;
    const { url } = await startServer(get((req) => {
      captured = req.remoteAddress;
      return complete(Status.OK, 'ok');
    }));
    await fetch(`${url}/`);
    // Localhost loopback — exact representation varies (127.0.0.1
    // or ::1 or ::ffff:127.0.0.1 depending on stack), but must
    // be populated and be a valid IP-shaped string.
    expect(typeof captured).toBe('string');
    expect(captured!.length).toBeGreaterThan(0);
    // Sanity check: looks like an IP (digits / colons / dots only).
    expect(/^[0-9a-fA-F.:]+$/.test(captured!)).toBe(true);
  });
});

describe('FastifyBackend — shutdown semantics', () => {
  test('unbind returns promptly even when WebSocket clients are connected', async () => {
    // Regression: `app.close()` waits for every long-lived
    // connection to drain.  Upgraded WebSocket sockets never drain
    // on their own, so the chat sample's SIGINT path used to hang
    // at "[ingress] giving up HTTP port 8080" until the OS killed
    // the process.  `unbind()` must force-terminate WS clients
    // (via `app.websocketServer.clients`) so the close resolves
    // instead of waiting forever.
    const system = ActorSystem.create('http-ws-shutdown', ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off));
    const backend = new FastifyBackend({ logger: false });
    const wsMod = (await import('@fastify/websocket')) as {
      default?: unknown;
      fastifyWebsocket?: unknown;
    };
    const wsPlugin = wsMod.default ?? wsMod.fastifyWebsocket ?? wsMod;
    await backend.withPlugin(wsPlugin);
    await backend.withPlugin(async (fastify: { get: (path: string, opts: object, handler: (socket: unknown) => void) => void }) => {
      fastify.get('/ws', { websocket: true }, () => { /* keep open */ });
    });
    const ext = system.extension(HttpExtensionId);
    const binding = await ext.newServerAt('127.0.0.1', 0).useBackend(backend).bind(
      get(() => complete(Status.OK, 'ok')),
    );

    // Open a real WebSocket client and wait for the upgrade.
    const ws = new WebSocket(`ws://${binding.host}:${binding.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('ws connect failed')), { once: true });
    });

    // Without the fix `unbind()` would hang until the test runner
    // timed out.  Cap the assertion at 2 s — well above what a
    // healthy force-close needs (typically <100 ms) but short
    // enough that a regression is obvious.
    const start = Date.now();
    await Promise.race([
      binding.unbind(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('unbind timed out — close hung on WS client')), 2_000),
      ),
    ]);
    expect(Date.now() - start).toBeLessThan(2_000);

    // Cleanup: socket is already terminated server-side; the client
    // notices on the next IO tick.
    try { ws.close(); } catch { /* ignore */ }
    await system.terminate();
  });
});

describe('HttpExtension — client round-trip', () => {
  test('HttpClient.get fetches a server-rendered body', async () => {
    const { url, system } = await startServer(get(() => completeJson(Status.OK, { pong: true })));
    const client = system.extension(HttpExtensionId).client;
    const res = await client.get(`${url}/`);
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ pong: true });
  });

  test('HttpClient.post round-trips a JSON body', async () => {
    const { url, system } = await startServer(path('echo', post(async (req) => {
      return completeJson(Status.OK, entity(req) as object);
    })));
    const client = system.extension(HttpExtensionId).client;
    const res = await client.post(`${url}/echo`, { body: { hello: 'world' } });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ hello: 'world' });
  });
});
