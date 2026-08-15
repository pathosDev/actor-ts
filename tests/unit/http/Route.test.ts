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
  redirectExternal,
  reject,
  withMiddleware,
  type CompiledEndpoint,
  type CompiledRoute,
  type Middleware,
} from '../../../src/http/Route.js';
import { HttpError, Status } from '../../../src/http/Types.js';
import type { HttpRequest } from '../../../src/http/Types.js';

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
    const routes = httpOnly(compile(get(() => complete(Status.OK, 'hi'))));
    expect(routes).toHaveLength(1);
    expect(routes[0]!.method).toBe('GET');
    expect(routes[0]!.pattern).toBe('/');
  });

  test('path() prefixes segments', () => {
    const routes = httpOnly(compile(
      path('users', get(() => complete(Status.OK, 'list'))),
    ));
    expect(routes[0]!.pattern).toBe('/users');
  });

  test('nested path segments combine', () => {
    const routes = httpOnly(compile(
      path('api', path('v1', path('users', get(() => complete(Status.OK, '[]'))))),
    ));
    expect(routes[0]!.pattern).toBe('/api/v1/users');
  });

  test('concat flattens sibling routes', () => {
    const routes = httpOnly(compile(concat(
      get(() => complete(Status.OK, 'g')),
      post(() => complete(Status.Created, 'p')),
      put(() => complete(Status.OK, 'u')),
      del(() => complete(Status.NoContent, '')),
    )));
    expect(routes.map(response => response.method).sort())
      .toEqual(['DELETE', 'GET', 'POST', 'PUT']);
    for (const response of routes) expect(response.pattern).toBe('/');
  });

  test('path with pattern placeholder retains segment verbatim', () => {
    const routes = httpOnly(compile(path('users/:id', get(() => complete(Status.OK, 'x')))));
    expect(routes[0]!.pattern).toBe('/users/:id');
  });

  test('concat under a path applies to each sibling', () => {
    const routes = httpOnly(compile(path('users', concat(
      get(() => complete(Status.OK, 'list')),
      post(() => complete(Status.Created, 'new')),
      path(':id', concat(
        get(() => complete(Status.OK, 'one')),
        del(() => complete(Status.NoContent, '')),
      )),
    ))));
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
    const routes = httpOnly(compile(path('/users/', get(() => complete(Status.OK, '')))));
    expect(routes[0]!.pattern).toBe('/users');
  });

  test('multiple segments with slashes flatten correctly', () => {
    const routes = httpOnly(compile(path('a/b', path('c/d', get(() => complete(Status.OK, ''))))));
    expect(routes[0]!.pattern).toBe('/a/b/c/d');
  });

  test('empty path segment collapses to root', () => {
    // path('') is degenerate but legal — the normalisation strips it
    // and `buildPattern([''])` ends up with an empty cleaned list →
    // '/'.  Pin this so a future refactor doesn't emit '//' instead.
    const routes = httpOnly(compile(path('', get(() => complete(Status.OK, '')))));
    expect(routes[0]!.pattern).toBe('/');
  });

  test('pathPrefix behaves identically to path (same impl)', () => {
    // pathPrefix is shipped as a synonym today — pin the equivalence
    // explicitly so a future divergence shows up here first.
    const routeA = httpOnly(compile(path('api', get(() => complete(Status.OK, '')))));
    const routeB = httpOnly(compile(pathPrefix('api', get(() => complete(Status.OK, '')))));
    expect(routeB[0]!.pattern).toBe(routeA[0]!.pattern);
  });
});

