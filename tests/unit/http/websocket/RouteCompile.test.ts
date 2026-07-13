import { describe, expect, test } from 'bun:test';
import {
  compile,
  complete,
  concat,
  get,
  path,
  withMiddleware,
  type CompiledEndpoint,
  type CompiledWebsocketRoute,
  type Middleware,
  type Route,
  type WebsocketConnectHandler,
} from '../../../../src/http/Route.js';
import { HttpError, Status } from '../../../../src/http/types.js';
import type { HttpRequest } from '../../../../src/http/types.js';

const noopConnect: WebsocketConnectHandler = () => {};

/** Build a raw websocket Route node (the public `websocket()` directive lands later). */
function ws(connect: WebsocketConnectHandler = noopConnect): Route {
  return { kind: 'websocket', connect };
}

function wsOnly(endpoints: CompiledEndpoint[]): CompiledWebsocketRoute[] {
  return endpoints.filter((endpoint): endpoint is CompiledWebsocketRoute => endpoint.kind === 'websocket');
}

const req = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  method: 'GET',
  path: '/ws',
  headers: {},
  query: {},
  params: {},
  body: null,
  ...overrides,
});

describe('compile — websocket routes', () => {
  test('a bare websocket node compiles to one GET-verb ws endpoint at root', async () => {
    const eps = compile(ws());
    expect(eps).toHaveLength(1);
    const endpoint = eps[0]!;
    expect(endpoint.kind).toBe('websocket');
    expect(endpoint.method).toBe('GET');
    expect(endpoint.pattern).toBe('/');
    const ws0 = endpoint as CompiledWebsocketRoute;
    expect(ws0.connect).toBe(noopConnect);
    // Default authorize accepts (null).
    expect(await ws0.authorize(req())).toBeNull();
  });

  test('path() prefixes the ws pattern and keeps :params verbatim', () => {
    expect(wsOnly(compile(path('ws', ws())))[0]!.pattern).toBe('/ws');
    expect(wsOnly(compile(path('room/:id', ws())))[0]!.pattern).toBe('/room/:id');
  });

  test('coexists with http siblings under concat', () => {
    const eps = compile(concat(
      path('ws', ws()),
      path('health', get(() => complete(Status.OK, 'ok'))),
    ));
    expect(eps).toHaveLength(2);
    expect(eps.filter((endpoint) => endpoint.kind === 'websocket')).toHaveLength(1);
    expect(eps.filter((endpoint) => endpoint.kind === 'http')).toHaveLength(1);
  });

  test('two websocket routes both compile', () => {
    const eps = wsOnly(compile(concat(path('a', ws()), path('b', ws()))));
    expect(eps.map((endpoint) => endpoint.pattern).sort()).toEqual(['/a', '/b']);
  });
});

describe('compile — middleware folds into ws authorize (runs at upgrade)', () => {
  const passthrough: Middleware = (_req, next) => next();

  test('passthrough middleware → authorize accepts (null)', async () => {
    const endpoint = wsOnly(compile(withMiddleware(passthrough, ws())))[0]!;
    expect(await endpoint.authorize(req())).toBeNull();
  });

  test('short-circuiting middleware → authorize returns the rejection response', async () => {
    const block: Middleware = () => complete(Status.Unauthorized, 'denied');
    const endpoint = wsOnly(compile(withMiddleware(block, ws())))[0]!;
    const res = await endpoint.authorize(req());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(Status.Unauthorized);
  });

  test('middleware throwing HttpError → authorize returns that status + message', async () => {
    const bad: Middleware = () => { throw new HttpError(Status.Forbidden, 'nope', { reason: 'x' }); };
    const endpoint = wsOnly(compile(withMiddleware(bad, ws())))[0]!;
    const res = await endpoint.authorize(req());
    expect(res!.status).toBe(Status.Forbidden);
    expect(res!.body).toEqual({ error: 'nope', reason: 'x' });
  });

  test('middleware sees the upgrade request (can reject on a missing header)', async () => {
    const requireToken: Middleware = (r, next) =>
      r.headers['authorization'] ? next() : complete(Status.Unauthorized, 'no token');
    const endpoint = wsOnly(compile(withMiddleware(requireToken, path('ws', ws()))))[0]!;
    expect(await endpoint.authorize(req())).not.toBeNull();
    expect(await endpoint.authorize(req({ headers: { authorization: 'Bearer t' } }))).toBeNull();
  });

  test('nested middleware: outer passes, inner blocks → reject', async () => {
    const block: Middleware = () => complete(Status.Forbidden, 'inner-deny');
    const endpoint = wsOnly(compile(withMiddleware(passthrough, withMiddleware(block, ws()))))[0]!;
    expect((await endpoint.authorize(req()))!.status).toBe(Status.Forbidden);
  });

  test('nested middleware: both pass → accept', async () => {
    const endpoint = wsOnly(compile(withMiddleware(passthrough, withMiddleware(passthrough, ws()))))[0]!;
    expect(await endpoint.authorize(req())).toBeNull();
  });
});
