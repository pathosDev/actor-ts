import { describe, expect, test } from 'bun:test';
import {
  complete,
  completeJson,
  completeText,
  compile,
  concat,
  del,
  get,
  head,
  options,
  patch,
  path,
  pathPrefix,
  post,
  put,
  queryParam,
  pathParam,
  redirect,
  reject,
  withMiddleware,
  type CompiledEndpoint,
  type CompiledRoute,
  type Middleware,
} from '../../../src/http/Route.js';
import { HttpError, Status } from '../../../src/http/types.js';
import type { HttpRequest } from '../../../src/http/types.js';

/** Narrow a compiled endpoint list to the HTTP routes (asserts none are WS). */
function httpOnly(endpoints: CompiledEndpoint[]): CompiledRoute[] {
  return endpoints.map((e) => {
    if (e.kind !== 'http') throw new Error(`expected an http route, got ${e.kind}`);
    return e;
  });
}

const emptyRequest: HttpRequest = {
  method: 'GET',
  path: '/',
  headers: {},
  query: {},
  params: {},
  body: null,
};

describe('compile — basic flattening', () => {
  test('a single terminal route at root', () => {
    const routes = compile(get(() => complete(Status.OK, 'hi')));
    expect(routes).toHaveLength(1);
    expect(routes[0]!.method).toBe('GET');
    expect(routes[0]!.pattern).toBe('/');
  });

  test('path() prefixes segments', () => {
    const routes = compile(
      path('users', get(() => complete(Status.OK, 'list'))),
    );
    expect(routes[0]!.pattern).toBe('/users');
  });

  test('nested path segments combine', () => {
    const routes = compile(
      path('api', path('v1', path('users', get(() => complete(Status.OK, '[]'))))),
    );
    expect(routes[0]!.pattern).toBe('/api/v1/users');
  });

  test('concat flattens sibling routes', () => {
    const routes = compile(concat(
      get(() => complete(Status.OK, 'g')),
      post(() => complete(Status.Created, 'p')),
      put(() => complete(Status.OK, 'u')),
      del(() => complete(Status.NoContent, '')),
    ));
    expect(routes.map(response => response.method).sort())
      .toEqual(['DELETE', 'GET', 'POST', 'PUT']);
    for (const response of routes) expect(response.pattern).toBe('/');
  });

  test('path with pattern placeholder retains segment verbatim', () => {
    const routes = compile(path('users/:id', get(() => complete(Status.OK, 'x'))));
    expect(routes[0]!.pattern).toBe('/users/:id');
  });

  test('concat under a path applies to each sibling', () => {
    const routes = compile(path('users', concat(
      get(() => complete(Status.OK, 'list')),
      post(() => complete(Status.Created, 'new')),
      path(':id', concat(
        get(() => complete(Status.OK, 'one')),
        del(() => complete(Status.NoContent, '')),
      )),
    )));
    expect(new Set(routes.map(response => `${response.method} ${response.pattern}`)))
      .toEqual(new Set([
        'GET /users',
        'POST /users',
        'GET /users/:id',
        'DELETE /users/:id',
      ]));
  });
});

describe('complete helpers', () => {
  test('complete() emits plain body', () => {
    expect(complete(Status.OK, 'hi')).toEqual({ status: 200, body: 'hi', headers: undefined });
  });

  test('completeJson sets application/json', () => {
    const response = completeJson(Status.OK, { routeA: 1 });
    expect(response.contentType).toContain('application/json');
    expect(response.body).toEqual({ routeA: 1 });
  });

  test('completeText sets text/plain', () => {
    const response = completeText(Status.OK, 'hello');
    expect(response.contentType).toContain('text/plain');
    expect(response.body).toBe('hello');
  });

  test('redirect sets location and default status', () => {
    const response = redirect('/foo');
    expect(response.headers?.location).toBe('/foo');
    expect(response.status).toBe(Status.Found);
  });

  test('reject throws HttpError', () => {
    expect(() => reject(Status.BadRequest, 'nope')).toThrow(HttpError);
  });
});

describe('param extraction', () => {
  test('queryParam returns undefined for missing keys', () => {
    expect(queryParam(emptyRequest, 'x')).toBeUndefined();
  });

  test('queryParam returns first array element', () => {
    const request = { ...emptyRequest, query: { x: ['a', 'b'] as string[] } };
    expect(queryParam(request as HttpRequest, 'x')).toBe('a');
  });

  test('queryParam returns string value directly', () => {
    const request = { ...emptyRequest, query: { x: 'y' } };
    expect(queryParam(request as HttpRequest, 'x')).toBe('y');
  });

  test('pathParam returns present value', () => {
    const request = { ...emptyRequest, params: { id: '42' } };
    expect(pathParam(request as HttpRequest, 'id')).toBe('42');
  });

  test('pathParam throws on missing key', () => {
    expect(() => pathParam(emptyRequest, 'id')).toThrow(HttpError);
  });
});

describe('compile — segment normalisation', () => {
  test('leading / trailing slashes are stripped from segments', () => {
    const routes = compile(path('/users/', get(() => complete(Status.OK, ''))));
    expect(routes[0]!.pattern).toBe('/users');
  });

  test('multiple segments with slashes flatten correctly', () => {
    const routes = compile(path('a/b', path('c/d', get(() => complete(Status.OK, '')))));
    expect(routes[0]!.pattern).toBe('/a/b/c/d');
  });

  test('empty path segment collapses to root', () => {
    // path('') is degenerate but legal — the normalisation strips it
    // and `buildPattern([''])` ends up with an empty cleaned list →
    // '/'.  Pin this so a future refactor doesn't emit '//' instead.
    const routes = compile(path('', get(() => complete(Status.OK, ''))));
    expect(routes[0]!.pattern).toBe('/');
  });

  test('pathPrefix behaves identically to path (same impl)', () => {
    // pathPrefix is shipped as a synonym today — pin the equivalence
    // explicitly so a future divergence shows up here first.
    const routeA = compile(path('api', get(() => complete(Status.OK, ''))));
    const routeB = compile(pathPrefix('api', get(() => complete(Status.OK, ''))));
    expect(routeB[0]!.pattern).toBe(routeA[0]!.pattern);
  });
});

