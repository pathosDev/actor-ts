import { describe, expect, test } from 'bun:test';
import {
  compile,
  withMiddleware,
  type CompiledWebsocketRoute,
  type Middleware,
  type Route,
} from '../../../../src/http/Route.js';
import { websocket } from '../../../../src/http/websocket/WebsocketRoute.js';
import { WebsocketRouteOptions } from '../../../../src/http/websocket/WebsocketRouteOptions.js';
import { Status, type HttpRequest } from '../../../../src/http/Types.js';
import type { WebsocketServerRef } from '../../../../src/http/websocket/WebsocketMessages.js';

// The target ref is only captured into the (never-invoked) connect closure
// in these compile/authorize-only tests — a stub is sufficient.
const target = {} as unknown as WebsocketServerRef<unknown, unknown, never>;

const request = (headers: Record<string, string> = {}): HttpRequest => ({
  method: 'GET', path: '/ws', headers, query: {}, params: {}, body: null,
});

function wsEndpoint(route: Route): CompiledWebsocketRoute {
  const endpoint = compile(route).find((x) => x.kind === 'websocket');
  if (!endpoint || endpoint.kind !== 'websocket') throw new Error('expected a websocket endpoint');
  return endpoint;
}

// security audit WS-2 — Cross-Site Websocket Hijacking (CSWSH).
// Before this option, no upgrade handler validated `Origin`, so any web
// page could open an authenticated WS to the server riding the victim's
// ambient cookie/IP auth.  `allowedOrigins` gates the handshake.
describe('websocket() — allowedOrigins (CSWSH defence, WS-2)', () => {
  const allow = { allowedOrigins: ['https://app.example.com'] };

  test('no allowedOrigins → any Origin accepted (unchanged default)', async () => {
    const endpoint = wsEndpoint(websocket('/ws', target));
    expect(await endpoint.authorize(request({ origin: 'https://evil.example.com' }))).toBeNull();
  });

  test('present-but-unlisted Origin → 403', async () => {
    const endpoint = wsEndpoint(websocket('/ws', target, allow));
    const response = await endpoint.authorize(request({ origin: 'https://evil.example.com' }));
    expect(response).not.toBeNull();
    expect(response!.status).toBe(Status.Forbidden);
  });

  test('listed Origin → accepted (case-insensitive)', async () => {
    const endpoint = wsEndpoint(websocket('/ws', target, allow));
    expect(await endpoint.authorize(request({ origin: 'https://app.example.com' }))).toBeNull();
    expect(await endpoint.authorize(request({ origin: 'HTTPS://APP.EXAMPLE.COM' }))).toBeNull();
  });

  test('missing Origin (non-browser client) → allowed', async () => {
    const endpoint = wsEndpoint(websocket('/ws', target, allow));
    expect(await endpoint.authorize(request())).toBeNull();
  });

  test('builder form withAllowedOrigins behaves identically', async () => {
    const options = WebsocketRouteOptions.create().withAllowedOrigins(['https://app.example.com']);
    const endpoint = wsEndpoint(websocket('/ws', target, options));
    expect((await endpoint.authorize(request({ origin: 'https://evil.example.com' })))!.status).toBe(Status.Forbidden);
    expect(await endpoint.authorize(request({ origin: 'https://app.example.com' }))).toBeNull();
  });

  test('composes with withMiddleware — bad origin rejected even when middleware passes', async () => {
    const passthrough: Middleware = (_r, next) => next();
    const endpoint = wsEndpoint(withMiddleware(passthrough, websocket('/ws', target, allow)));
    expect((await endpoint.authorize(request({ origin: 'https://evil.example.com' })))!.status).toBe(Status.Forbidden);
    expect(await endpoint.authorize(request({ origin: 'https://app.example.com' }))).toBeNull();
  });
});

// #566 — the DevTools socket needs a same-origin default, but its host is
// only known at runtime (an arbitrary port, a port-forward, a container
// name), so an allowlist cannot be pre-filled.  This rule compares the
// upgrade's `Origin` against its own `Host` instead.
describe('websocket() — requireSameOrigin', () => {
  const sameOrigin = { requireSameOrigin: true };

  test('Origin matching the request Host → allowed', async () => {
    const endpoint = wsEndpoint(websocket('/ws', target, sameOrigin));
    expect(await endpoint.authorize(request({
      origin: 'http://127.0.0.1:9333',
      host: '127.0.0.1:9333',
    }))).toBeNull();
  });

  test('cross-origin page on loopback → 403', async () => {
    // The actual CSWSH shape: a page the developer visits dials the tap.
    const endpoint = wsEndpoint(websocket('/ws', target, sameOrigin));
    const denied = await endpoint.authorize(request({
      origin: 'https://evil.example',
      host: '127.0.0.1:9333',
    }));
    expect(denied!.status).toBe(Status.Forbidden);
  });

  test('a different port on the same machine is a different origin → 403', async () => {
    const endpoint = wsEndpoint(websocket('/ws', target, sameOrigin));
    const denied = await endpoint.authorize(request({
      origin: 'http://127.0.0.1:8080',
      host: '127.0.0.1:9333',
    }));
    expect(denied!.status).toBe(Status.Forbidden);
  });

  test('missing Origin (non-browser client) stays allowed', async () => {
    const endpoint = wsEndpoint(websocket('/ws', target, sameOrigin));
    expect(await endpoint.authorize(request({ host: '127.0.0.1:9333' }))).toBeNull();
  });

  test('an unparseable Origin → 403', async () => {
    const endpoint = wsEndpoint(websocket('/ws', target, sameOrigin));
    const denied = await endpoint.authorize(request({ origin: 'null', host: '127.0.0.1:9333' }));
    expect(denied!.status).toBe(Status.Forbidden);
  });

  test('combines with allowedOrigins — either rule admits', async () => {
    const options = WebsocketRouteOptions.create()
      .withRequireSameOrigin(true)
      .withAllowedOrigins(['https://studio.example.com']);
    const endpoint = wsEndpoint(websocket('/ws', target, options));
    // Same-origin arm.
    expect(await endpoint.authorize(request({
      origin: 'http://127.0.0.1:9333', host: '127.0.0.1:9333',
    }))).toBeNull();
    // Allowlist arm.
    expect(await endpoint.authorize(request({
      origin: 'https://studio.example.com', host: '127.0.0.1:9333',
    }))).toBeNull();
    // Neither.
    expect((await endpoint.authorize(request({
      origin: 'https://evil.example', host: '127.0.0.1:9333',
    })))!.status).toBe(Status.Forbidden);
  });

  test('unset → no origin check, so existing routes are unaffected', async () => {
    const endpoint = wsEndpoint(websocket('/ws', target));
    expect(await endpoint.authorize(request({
      origin: 'https://evil.example', host: '127.0.0.1:9333',
    }))).toBeNull();
  });
});
