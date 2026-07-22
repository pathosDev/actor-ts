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
  get,
  handleErrors,
  type Route,
} from '../../../src/http/Route.js';
import type { HttpServerBackend, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpError, Status, type HttpRequest, type HttpResponse } from '../../../src/http/types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

const backends: Array<[string, () => HttpServerBackend]> = [
  ['fastify', () => new FastifyBackend({ logger: false })],
  ['express', () => new ExpressBackend()],
  ['hono', () => new HonoBackend()],
];

type ErrHandler = (err: unknown, request: HttpRequest) => Promise<HttpResponse> | HttpResponse;

const live: Array<{ binding: ServerBinding; system: ActorSystem }> = [];
afterEach(async () => {
  while (live.length) {
    const { binding, system } = live.shift()!;
    await binding.unbind();
    await system.terminate();
  }
});

async function start(mk: () => HttpServerBackend, routes: Route, onError?: ErrHandler): Promise<string> {
  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('http-errorhandler-test', sysOptions);
  try {
    let builder = system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).useBackend(mk());
    if (onError) builder = builder.withErrorHandler(onError);
    const binding = await builder.bind(routes);
    live.push({ binding, system });
    return `http://${binding.host}:${binding.port}`;
  } catch (e) {
    await system.terminate();
    throw e;
  }
}

describe.each(backends)('withErrorHandler — %s backend', (_name, mk) => {
  test('replaces the default mapping for a generic handler throw', async () => {
    // A generic Error never reaching a user handler would be a 500; the
    // server-wide handler intercepts it. On Fastify this also proves the
    // per-route catch now routes through setErrorHandler.
    const url = await start(mk, get(() => { throw new Error('kaboom'); }),
      (err) => completeJson(Status.BadGateway, { handled: true, msg: (err as Error).message }));
    const response = await fetch(`${url}/`);
    expect(response.status).toBe(Status.BadGateway);
    expect(await response.json()).toEqual({ handled: true, msg: 'kaboom' });
  });

  test('receives the original HttpError instance', async () => {
    let seenStatus = 0;
    const url = await start(mk, get(() => { throw new HttpError(Status.Conflict, 'conflict'); }),
      (err) => { seenStatus = (err as HttpError).status; return complete(Status.OK, 'ok'); });
    await fetch(`${url}/`);
    expect(seenStatus).toBe(Status.Conflict);
  });

  test('an error handler that itself throws falls back to the default mapping', async () => {
    const url = await start(mk, get(() => { throw new HttpError(Status.Conflict, 'conflict'); }),
      () => { throw new Error('handler broke'); });
    // The default mapping runs on the handler's thrown error (a plain
    // Error) → generic 500, uniformly across backends.
    expect((await fetch(`${url}/`)).status).toBe(Status.InternalServerError);
  });

  test('a scoped handleErrors takes precedence over withErrorHandler', async () => {
    const url = await start(mk,
      handleErrors(() => complete(Status.Accepted, 'scoped'), get(() => { throw new HttpError(Status.InternalServerError, 'x'); })),
      () => complete(Status.BadGateway, 'server'));
    const response = await fetch(`${url}/`);
    expect(response.status).toBe(Status.Accepted);
    expect(await response.text()).toBe('scoped');
  });
});

describe('withErrorHandler — bind guard', () => {
  test('a backend without a setErrorHandler hook is rejected at bind', async () => {
    const stub: HttpServerBackend = {
      name: 'stub',
      registerRoute() {},
      async listen(host, port) { return { host, port, async unbind() {} }; },
    };
    await expect(start(() => stub, get(() => complete(Status.OK, '')), () => complete(Status.OK, '')))
      .rejects.toThrow(/does not support withErrorHandler/);
  });
});
