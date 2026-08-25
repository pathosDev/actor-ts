/**
 * #759 — two routes on the same `method` + `pattern` are refused at bind, and
 * the refusal does not depend on which backend is in use.
 *
 * The reason it is a security test and not a hygiene one: until this landed,
 * only Fastify's router rejected a repeat.  Express and Hono replayed their
 * registrations in insertion order and answered with the first that matched,
 * so the argument order of a `concat(...)` silently decided whether an
 * auth-guarded route or its unguarded twin was the one that served — with no
 * warning on either side of that coin flip.
 *
 * Both layers are pinned here, because they cover different callers.  The
 * `HttpExtension.bind` check answers for every backend including ones written
 * outside this repo — `RecordingBackend` below performs no check of its own,
 * so anything it never sees was refused above it.  The per-backend checks
 * answer for a caller who holds the backend directly, which `useBackend(...)`
 * and `getApp()` both leave possible.
 *
 * The two websocket conflicts are pinned alongside, not because they changed,
 * but because they were the shape this fix was asked to mirror and neither had
 * a test of its own.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { HonoBackend } from '../../../src/http/backend/HonoBackend.js';
import type {
  HttpServerBackend,
  RouteRegistration,
  ServerBinding,
  WebsocketRouteRegistration,
} from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { BearerTokenAuth } from '../../../src/http/middleware/BearerToken.js';
import { complete, concat, get, path, post, withMiddleware, type Route } from '../../../src/http/Route.js';
import { Status } from '../../../src/http/Types.js';
import type { WebsocketServerRef } from '../../../src/http/websocket/WebsocketMessages.js';
import { websocket } from '../../../src/http/websocket/WebsocketRoute.js';
import { WebsocketServerActor } from '../../../src/http/websocket/WebsocketServerActor.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

class SilentServer extends WebsocketServerActor<never, never> {
  onMessage(): void { /* never reached — nothing connects in this suite */ }
}

/**
 * A backend that binds no port and deliberately performs no duplicate check of
 * its own, so every rejection observed through it came from
 * `HttpExtension.bind`.  It also records what it was handed, which is how the
 * "the unguarded twin never reached a router" half is checked.
 */
class RecordingBackend implements HttpServerBackend {
  readonly name = 'recording';
  readonly httpRoutes: RouteRegistration[] = [];
  readonly websocketRoutes: WebsocketRouteRegistration[] = [];

  registerRoute(route: RouteRegistration): void {
    this.httpRoutes.push(route);
  }

  registerWebSocket(registration: WebsocketRouteRegistration): void {
    this.websocketRoutes.push(registration);
  }

  async listen(host: string, port: number): Promise<ServerBinding> {
    return { host, port, unbind: async () => {} };
  }
}

async function withSystem<T>(name: string, body: (system: ActorSystem) => Promise<T>): Promise<T> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  try {
    return await body(system);
  } finally {
    await system.terminate();
  }
}

function bindTo(system: ActorSystem, backend: HttpServerBackend, routes: Route): Promise<ServerBinding> {
  return system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .useBackend(backend)
    .bind(routes);
}

const okHandler = (body: string) => () => complete(Status.OK, body);

