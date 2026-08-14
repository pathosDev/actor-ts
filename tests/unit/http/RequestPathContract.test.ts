/**
 * `HttpRequest.path` is the bare pathname on EVERY backend — the contract
 * stated on the field in `src/http/types.ts`.
 *
 * Fastify used to hand over `req.url`, the raw request target, so the query
 * string leaked into `path` on the default backend while Express and Hono
 * reported a pathname.  Every consumer that appends to `path` then built a
 * broken target on Fastify only: the static-file directory redirect answered
 * `Location: /static?a=1/`, the DevTools shell redirect `/devtools?x=1/`, and
 * the idempotency fingerprint hashed the query twice.  A single-backend test
 * cannot see that divergence, so this file pins the contract across all three.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { HonoBackend } from '../../../src/http/backend/HonoBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { completeJson, concat, fallback, get, path, type Route } from '../../../src/http/Route.js';
import type { HttpServerBackend, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { Status, type HttpRequest } from '../../../src/http/Types.js';
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
  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('http-request-path-test', systemOptions);
  try {
    const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).useBackend(mk()).bind(routes);
    live.push({ binding, system });
    return `http://${binding.host}:${binding.port}`;
  } catch (e) {
    await system.terminate();
    throw e;
  }
}

/** What the handler saw, as JSON — `path` and `query` in one round trip. */
type SeenRequest = {
  readonly path: string;
  readonly query: Record<string, string | string[] | undefined>;
};

const echo = (request: HttpRequest): ReturnType<typeof completeJson> =>
  completeJson(Status.OK, { path: request.path, query: request.query });

const echoRoutes = (): Route => concat(
  path('orders', get(echo)),
  path('orders', path('42', get(echo))),
  fallback(echo),
);

async function seen(url: string, target: string): Promise<SeenRequest> {
  const response = await fetch(`${url}${target}`);
  expect(response.status).toBe(200);
  return await response.json() as SeenRequest;
}

describe.each(backends)('HttpRequest.path contract — %s backend', (_name, mk) => {
  test('a query string never reaches path — it is parsed into query', async () => {
    const url = await start(mk, echoRoutes());
    const request = await seen(url, '/orders?page=2&sort=asc');
    expect(request.path).toBe('/orders');
    // Also assert the query really travelled: without this the path
    // assertion would pass just as happily against a request that never
    // carried one.
    expect(request.query).toEqual({ page: '2', sort: 'asc' });
  });

  test('a query-free request is unchanged', async () => {
    const url = await start(mk, echoRoutes());
    const request = await seen(url, '/orders');
    expect(request.path).toBe('/orders');
    expect(request.query).toEqual({});
  });

  test('a nested path keeps every segment and drops only the query', async () => {
    const url = await start(mk, echoRoutes());
    const request = await seen(url, '/orders/42?expand=lines');
    expect(request.path).toBe('/orders/42');
    expect(request.query).toEqual({ expand: 'lines' });
  });

  test('an unmatched path reaches the fallback without its query', async () => {
    const url = await start(mk, echoRoutes());
    const request = await seen(url, '/no/such/route?a=1');
    expect(request.path).toBe('/no/such/route');
    expect(request.query).toEqual({ a: '1' });
  });

  test('a value containing an encoded question mark stays in query, not in path', async () => {
    const url = await start(mk, echoRoutes());
    const request = await seen(url, '/orders?q=a%3Fb');
    expect(request.path).toBe('/orders');
    expect(request.query).toEqual({ q: 'a?b' });
  });

  test('a bare trailing question mark leaves an empty query and a clean path', async () => {
    const url = await start(mk, echoRoutes());
    const request = await seen(url, '/orders?');
    expect(request.path).toBe('/orders');
    expect(request.query).toEqual({});
  });
});
