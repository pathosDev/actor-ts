import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { HonoBackend } from '../../../src/http/backend/HonoBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import {
  complete,
  completeJson,
  compile,
  concat,
  fallback,
  get,
  path,
  withMiddleware,
  type Middleware,
  type Route,
} from '../../../src/http/Route.js';
import type { HttpServerBackend, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpError, Status } from '../../../src/http/types.js';
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
  const system = ActorSystem.create('http-fallback-test', sysOptions);
  try {
    const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).useBackend(mk()).bind(routes);
    live.push({ binding, system });
    return `http://${binding.host}:${binding.port}`;
  } catch (e) {
    await system.terminate();
    throw e;
  }
}

describe.each(backends)('fallback() — %s backend', (_name, mk) => {
  test('answers an unmatched path', async () => {
    const url = await start(mk, concat(
      path('known', get(() => complete(Status.OK, 'yes'))),
      fallback((req) => completeJson(Status.NotFound, { error: 'no route', path: req.path })),
    ));
    const res = await fetch(`${url}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no route', path: '/nope' });
  });

  test('matched routes still win — a fallback declared first does not shadow them', async () => {
    const url = await start(mk, concat(
      fallback(() => complete(Status.NotFound, 'fb')),
      path('known', get(() => complete(Status.OK, 'real'))),
    ));
    expect(await (await fetch(`${url}/known`)).text()).toBe('real');
    expect((await fetch(`${url}/other`)).status).toBe(404);
  });

  test('a method mismatch on an existing path hits the fallback (404, not 405)', async () => {
    const url = await start(mk, concat(
      path('thing', get(() => complete(Status.OK, 'g'))),
      fallback(() => complete(Status.NotFound, 'fb')),
    ));
    const res = await fetch(`${url}/thing`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('fb');
  });

  test('an unmatched OPTIONS request hits the fallback', async () => {
    const url = await start(mk, concat(
      path('thing', get(() => complete(Status.OK, 'g'))),
      fallback(() => complete(Status.NoContent)),
    ));
    // Use a path with no route at all — avoids backends' automatic
    // OPTIONS handling for paths that DO have routes (e.g. Express).
    const res = await fetch(`${url}/totally-unknown`, { method: 'OPTIONS' });
    expect(res.status).toBe(Status.NoContent);
  });

  test('a fallback throwing HttpError maps to that status', async () => {
    const url = await start(mk, fallback(() => { throw new HttpError(Status.Forbidden, 'blocked'); }));
    expect((await fetch(`${url}/whatever`)).status).toBe(Status.Forbidden);
  });

  test('middleware wraps the fallback handler', async () => {
    const stamp: Middleware = async (_req, next) => {
      const r = await next();
      return { ...r, headers: { ...(r.headers ?? {}), 'x-fb': '1' } };
    };
    const url = await start(mk, withMiddleware(stamp, fallback(() => complete(Status.NotFound, 'fb'))));
    const res = await fetch(`${url}/x`);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-fb')).toBe('1');
  });
});

describe('fallback() — compile + bind guards', () => {
  test('a fallback scoped under path() throws at compile time', () => {
    expect(() => compile(path('api', fallback(() => complete(Status.NotFound, '')))))
      .toThrow(/root of the route tree/);
  });

  test('two fallbacks are rejected at bind', async () => {
    await expect(start(() => new FastifyBackend({ logger: false }), concat(
      fallback(() => complete(Status.NotFound, 'a')),
      fallback(() => complete(Status.NotFound, 'b')),
    ))).rejects.toThrow(/exactly one not-found handler/);
  });

  test('a backend without a setNotFound hook is rejected at bind', async () => {
    const stub: HttpServerBackend = {
      name: 'stub',
      registerRoute() {},
      async listen(host, port) { return { host, port, async unbind() {} }; },
    };
    await expect(start(() => stub, fallback(() => complete(Status.NotFound, ''))))
      .rejects.toThrow(/does not support fallback/);
  });
});
