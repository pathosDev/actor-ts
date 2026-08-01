import { describe, expect, test } from 'bun:test';
import {
  compile,
  complete,
  get,
  handleErrors,
  withMiddleware,
  type CompiledRoute,
  type Middleware,
  type Route,
} from '../../../src/http/Route.js';
import { HttpError, Status, type HttpRequest } from '../../../src/http/types.js';

const request: HttpRequest = {
  method: 'GET',
  path: '/',
  headers: {},
  query: {},
  params: {},
  body: null,
};

/** Compile a route expected to reduce to exactly one HTTP endpoint. */
function oneHttp(route: Route): CompiledRoute {
  const compiled = compile(route);
  expect(compiled).toHaveLength(1);
  const endpoint = compiled[0]!;
  if (endpoint.kind !== 'http') throw new Error(`expected an http route, got ${endpoint.kind}`);
  return endpoint;
}

describe('handleErrors', () => {
  test('receives the original thrown HttpError instance, before any mapping', async () => {
    const thrown = new HttpError(Status.Conflict, 'boom', { detail: 'x' });
    let seen: unknown;
    const route = oneHttp(handleErrors(
      (err) => { seen = err; return complete(Status.OK, 'recovered'); },
      get(() => { throw thrown; }),
    ));
    const response = await route.handler(request);
    expect(seen).toBe(thrown); // same instance, not a mapped {error} body
    expect(response.status).toBe(Status.OK);
    expect(response.body).toBe('recovered');
  });

  test('a returned response wins over the default error mapping', async () => {
    const route = oneHttp(handleErrors(
      () => complete(Status.BadGateway, 'mapped'),
      get(() => { throw new HttpError(Status.InternalServerError, 'x'); }),
    ));
    expect((await route.handler(request)).status).toBe(Status.BadGateway);
  });

  test('returning null declines → the error propagates (rejects)', async () => {
    const route = oneHttp(handleErrors(
      () => null,
      get(() => { throw new HttpError(Status.NotFound, 'nope'); }),
    ));
    await expect(route.handler(request)).rejects.toThrow(HttpError);
  });

  test('nested: inner declines, outer handles', async () => {
    const route = handleErrors(
      (err) => (err as HttpError).status === Status.Forbidden ? complete(Status.OK, 'outer') : null,
      handleErrors(
        () => null, // inner always declines
        get(() => { throw new HttpError(Status.Forbidden, 'x'); }),
      ),
    );
    expect((await oneHttp(route).handler(request)).body).toBe('outer');
  });

  test('nested: inner handles first (innermost wins)', async () => {
    const route = handleErrors(
      () => complete(Status.OK, 'outer'),
      handleErrors(
        () => complete(Status.Accepted, 'inner'),
        get(() => { throw new HttpError(Status.InternalServerError, 'x'); }),
      ),
    );
    const response = await oneHttp(route).handler(request);
    expect(response.status).toBe(Status.Accepted);
    expect(response.body).toBe('inner');
  });

  test('catches a throw from an inner middleware (e.g. an auth 401)', async () => {
    const auth: Middleware = () => { throw new HttpError(Status.Unauthorized, 'denied'); };
    const route = handleErrors(
      (err) => complete((err as HttpError).status, 'handled'),
      withMiddleware(auth, get(() => complete(Status.OK, 'never'))),
    );
    const response = await oneHttp(route).handler(request);
    expect(response.status).toBe(Status.Unauthorized);
    expect(response.body).toBe('handled');
  });

  test('a throw from the exception handler itself propagates', async () => {
    const boom = new Error('handler blew up');
    const route = oneHttp(handleErrors(
      () => { throw boom; },
      get(() => { throw new HttpError(Status.BadRequest, 'x'); }),
    ));
    await expect(route.handler(request)).rejects.toBe(boom);
  });

  test('a non-Error throw arrives unmangled as unknown', async () => {
    let seen: unknown = 'unset';
    const route = oneHttp(handleErrors(
      (err) => { seen = err; return complete(Status.OK, ''); },
      get(() => { throw 'string-error'; }),
    ));
    await route.handler(request);
    expect(seen).toBe('string-error');
  });

  test('does not fire when nothing throws', async () => {
    let called = false;
    const route = oneHttp(handleErrors(
      () => { called = true; return complete(Status.OK, 'x'); },
      get(() => complete(Status.OK, 'fine')),
    ));
    const response = await route.handler(request);
    expect(called).toBe(false);
    expect(response.body).toBe('fine');
  });

  test('a throwing middleware over a websocket route rejects the upgrade', async () => {
    // The websocket authorize fold maps a thrown HttpError to a rejection
    // response via defaultErrorResponse — pins that refactor.
    const wsLiteral: Route = { kind: 'websocket', connect: () => {} };
    const compiled = compile(withMiddleware(
      () => { throw new HttpError(Status.Unauthorized, 'nope'); },
      wsLiteral,
    ));
    const ws = compiled[0]!;
    if (ws.kind !== 'websocket') throw new Error('expected a websocket route');
    const response = await ws.authorize(request);
    expect(response?.status).toBe(Status.Unauthorized);
  });
});