describe('method combinators — patch / head / options', () => {
  test('patch creates a PATCH route', () => {
    const response = httpOnly(compile(patch(() => complete(Status.OK, ''))));
    expect(response[0]!.method).toBe('PATCH');
  });

  test('head creates a HEAD route', () => {
    const response = httpOnly(compile(head(() => complete(Status.OK, ''))));
    expect(response[0]!.method).toBe('HEAD');
  });

  test('options creates an OPTIONS route', () => {
    const response = httpOnly(compile(options(() => complete(Status.OK, ''))));
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

describe('redirect — target validation (#125)', () => {
  // Built from code points on purpose: the whole point of these cases is
  // WHICH byte is in the string, and a source-level escape hides that.
  const BACKSLASH = String.fromCharCode(92);
  const TAB = String.fromCharCode(9);
  const CARRIAGE_RETURN = String.fromCharCode(13);
  const LINE_FEED = String.fromCharCode(10);
  const DELETE_CHARACTER = String.fromCharCode(127);

  /** Run `call` and return the HttpError it must have thrown. */
  function thrownError(call: () => unknown): HttpError {
    try {
      call();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      return e as HttpError;
    }
    throw new Error('expected the redirect target to be rejected, but it was accepted');
  }

  test.each([
    ['absolute path', '/dashboard'],
    ['path with query', '/search?q=1&page=2'],
    ['query only', '?q=1'],
    ['fragment only', '#top'],
    ['relative path', 'dashboard/settings'],
    ['parent-relative path', '../up'],
    ['dot-relative path', './sibling'],
    ['colon after a slash is not a scheme', '/notes/10:30'],
    ['single leading backslash reads as a path', `${BACKSLASH}dashboard`],
    ['empty target means "this URL"', ''],
  ])('accepts a same-origin target — %s', (_label, target) => {
    const response = redirect(target);
    expect(response.status).toBe(Status.Found);
    // Emitted verbatim: normalisation is only used to classify.
    expect(response.headers?.location).toBe(target);
  });

  test.each([
    ['https URL', 'https://evil.example/phish'],
    ['http URL', 'http://evil.example'],
    ['uppercase scheme', 'HTTPS://evil.example'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,<h1>hi</h1>'],
    ['file scheme', 'file:///etc/passwd'],
    ['scheme-only relative reference', 'evil:'],
    ['leading space before the scheme', '  https://evil.example'],
  ])('rejects an absolute target — %s', (_label, target) => {
    const err = thrownError(() => redirect(target));
    expect(err.status).toBe(Status.BadRequest);
    expect(err.message).toContain('absolute URL');
    expect(err.message).toContain('redirectExternal');
  });

  test.each([
    ['protocol-relative', '//evil.example/phish'],
    ['slash then backslash', `/${BACKSLASH}evil.example`],
    ['backslash then slash', `${BACKSLASH}/evil.example`],
    ['two backslashes', `${BACKSLASH}${BACKSLASH}evil.example`],
    ['leading space then protocol-relative', ' //evil.example'],
  ])('rejects a protocol-relative target — %s', (_label, target) => {
    // Browsers normalise a backslash to a slash before parsing, so every
    // one of these lands on `evil.example` as the host.
    const err = thrownError(() => redirect(target));
    expect(err.status).toBe(Status.BadRequest);
    expect(err.message).toContain('protocol-relative');
    expect(err.message).toContain('redirectExternal');
  });

  test.each([
    ['CRLF header injection', `/foo${CARRIAGE_RETURN}${LINE_FEED}Set-Cookie: session=stolen`],
    ['bare line feed', `/foo${LINE_FEED}X-Evil: 1`],
    ['NUL', `/foo${String.fromCharCode(0)}`],
    ['DELETE', `/foo${DELETE_CHARACTER}`],
  ])('rejects a control character in the target — %s', (_label, target) => {
    const err = thrownError(() => redirect(target));
    expect(err.status).toBe(Status.BadRequest);
    expect(err.message).toContain('control characters');
  });

  test('rejects a scheme that hides a TAB — the case the runtimes let through', () => {
    // Measured on Bun and Node: CR/LF/NUL are refused at header-write
    // time, but a TAB is accepted by both `fetch` Headers and Node's
    // `setHeader`.  Browsers strip it before parsing, so this reaches the
    // browser as a working `javascript:` scheme — and the scheme check
    // alone never matches it, because it searches the raw string.
    const err = thrownError(() => redirect(`java${TAB}script:alert(1)`));
    expect(err.status).toBe(Status.BadRequest);
    expect(err.message).toContain('control characters');
  });

  test('the rejection never echoes the target back to the client', () => {
    // The attacker supplies the target; reflecting it into the response
    // body would reintroduce the class of bug this check exists to stop.
    const err = thrownError(() => redirect('https://evil.example/phish'));
    expect(err.message).not.toContain('evil.example');
    expect(err.extra).toBeUndefined();
  });

  test('the open-redirect exploit path returns 400, not 302', async () => {
    // The textbook shape: a login handler forwards `?next=` verbatim.
    const login = get((request) => redirect(queryParam(request, 'next') ?? '/'));
    const compiled = httpOnly(compile(login));
    const attack: HttpRequest = { ...emptyRequest, query: { next: 'https://evil.example/phish' } };
    // A plain terminal's handler is registered unwrapped, so a synchronous
    // handler throws synchronously — the backend's error mapping turns the
    // HttpError into the 400 either way.
    expect(() => compiled[0]!.handler(attack)).toThrow(HttpError);

    const benign: HttpRequest = { ...emptyRequest, query: { next: '/dashboard' } };
    const response = await compiled[0]!.handler(benign);
    expect(response.status).toBe(Status.Found);
    expect(response.headers?.location).toBe('/dashboard');
  });

  test('a custom status still applies to a validated target', () => {
    const response = redirect('/new-home', Status.MovedPermanently);
    expect(response.status).toBe(Status.MovedPermanently);
    expect(response.headers?.location).toBe('/new-home');
  });
});

describe('redirectExternal — the audited off-origin opt-in (#125)', () => {
  const CARRIAGE_RETURN = String.fromCharCode(13);
  const LINE_FEED = String.fromCharCode(10);
  const TAB = String.fromCharCode(9);

  test.each([
    ['https URL', 'https://payments.example/checkout'],
    ['protocol-relative', '//cdn.example/asset'],
    ['same-origin target still works', '/dashboard'],
  ])('accepts an off-origin target — %s', (_label, target) => {
    const response = redirectExternal(target);
    expect(response.status).toBe(Status.Found);
    expect(response.headers?.location).toBe(target);
    expect(response.body).toBeNull();
  });

  test('honours a custom status', () => {
    const response = redirectExternal('https://payments.example/checkout', Status.MovedPermanently);
    expect(response.status).toBe(Status.MovedPermanently);
  });

  test.each([
    ['CRLF header injection', `https://ok.example${CARRIAGE_RETURN}${LINE_FEED}Set-Cookie: session=stolen`],
    ['TAB inside the scheme', `java${TAB}script:alert(1)`],
  ])('still rejects a control character — %s', (_label, target) => {
    // Leaving the origin is a decision the caller gets to make; splitting
    // the response header is not.
    expect(() => redirectExternal(target)).toThrow(HttpError);
  });
});