describe('HttpExtension.bind — duplicate HTTP method+pattern (#759)', () => {
  test('the same method and pattern declared twice is refused', async () => {
    await withSystem('route-conflicts-duplicate', async (system) => {
      const routes = concat(
        path('admin', get(okHandler('first'))),
        path('admin', get(okHandler('second'))),
      );
      await expect(bindTo(system, new RecordingBackend(), routes))
        .rejects.toThrow('Route conflict: GET /admin is declared more than once');
    });
  });

  test('an unguarded twin never reaches the backend, in either declaration order', async () => {
    await withSystem('route-conflicts-shadowing', async (system) => {
      const bearerAuth = BearerTokenAuth({ tokens: ['s3cret'] });
      const guarded = path('admin', withMiddleware(bearerAuth, get(okHandler('guarded'))));
      const unguarded = path('admin', get(okHandler('UNGUARDED')));

      // Order is the whole point: before #759 one of these two trees served
      // the unguarded handler and the other served a 401, and nothing said
      // which.  Both must now fail identically.
      for (const routes of [concat(guarded, unguarded), concat(unguarded, guarded)]) {
        const backend = new RecordingBackend();
        await expect(bindTo(system, backend, routes))
          .rejects.toThrow('Route conflict: GET /admin');
        expect(backend.httpRoutes).toHaveLength(0);
      }
    });
  });

  test('distinct method+pattern pairs are untouched — the key is both halves', async () => {
    await withSystem('route-conflicts-no-over-reject', async (system) => {
      const backend = new RecordingBackend();
      const routes = concat(
        path('orders', concat(
          get(okHandler('list')),
          post(() => complete(Status.Created, 'created')),
        )),
        path('users', get(okHandler('users'))),
      );
      const binding = await bindTo(system, backend, routes);
      expect(backend.httpRoutes.map((route) => `${route.method} ${route.pattern}`))
        .toEqual(['GET /orders', 'POST /orders', 'GET /users']);
      await binding.unbind();
    });
  });
});

describe('HttpExtension.bind — websocket conflicts (#759 mirrors these)', () => {
  test('two websocket() routes on the same pattern are refused', async () => {
    await withSystem('route-conflicts-duplicate-websocket', async (system) => {
      const server = system.spawn(SilentServer, 'silent') as unknown as WebsocketServerRef<never, never, never>;
      const routes = concat(websocket('ws', server), websocket('ws', server));
      await expect(bindTo(system, new RecordingBackend(), routes))
        .rejects.toThrow('Duplicate websocket() route for pattern "/ws"');
    });
  });

  test('a GET route on a websocket() pattern is refused', async () => {
    await withSystem('route-conflicts-get-versus-websocket', async (system) => {
      const server = system.spawn(SilentServer, 'silent') as unknown as WebsocketServerRef<never, never, never>;
      const routes = concat(websocket('ws', server), path('ws', get(okHandler('plain'))));
      await expect(bindTo(system, new RecordingBackend(), routes))
        .rejects.toThrow('Route conflict: GET /ws collides with a websocket() route on the same path');
    });
  });
});

/**
 * The contract on `HttpServerBackend.registerRoute` is the backend's own, so
 * each shipped backend has to keep it whether or not `HttpExtension` got there
 * first.  Fastify's router would refuse the repeat regardless — the point of
 * pinning it here is that all three now refuse it in the same words, rather
 * than two staying silent and one raising `FST_ERR_DUPLICATED_ROUTE`.
 */
describe('HttpServerBackend.registerRoute — every shipped backend refuses a repeat (#759)', () => {
  const backends: ReadonlyArray<readonly [string, () => HttpServerBackend]> = [
    ['ExpressBackend', () => new ExpressBackend()],
    ['FastifyBackend', () => new FastifyBackend({ logger: false })],
    ['HonoBackend', () => new HonoBackend()],
  ];

  for (const [name, makeBackend] of backends) {
    test(`${name} throws on a repeated method+pattern`, () => {
      const backend = makeBackend();
      backend.registerRoute({ method: 'GET', pattern: '/admin', handler: okHandler('first') });
      expect(() => backend.registerRoute({ method: 'GET', pattern: '/admin', handler: okHandler('second') }))
        .toThrow(`${name}: duplicate GET route for pattern "/admin"`);
    });

    test(`${name} still accepts the same pattern under another method`, () => {
      const backend = makeBackend();
      backend.registerRoute({ method: 'GET', pattern: '/orders', handler: okHandler('list') });
      expect(() => backend.registerRoute({
        method: 'POST',
        pattern: '/orders',
        handler: () => complete(Status.Created, 'created'),
      })).not.toThrow();
    });
  }
});