describe('method combinators — patch / head / options', () => {
  test('patch creates a PATCH route', () => {
    const response = compile(patch(() => complete(Status.OK, '')));
    expect(response[0]!.method).toBe('PATCH');
  });

  test('head creates a HEAD route', () => {
    const response = compile(head(() => complete(Status.OK, '')));
    expect(response[0]!.method).toBe('HEAD');
  });

  test('options creates an OPTIONS route', () => {
    const response = compile(options(() => complete(Status.OK, '')));
    expect(response[0]!.method).toBe('OPTIONS');
  });
});

describe('complete helpers — defaults + edge cases', () => {
  test('complete() with no body returns body=null', () => {
    expect(complete(Status.NoContent)).toEqual({
      status: Status.NoContent, body: null, headers: undefined,
    });
  });

  test('redirect with custom status overrides the default', () => {
    const response = redirect('/x', Status.MovedPermanently);
    expect(response.status).toBe(Status.MovedPermanently);
    expect(response.headers?.location).toBe('/x');
  });

  test('reject carries the extra payload on the HttpError', () => {
    try {
      reject(Status.BadRequest, 'bad', { field: 'name' });
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      const err = e as HttpError;
      expect(err.status).toBe(Status.BadRequest);
      expect(err.message).toBe('bad');
      // The `extra` arg is preserved on the error for the global handler.
      expect((err as unknown as { extra?: unknown }).extra).toEqual({ field: 'name' });
    }
  });
});

describe('param extraction — edge cases', () => {
  test('queryParam returns undefined for an empty array value', () => {
    // Most servers don't produce `[]` for a query key, but the typing
    // allows it.  `[0]` on an empty array is undefined — pin that.
    const request = { ...emptyRequest, query: { x: [] as string[] } };
    expect(queryParam(request as HttpRequest, 'x')).toBeUndefined();
  });

  test('pathParam HttpError carries status 500 for missing key', () => {
    try { pathParam(emptyRequest, 'id'); }
    catch (e) {
      const err = e as HttpError;
      expect(err.status).toBe(500);
      expect(err.message).toContain('id');
    }
  });
});

describe('compile — withMiddleware (#312)', () => {
  const passthrough: Middleware = (_request, next) => next();
  const block: Middleware = () => complete(Status.Unauthorized, 'denied');

  test('middleware wraps the single child handler', async () => {
    const response = httpOnly(compile(
      withMiddleware(passthrough, get(() => complete(Status.OK, 'ok'))),
    ));
    expect(response).toHaveLength(1);
    const handlerResponse = await response[0]!.handler(emptyRequest);
    expect(handlerResponse.status).toBe(Status.OK);
    expect(handlerResponse.body).toBe('ok');
  });

  test('middleware can short-circuit before the handler runs', async () => {
    let handlerCalled = false;
    const response = httpOnly(compile(
      withMiddleware(block, get(() => {
        handlerCalled = true;
        return complete(Status.OK, 'should not reach');
      })),
    ));
    const handlerResponse = await response[0]!.handler(emptyRequest);
    expect(handlerResponse.status).toBe(Status.Unauthorized);
    expect(handlerCalled).toBe(false);
  });

  test('nested middlewares run outside-in', async () => {
    const order: string[] = [];
    const routeA: Middleware = async (_request, next) => {
      order.push('a-in');
      const response = await next();
      order.push('a-out');
      return response;
    };
    const routeB: Middleware = async (_request, next) => {
      order.push('b-in');
      const response = await next();
      order.push('b-out');
      return response;
    };
    const route = withMiddleware(routeA, withMiddleware(routeB, get(() => {
      order.push('h');
      return complete(Status.OK, '');
    })));
    const response = httpOnly(compile(route));
    await response[0]!.handler(emptyRequest);
    expect(order).toEqual(['a-in', 'b-in', 'h', 'b-out', 'a-out']);
  });

  test('middleware applies to every terminal in the subtree, not siblings', async () => {
    let aCalls = 0;
    const counter: Middleware = (_request, next) => { aCalls++; return next(); };
    const route = concat(
      withMiddleware(counter, path('protected', get(() => complete(Status.OK, 'p')))),
      path('open', get(() => complete(Status.OK, 'o'))),
    );
    const compiled = httpOnly(compile(route));
    expect(compiled).toHaveLength(2);
    const protectedR = compiled.find((c) => c.pattern === '/protected')!;
    const openR = compiled.find((c) => c.pattern === '/open')!;
    await protectedR.handler(emptyRequest);
    expect(aCalls).toBe(1);
    await openR.handler(emptyRequest);
    expect(aCalls).toBe(1);  // sibling not wrapped
  });

  test('middleware errors propagate as HttpError to the caller', async () => {
    const bad: Middleware = () => { throw new HttpError(Status.Forbidden, 'no'); };
    const response = httpOnly(compile(withMiddleware(bad, get(() => complete(Status.OK, '')))));
    await expect(response[0]!.handler(emptyRequest)).rejects.toThrow(HttpError);
  });
});
