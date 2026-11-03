/**
 * #1487 — the request deadline `HttpExtension.bind` hands the backend is the
 * longest on the whole server: the configured
 * `actor-ts.http.request-timeout.deadline`, raised to the longest
 * `requestTimeout()` compiled into *any* endpoint — a `fallback()` and a
 * `websocket()` route as much as an HTTP route.
 *
 * Each of those answers a request the server's whole-connection idle timeout
 * can cut: on the Hono backend under Bun the idle timeout is derived from this
 * deadline, so a fallback or an upgrade route whose `requestTimeout()` is
 * longer than every HTTP route's would be cut before its `503` if only HTTP
 * routes counted.  The end-to-end half — the ceiling report and the warning on
 * Hono under Bun — is in `HonoBunIdleTimeout.test.ts`; this half reads the
 * number itself, off a backend that records what `listen()` is handed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import type {
  HttpServerBackend,
  RouteRegistration,
  ServerBinding,
  ServerListenOptions,
  WebsocketRouteRegistration,
} from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { requestTimeout } from '../../../src/http/middleware/Timeout.js';
import { complete, concat, fallback, get, path, withMiddleware, type Route } from '../../../src/http/Route.js';
import { Status, type HttpRequest, type HttpResponse } from '../../../src/http/Types.js';
import type { WebsocketServerRef } from '../../../src/http/websocket/WebsocketMessages.js';
import { websocket } from '../../../src/http/websocket/WebsocketRoute.js';
import { WebsocketServerActor } from '../../../src/http/websocket/WebsocketServerActor.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

class SilentServer extends WebsocketServerActor<never, never> {
  onMessage(): void { /* never reached — nothing connects here */ }
}

/** A backend that binds no port and records the options `listen()` is handed. */
class ListenRecordingBackend implements HttpServerBackend {
  readonly name = 'listen-recording';
  readonly listened: Array<ServerListenOptions | undefined> = [];

  registerRoute(_route: RouteRegistration): void { /* answers nothing */ }
  registerWebSocket(_registration: WebsocketRouteRegistration): void { /* upgrades nothing */ }
  setNotFound(_handler: (request: HttpRequest) => Promise<HttpResponse>): void { /* serves nothing */ }

  async listen(host: string, port: number, serverOptions?: ServerListenOptions): Promise<ServerBinding> {
    this.listened.push(serverOptions);
    return { host, port, unbind: async () => {} };
  }
}

const systems: ActorSystem[] = [];
afterEach(async () => {
  while (systems.length) await systems.pop()!.terminate();
});

function newSystem(hocon = ''): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(hocon));
  const system = ActorSystem.create('bind-request-deadline', options);
  systems.push(system);
  return system;
}

/** The `requestDeadlineMs` `bind()` handed the backend for `routes`. */
async function deadlineHandedOver(system: ActorSystem, routes: Route): Promise<number | undefined> {
  const backend = new ListenRecordingBackend();
  await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).useBackend(backend).bind(routes);
  expect(backend.listened).toHaveLength(1);
  return backend.listened[0]?.requestDeadlineMs;
}

const ok: Route = get(() => complete(Status.OK, 'ok'));
const notFound: Route = fallback(() => complete(Status.NotFound, 'none'));

describe('HttpExtension.bind — the request deadline covers every kind of endpoint (#1487)', () => {
  test('a fallback() whose requestTimeout() is the longest sets it', async () => {
    const system = newSystem();
    const routes = concat(path('short', withMiddleware(requestTimeout(1_000), ok)), withMiddleware(requestTimeout(400_000), notFound));

    expect(await deadlineHandedOver(system, routes)).toBe(400_000);
  });

  test('a websocket() route whose requestTimeout() is the longest sets it', async () => {
    const system = newSystem();
    const server = system.spawn(SilentServer, 'silent') as unknown as WebsocketServerRef<never, never, never>;
    const routes = concat(path('short', withMiddleware(requestTimeout(1_000), ok)), withMiddleware(requestTimeout(60_000), websocket('socket', server)));

    expect(await deadlineHandedOver(system, routes)).toBe(60_000);
  });

  test('neither lowers the configured deadline, which counts with no requestTimeout() at all', async () => {
    const system = newSystem('actor-ts.http.request-timeout.deadline = 300s');
    const server = system.spawn(SilentServer, 'silent') as unknown as WebsocketServerRef<never, never, never>;
    const routes = concat(
      withMiddleware(requestTimeout(10_000), notFound),
      withMiddleware(requestTimeout(20_000), websocket('socket', server)),
    );

    expect(await deadlineHandedOver(system, routes)).toBe(300_000);
    expect(await deadlineHandedOver(newSystem('actor-ts.http.request-timeout.deadline = 300s'), ok)).toBe(300_000);
  });
});
