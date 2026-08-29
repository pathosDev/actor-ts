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
import { HttpError, Status } from '../../../../src/http/Types.js';
import type { HttpRequest, HttpResponse } from '../../../../src/http/Types.js';
import {
  contentSecurityPolicy,
  csrfProtection,
  CsrfOptions,
  requestId,
  securityHeaders,
  strictTransportSecurity,
} from '../../../../src/http/middleware/index.js';
import { DEFAULT_WEBSOCKET_POLICY } from '../../../../src/http/websocket/WebsocketPolicy.js';

const noopConnect: WebsocketConnectHandler = () => {};

/** Build a raw websocket Route node (the public `websocket()` directive lands later). */
function ws(connect: WebsocketConnectHandler = noopConnect): Route {
  return { kind: 'websocket', connect, resolvePolicy: () => DEFAULT_WEBSOCKET_POLICY };
}

function wsOnly(endpoints: CompiledEndpoint[]): CompiledWebsocketRoute[] {
  return endpoints.filter((endpoint): endpoint is CompiledWebsocketRoute => endpoint.kind === 'websocket');
}

const request = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
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
    // Narrow on the discriminant before reading `method` / `pattern`: the
    // fallback member of `CompiledEndpoint` carries neither.
    if (endpoint.kind !== 'websocket') throw new Error(`expected a ws route, got ${endpoint.kind}`);
    expect(endpoint.method).toBe('GET');
    expect(endpoint.pattern).toBe('/');
    const ws0: CompiledWebsocketRoute = endpoint;
    expect(ws0.connect).toBe(noopConnect);
    // Default authorize accepts (null).
    expect(await ws0.authorize(request())).toBeNull();
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
  const passthrough: Middleware = (_request, next) => next();

  test('passthrough middleware → authorize accepts (null)', async () => {
    const endpoint = wsOnly(compile(withMiddleware(passthrough, ws())))[0]!;
    expect(await endpoint.authorize(request())).toBeNull();
  });

  test('short-circuiting middleware → authorize returns the rejection response', async () => {
    const block: Middleware = () => complete(Status.Unauthorized, 'denied');
    const endpoint = wsOnly(compile(withMiddleware(block, ws())))[0]!;
    const response = await endpoint.authorize(request());
    expect(response).not.toBeNull();
    expect(response!.status).toBe(Status.Unauthorized);
  });

  test('middleware throwing HttpError → authorize returns that status + message', async () => {
    const bad: Middleware = () => { throw new HttpError(Status.Forbidden, 'nope', { reason: 'x' }); };
    const endpoint = wsOnly(compile(withMiddleware(bad, ws())))[0]!;
    const response = await endpoint.authorize(request());
    expect(response!.status).toBe(Status.Forbidden);
    expect(response!.body).toEqual({ error: 'nope', reason: 'x' });
  });

  test('middleware sees the upgrade request (can reject on a missing header)', async () => {
    const requireToken: Middleware = (r, next) =>
      r.headers['authorization'] ? next() : complete(Status.Unauthorized, 'no token');
    const endpoint = wsOnly(compile(withMiddleware(requireToken, path('ws', ws()))))[0]!;
    expect(await endpoint.authorize(request())).not.toBeNull();
    expect(await endpoint.authorize(request({ headers: { authorization: 'Bearer t' } }))).toBeNull();
  });

  test('nested middleware: outer passes, inner blocks → reject', async () => {
    const block: Middleware = () => complete(Status.Forbidden, 'inner-deny');
    const endpoint = wsOnly(compile(withMiddleware(passthrough, withMiddleware(block, ws()))))[0]!;
    expect((await endpoint.authorize(request()))!.status).toBe(Status.Forbidden);
  });

  test('nested middleware: both pass → accept', async () => {
    const endpoint = wsOnly(compile(withMiddleware(passthrough, withMiddleware(passthrough, ws()))))[0]!;
    expect(await endpoint.authorize(request())).toBeNull();
  });
});

/**
 * The third middleware category — one that neither passes `next()`'s result
 * through nor short-circuits, but *decorates* it.  Every response-decorating
 * middleware the framework ships returns `{ ...response, headers: merged }`,
 * which is a fresh object, so the reference-identity check that used to
 * decide acceptance read every one of them as a rejection and refused every
 * upgrade underneath them (#757).
 */
