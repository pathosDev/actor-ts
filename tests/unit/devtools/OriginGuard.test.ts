import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DevToolsServer } from '../../../src/devtools/DevToolsServer.js';
import type { DevToolsOptionsType } from '../../../src/devtools/DevToolsOptions.js';
import { compile, type CompiledWebsocketRoute } from '../../../src/http/Route.js';
import { Status, type HttpRequest } from '../../../src/http/Types.js';

const systems: ActorSystem[] = [];
afterEach(async () => {
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

/**
 * The tap's compiled upgrade guard.  Driving a real cross-origin handshake
 * is not possible from a test client — the runtime's `WebSocket` will not
 * let a caller forge `Origin`, which is precisely why the browser can be
 * trusted to send an honest one and why this check works at all.  So the
 * guard is exercised where the backend calls it.
 */
function tapUpgradeGuard(settings: Partial<DevToolsOptionsType> = {}): CompiledWebsocketRoute {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('devtools-origin', options);
  systems.push(system);

  const server = new DevToolsServer(system, { port: 0, host: '127.0.0.1', ...settings } as DevToolsOptionsType);
  server.start();
  const endpoint = compile(server.routes()).find((route) => route.kind === 'websocket');
  if (!endpoint || endpoint.kind !== 'websocket') throw new Error('expected a websocket endpoint');
  return endpoint;
}

const upgrade = (headers: Record<string, string>): HttpRequest => ({
  method: 'GET', path: '/api/ws', headers, query: {}, params: {}, body: null,
});

// #566 — a WebSocket upgrade is not subject to the same-origin policy, so
// the loopback bind that makes DevTools feel private stops nothing: any page
// the developer visits could dial ws://127.0.0.1:9333/api/ws, complete the
// handshake and read the actor tree, mailboxes, spans and — with time-travel
// on by default — the raw persisted events.
describe('DevTools WebSocket origin guard (#566)', () => {
  test('the guard exists on the default, unconfigured tap', async () => {
    // The regression itself: `routes()` used to pass `{}` when
    // `allowedOrigins` was unset, and an empty allowlist built no guard at
    // all, so `authorize` accepted everything.
    const guard = tapUpgradeGuard();
    const denied = await guard.authorize(upgrade({
      origin: 'https://evil.example',
      host: '127.0.0.1:9333',
    }));

    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(Status.Forbidden);
  });

  test('the UI, served from the tap itself, still connects', async () => {
    // The bundled UI builds its socket URL from `window.location.host`, so
    // Origin and Host agree by construction — whatever port, container name
    // or port-forward the developer is on.
    const guard = tapUpgradeGuard();
    expect(await guard.authorize(upgrade({
      origin: 'http://127.0.0.1:9333',
      host: '127.0.0.1:9333',
    }))).toBeNull();
  });

  test('a non-browser client with no Origin still connects', async () => {
    const guard = tapUpgradeGuard();
    expect(await guard.authorize(upgrade({ host: '127.0.0.1:9333' }))).toBeNull();
  });

  test('allowedOrigins widens the default rather than replacing it', async () => {
    const guard = tapUpgradeGuard({ allowedOrigins: ['https://studio.example.com'] });

    expect(await guard.authorize(upgrade({
      origin: 'https://studio.example.com', host: '127.0.0.1:9333',
    }))).toBeNull();
    // Same-origin keeps working — configuring a list must not lock the
    // tap's own UI out.
    expect(await guard.authorize(upgrade({
      origin: 'http://127.0.0.1:9333', host: '127.0.0.1:9333',
    }))).toBeNull();
    expect((await guard.authorize(upgrade({
      origin: 'https://evil.example', host: '127.0.0.1:9333',
    })))!.status).toBe(Status.Forbidden);
  });

  test('mount() into an application server is covered too', async () => {
    // A mounted tap can end up on a public server behind ambient cookie
    // auth — the classic remote-CSWSH shape.  The guard rides on the route
    // tree, so it comes along wherever the tree is mounted.  Since #594 an
    // ungated mount also has to be acknowledged, but that is a second lock
    // on the same door and not a replacement for this one: the case it
    // admits, `allowUngatedMount`, is precisely the case where this guard
    // is the only thing left.
    const guard = tapUpgradeGuard({ host: '0.0.0.0' });
    expect((await guard.authorize(upgrade({
      origin: 'https://evil.example', host: 'app.internal:8080',
    })))!.status).toBe(Status.Forbidden);
  });
});
