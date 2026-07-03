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

const emptyReq: HttpRequest = {
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
    expect(routes.map(r => r.method).sort())
      .toEqual(['DELETE', 'GET', 'POST', 'PUT']);
    for (const r of routes) expect(r.pattern).toBe('/');
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
    expect(new Set(routes.map(r => `${r.method} ${r.pattern}`)))
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
    const r = completeJson(Status.OK, { a: 1 });
    expect(r.contentType).toContain('application/json');
    expect(r.body).toEqual({ a: 1 });
  });

  test('completeText sets text/plain', () => {
    const r = completeText(Status.OK, 'hello');
    expect(r.contentType).toContain('text/plain');
    expect(r.body).toBe('hello');
  });

  test('redirect sets location and default status', () => {
    const r = redirect('/foo');
    expect(r.headers?.location).toBe('/foo');
    expect(r.status).toBe(Status.Found);
  });

  test('reject throws HttpError', () => {
    expect(() => reject(Status.BadRequest, 'nope')).toThrow(HttpError);
  });
});

describe('param extraction', () => {
  test('queryParam returns undefined for missing keys', () => {
    expect(queryParam(emptyReq, 'x')).toBeUndefined();
  });

  test('queryParam returns first array element', () => {
    const req = { ...emptyReq, query: { x: ['a', 'b'] as string[] } };
    expect(queryParam(req as HttpRequest, 'x')).toBe('a');
  });

  test('queryParam returns string value directly', () => {
    const req = { ...emptyReq, query: { x: 'y' } };
    expect(queryParam(req as HttpRequest, 'x')).toBe('y');
  });

  test('pathParam returns present value', () => {
    const req = { ...emptyReq, params: { id: '42' } };
    expect(pathParam(req as HttpRequest, 'id')).toBe('42');
  });

  test('pathParam throws on missing key', () => {
    expect(() => pathParam(emptyReq, 'id')).toThrow(HttpError);
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
    const a = compile(path('api', get(() => complete(Status.OK, ''))));
    const b = compile(pathPrefix('api', get(() => complete(Status.OK, ''))));
    expect(b[0]!.pattern).toBe(a[0]!.pattern);
  });
});

describe('method combinators — patch / head / options', () => {
  test('patch creates a PATCH route', () => {
    const r = compile(patch(() => complete(Status.OK, '')));
    expect(r[0]!.method).toBe('PATCH');
  });

  test('head creates a HEAD route', () => {
    const r = compile(head(() => complete(Status.OK, '')));
    expect(r[0]!.method).toBe('HEAD');
  });

  test('options creates an OPTIONS route', () => {
    const r = compile(options(() => complete(Status.OK, '')));
    expect(r[0]!.method).toBe('OPTIONS');
  });
});

describe('complete helpers — defaults + edge cases', () => {
  test('complete() with no body returns body=null', () => {
    expect(complete(Status.NoContent)).toEqual({
      status: Status.NoContent, body: null, headers: undefined,
    });
  });

  test('redirect with custom status overrides the default', () => {
    const r = redirect('/x', Status.MovedPermanently);
    expect(r.status).toBe(Status.MovedPermanently);
    expect(r.headers?.location).toBe('/x');
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
    const req = { ...emptyReq, query: { x: [] as string[] } };
    expect(queryParam(req as HttpRequest, 'x')).toBeUndefined();
  });

  test('pathParam HttpError carries status 500 for missing key', () => {
    try { pathParam(emptyReq, 'id'); }
    catch (e) {
      const err = e as HttpError;
      expect(err.status).toBe(500);
      expect(err.message).toContain('id');
    }
  });
});

describe('compile — withMiddleware (#312)', () => {
  const passthrough: Middleware = (_req, next) => next();
  const block: Middleware = () => complete(Status.Unauthorized, 'denied');

  test('middleware wraps the single child handler', async () => {
    const r = httpOnly(compile(
      withMiddleware(passthrough, get(() => complete(Status.OK, 'ok'))),
    ));
    expect(r).toHaveLength(1);
    const resp = await r[0]!.handler(emptyReq);
    expect(resp.status).toBe(Status.OK);
    expect(resp.body).toBe('ok');
  });

  test('middleware can short-circuit before the handler runs', async () => {
    let handlerCalled = false;
    const r = httpOnly(compile(
      withMiddleware(block, get(() => {
        handlerCalled = true;
        return complete(Status.OK, 'should not reach');
      })),
    ));
    const resp = await r[0]!.handler(emptyReq);
    expect(resp.status).toBe(Status.Unauthorized);
    expect(handlerCalled).toBe(false);
  });

  test('nested middlewares run outside-in', async () => {
    const order: string[] = [];
    const a: Middleware = async (_req, next) => {
      order.push('a-in');
      const r = await next();
      order.push('a-out');
      return r;
    };
    const b: Middleware = async (_req, next) => {
      order.push('b-in');
      const r = await next();
      order.push('b-out');
      return r;
    };
    const route = withMiddleware(a, withMiddleware(b, get(() => {
      order.push('h');
      return complete(Status.OK, '');
    })));
    const r = httpOnly(compile(route));
    await r[0]!.handler(emptyReq);
    expect(order).toEqual(['a-in', 'b-in', 'h', 'b-out', 'a-out']);
  });

  test('middleware applies to every terminal in the subtree, not siblings', async () => {
    let aCalls = 0;
    const counter: Middleware = (_req, next) => { aCalls++; return next(); };
    const route = concat(
      withMiddleware(counter, path('protected', get(() => complete(Status.OK, 'p')))),
      path('open', get(() => complete(Status.OK, 'o'))),
    );
    const compiled = httpOnly(compile(route));
    expect(compiled).toHaveLength(2);
    const protectedR = compiled.find((c) => c.pattern === '/protected')!;
    const openR = compiled.find((c) => c.pattern === '/open')!;
    await protectedR.handler(emptyReq);
    expect(aCalls).toBe(1);
    await openR.handler(emptyReq);
    expect(aCalls).toBe(1);  // sibling not wrapped
  });

  test('middleware errors propagate as HttpError to the caller', async () => {
    const bad: Middleware = () => { throw new HttpError(Status.Forbidden, 'no'); };
    const r = httpOnly(compile(withMiddleware(bad, get(() => complete(Status.OK, '')))));
    await expect(r[0]!.handler(emptyReq)).rejects.toThrow(HttpError);
  });
});