describe('compile — a decorating middleware above a ws route accepts the upgrade (#757)', () => {
  const csrfOptions = CsrfOptions.create().withSecret('a-32-byte-test-secret-value-0123');

  /** The five shipped middlewares that call `next()` and return a copy of the result. */
  const decorators: ReadonlyArray<readonly [string, Middleware]> = [
    ['securityHeaders', securityHeaders()],
    ['contentSecurityPolicy', contentSecurityPolicy()],
    ['strictTransportSecurity', strictTransportSecurity()],
    ['requestId', requestId()],
    ['csrfProtection', csrfProtection(csrfOptions)],
  ];

  for (const [name, decorator] of decorators) {
    test(`${name}() above websocket() → authorize accepts (null)`, async () => {
      const endpoint = wsOnly(compile(withMiddleware(decorator, path('ws', ws()))))[0]!;
      expect(await endpoint.authorize(request())).toBeNull();
    });
  }

  test('all five stacked → still accepts', async () => {
    const stacked = decorators.reduce<Route>(
      (child, [, decorator]) => withMiddleware(decorator, child),
      path('ws', ws()),
    );
    const endpoint = wsOnly(compile(stacked))[0]!;
    expect(await endpoint.authorize(request())).toBeNull();
  });

  test('a decorator outside a rejecting auth middleware still rejects, and decorates the rejection', async () => {
    const deny: Middleware = () => complete(Status.Unauthorized, 'denied');
    const endpoint = wsOnly(compile(withMiddleware(securityHeaders(), withMiddleware(deny, ws()))))[0]!;
    const response = await endpoint.authorize(request());
    expect(response).not.toBeNull();
    expect(response!.status).toBe(Status.Unauthorized);
    expect(response!.headers?.['x-content-type-options']).toBe('nosniff');
  });

  test('a decorator outside the route-level Origin gate still rejects', async () => {
    const gated: Route = {
      kind: 'websocket',
      connect: noopConnect,
      resolvePolicy: () => DEFAULT_WEBSOCKET_POLICY,
      authorize: () => complete(Status.Forbidden, 'origin not allowed'),
    };
    const endpoint = wsOnly(compile(withMiddleware(securityHeaders(), gated)))[0]!;
    expect((await endpoint.authorize(request()))!.status).toBe(Status.Forbidden);
  });

  test('Object.assign onto a fresh object carries the mark → accept', async () => {
    const assigning: Middleware = async (_request, next) =>
      Object.assign({}, await next(), { headers: { 'x-probe': '1' } });
    const endpoint = wsOnly(compile(withMiddleware(assigning, ws())))[0]!;
    expect(await endpoint.authorize(request())).toBeNull();
  });
});

/**
 * The negative half: the structural check must not degenerate into
 * "accept anything".  Each case below is a response the fold has to keep
 * treating as the middleware answering the request itself.
 */
describe('compile — what still counts as a rejected upgrade (#757)', () => {
  test('a middleware that replaces the response entirely → reject', async () => {
    const replacing: Middleware = async (_request, next) => {
      await next();
      return complete(Status.OK, 'answered by the middleware');
    };
    const endpoint = wsOnly(compile(withMiddleware(replacing, ws())))[0]!;
    const response = await endpoint.authorize(request());
    expect(response).not.toBeNull();
    expect(response!.status).toBe(Status.OK);
  });

  test('a hand-built 101 is not an accept — the status alone cannot forge one', async () => {
    const forging: Middleware = async (_request, next) => {
      await next();
      const fabricated: HttpResponse = { status: 101, body: null };
      return fabricated;
    };
    const endpoint = wsOnly(compile(withMiddleware(forging, ws())))[0]!;
    const response = await endpoint.authorize(request());
    expect(response).not.toBeNull();
    expect(response!.status).toBe(101);
  });

  test('spreading the sentinel but overriding the status → reject with that status', async () => {
    const rewriting: Middleware = async (_request, next) => ({ ...(await next()), status: Status.NoContent });
    const endpoint = wsOnly(compile(withMiddleware(rewriting, ws())))[0]!;
    const response = await endpoint.authorize(request());
    expect(response).not.toBeNull();
    expect(response!.status).toBe(Status.NoContent);
  });

  test('a middleware that rebuilds the response through structuredClone → reject', async () => {
    // structuredClone drops symbol-keyed properties, so the mark does not
    // survive — which is the right reading: a response reconstituted from
    // its serialisable parts is a new response, not the sentinel.
    const cloning: Middleware = async (_request, next) => structuredClone(await next());
    const endpoint = wsOnly(compile(withMiddleware(cloning, ws())))[0]!;
    expect(await endpoint.authorize(request())).not.toBeNull();
  });
});
