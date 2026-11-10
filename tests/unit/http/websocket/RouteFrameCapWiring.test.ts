/**
 * #373 — the route's resolved frame cap reaches the backend at bind time, and
 * a shared transport reconciles several routes into one number.
 *
 * This is the seam the fix introduces, tested where it is deterministic.  The
 * end-to-end proof lives in `TransportFrameCap.test.ts` (Hono, whose runtime
 * enforces the limit the framework installs) and in the shared backend suite;
 * what those cannot show on every backend is *which* number was handed down,
 * because a runtime that ignores the option looks exactly like one that was
 * never given it.  A recording backend answers that directly.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../../src/config/HoconParser.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { DEFAULT_WEBSOCKET_MAX_FRAME_BYTES } from '../../../../src/http/Constants.js';
import { DEFAULT_PRE_ATTACH_BUFFER_LIMITS } from '../../../../src/http/websocket/SocketAdapter.js';
import { transportFrameCapOf } from '../../../../src/http/backend/HttpServerBackend.js';
import type {
  HttpServerBackend,
  RouteRegistration,
  ServerBinding,
  WebsocketRouteRegistration,
} from '../../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../../src/http/HttpExtension.js';
import { concat, type Route } from '../../../../src/http/Route.js';
import { websocket } from '../../../../src/http/websocket/WebsocketRoute.js';
import { WebsocketRouteOptions } from '../../../../src/http/websocket/WebsocketRouteOptions.js';
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';
import type { WebsocketServerRef } from '../../../../src/http/websocket/WebsocketMessages.js';

class SilentServer extends WebsocketServerActor<never, never> {
  onMessage(): void { /* never reached — nothing connects here */ }
}

/** A backend that binds nothing and only records what it was handed. */
class RecordingBackend implements HttpServerBackend {
  readonly name = 'recording';
  readonly websocketRoutes: WebsocketRouteRegistration[] = [];

  registerRoute(_route: RouteRegistration): void { /* not exercised here */ }

  registerWebSocket(registration: WebsocketRouteRegistration): void {
    this.websocketRoutes.push(registration);
  }

  async listen(host: string, port: number): Promise<ServerBinding> {
    return { host, port, unbind: async () => {} };
  }
}

/** A registration stub carrying nothing but the cap under test. */
function registrationWithCap(maxFrameBytes: number): WebsocketRouteRegistration {
  return {
    pattern: '/ws',
    maxFrameBytes,
    preAttachBuffer: DEFAULT_PRE_ATTACH_BUFFER_LIMITS,
    authorize: async () => null,
    onConnection: () => {},
  };
}

/**
 * Bind `makeRoutes` against a recording backend and hand back the registrations
 * it saw.  The system is terminated before returning — nothing here outlives
 * the bind.
 */
async function registrationsHandedToBackend(
  config: ConfigObject,
  makeRoutes: (server: WebsocketServerRef<never, never, never>) => Route,
): Promise<WebsocketRouteRegistration[]> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(config);
  const system = ActorSystem.create('ws-route-frame-cap-wiring', systemOptions);
  try {
    const server = system.spawn(SilentServer, 'silent') as unknown as WebsocketServerRef<never, never, never>;
    const backend = new RecordingBackend();
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(backend)
      .bind(makeRoutes(server));
    await binding.unbind();
    return backend.websocketRoutes;
  } finally {
    await system.terminate();
  }
}

/** As above, narrowed to the frame cap each registration carried. */
async function capsHandedToBackend(
  config: ConfigObject,
  makeRoutes: (server: WebsocketServerRef<never, never, never>) => Route,
): Promise<number[]> {
  const registrations = await registrationsHandedToBackend(config, makeRoutes);
  return registrations.map((registration) => registration.maxFrameBytes);
}

describe('transportFrameCapOf', () => {
  test('is the widest cap any registered route admits', () => {
    expect(transportFrameCapOf([registrationWithCap(64 * 1024), registrationWithCap(8 * 1024 * 1024)]))
      .toBe(8 * 1024 * 1024);
  });

  test('a single route is its own transport cap, in both directions', () => {
    expect(transportFrameCapOf([registrationWithCap(64 * 1024)])).toBe(64 * 1024);
    expect(transportFrameCapOf([registrationWithCap(32 * 1024 * 1024)])).toBe(32 * 1024 * 1024);
  });

  test('with no websocket routes it falls back to the built-in default', () => {
    // Unreachable through a shipped backend — each only asks once it has a
    // route — but the answer still has to be a bound rather than -Infinity.
    expect(transportFrameCapOf([])).toBe(DEFAULT_WEBSOCKET_MAX_FRAME_BYTES);
  });
});

