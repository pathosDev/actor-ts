import { describe, expect, test } from 'bun:test';
import {
  complete,
  completeJson,
  completeText,
  compile,
  concat,
  del,
  get,
  path,
  post,
  put,
  queryParam,
  pathParam,
  redirect,
  reject,
} from '../../../src/http/Route.js';
import { HttpError, Status } from '../../../src/http/types.js';
import type { HttpRequest } from '../../../src/http/types.js';

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
});