describe('HttpExtension.bind — the route policy reaches the backend (#373)', () => {
  test('an unconfigured route hands down the built-in default', async () => {
    expect(await capsHandedToBackend({}, (server) => websocket('/ws', server)))
      .toEqual([DEFAULT_WEBSOCKET_MAX_FRAME_BYTES]);
  });

  test('a route that raises maxFrameBytes hands down the raised number', async () => {
    const caps = await capsHandedToBackend({}, (server) => {
      const routeOptions = WebsocketRouteOptions.create().withMaxFrameBytes(8 * 1024 * 1024);
      return websocket('/ws', server, routeOptions);
    });
    expect(caps).toEqual([8 * 1024 * 1024]);
  });

  test('a HOCON-configured cap hands down the configured number', async () => {
    // The direction the issue never mentioned: an operator lowering the cap
    // server-wide used to keep the built-in 1 MiB buffering window anyway,
    // because no backend read configuration and none held an ActorSystem.
    const caps = await capsHandedToBackend(
      { 'actor-ts': { http: { websocket: { 'max-frame-bytes': 64 * 1024 } } } },
      (server) => websocket('/ws', server),
    );
    expect(caps).toEqual([64 * 1024]);
  });

  test('a route option still outranks HOCON on the way down', async () => {
    const caps = await capsHandedToBackend(
      { 'actor-ts': { http: { websocket: { 'max-frame-bytes': 64 * 1024 } } } },
      (server) => {
        const routeOptions = WebsocketRouteOptions.create().withMaxFrameBytes(256 * 1024);
        return websocket('/ws', server, routeOptions);
      },
    );
    expect(caps).toEqual([256 * 1024]);
  });

  test('each route hands down its own cap, and the transport takes the widest', async () => {
    const caps = await capsHandedToBackend({}, (server) => concat(
      websocket('/narrow', server, WebsocketRouteOptions.create().withMaxFrameBytes(64 * 1024)),
      websocket('/wide', server, WebsocketRouteOptions.create().withMaxFrameBytes(4 * 1024 * 1024)),
    ));
    expect(caps).toEqual([64 * 1024, 4 * 1024 * 1024]);
    expect(transportFrameCapOf(caps.map(registrationWithCap))).toBe(4 * 1024 * 1024);
  });
});

/**
 * #717 AC-3 — the pre-attach buffer bound travels the same road.
 *
 * It has to reach the *registration* rather than `onConnection`, because the
 * backend builds the adapter — and with it the buffer — before it calls
 * `onConnection`.  A number that arrived any later would arrive after the
 * window it is meant to bound had already opened.
 */
describe('HttpExtension.bind — the pre-attach buffer bound reaches the backend (#717)', () => {
  test('an unconfigured route hands down the built-in bounds', async () => {
    const registrations = await registrationsHandedToBackend({}, (server) => websocket('/ws', server));
    expect(registrations.map((registration) => registration.preAttachBuffer))
      .toEqual([DEFAULT_PRE_ATTACH_BUFFER_LIMITS]);
  });

  test('route options outrank HOCON, and HOCON outranks the default', async () => {
    const config = {
      'actor-ts': { http: { websocket: { 'max-pre-attach-frames': 8, 'max-pre-attach-bytes': '64K' } } },
    };
    const fromHocon = await registrationsHandedToBackend(config, (server) => websocket('/ws', server));
    expect(fromHocon[0]!.preAttachBuffer).toEqual({ maxFrames: 8, maxBytes: 64 * 1024 });

    const overridden = await registrationsHandedToBackend(config, (server) => {
      const routeOptions = WebsocketRouteOptions.create()
        .withMaxPreAttachFrames(4)
        .withMaxPreAttachBytes(1024);
      return websocket('/ws', server, routeOptions);
    });
    expect(overridden[0]!.preAttachBuffer).toEqual({ maxFrames: 4, maxBytes: 1024 });
  });

  test('each route hands down its own bound', async () => {
    const registrations = await registrationsHandedToBackend({}, (server) => concat(
      websocket('/narrow', server, WebsocketRouteOptions.create().withMaxPreAttachFrames(2)),
      websocket('/wide', server, WebsocketRouteOptions.create().withMaxPreAttachFrames(500)),
    ));
    expect(registrations.map((registration) => registration.preAttachBuffer.maxFrames)).toEqual([2, 500]);
  });
});
