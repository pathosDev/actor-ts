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
import { Status, type HttpRequest } from '../../../../src/http/types.js';
import type { WebsocketServerRef } from '../../../../src/http/websocket/WebsocketMessages.js';

// The target ref is only captured into the (never-invoked) connect closure
// in these compile/authorize-only tests — a stub is sufficient.
const target = {} as unknown as WebsocketServerRef<unknown, unknown, never>;

const req = (headers: Record<string, string> = {}): HttpRequest => ({
  method: 'GET', path: '/ws', headers, query: {}, params: {}, body: null,
});

function wsEndpoint(route: Route): CompiledWebsocketRoute {
  const e = compile(route).find((x) => x.kind === 'websocket');
  if (!e || e.kind !== 'websocket') throw new Error('expected a websocket endpoint');
  return e;
}

// security audit WS-2 — Cross-Site Websocket Hijacking (CSWSH).
// Before this option, no upgrade handler validated `Origin`, so any web
// page could open an authenticated WS to the server riding the victim's
// ambient cookie/IP auth.  `allowedOrigins` gates the handshake.
describe('websocket() — allowedOrigins (CSWSH defence, WS-2)', () => {
  const allow = { allowedOrigins: ['https://app.example.com'] };

  test('no allowedOrigins → any Origin accepted (unchanged default)', async () => {
    const e = wsEndpoint(websocket('/ws', target));
    expect(await e.authorize(req({ origin: 'https://evil.example.com' }))).toBeNull();
  });

  test('present-but-unlisted Origin → 403', async () => {
    const e = wsEndpoint(websocket('/ws', target, allow));
    const res = await e.authorize(req({ origin: 'https://evil.example.com' }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(Status.Forbidden);
  });

  test('listed Origin → accepted (case-insensitive)', async () => {
    const e = wsEndpoint(websocket('/ws', target, allow));
    expect(await e.authorize(req({ origin: 'https://app.example.com' }))).toBeNull();
    expect(await e.authorize(req({ origin: 'HTTPS://APP.EXAMPLE.COM' }))).toBeNull();
  });

  test('missing Origin (non-browser client) → allowed', async () => {
    const e = wsEndpoint(websocket('/ws', target, allow));
    expect(await e.authorize(req())).toBeNull();
  });

  test('builder form withAllowedOrigins behaves identically', async () => {
    const opts = WebsocketRouteOptions.create().withAllowedOrigins(['https://app.example.com']);
    const e = wsEndpoint(websocket('/ws', target, opts));
    expect((await e.authorize(req({ origin: 'https://evil.example.com' })))!.status).toBe(Status.Forbidden);
    expect(await e.authorize(req({ origin: 'https://app.example.com' }))).toBeNull();
  });

  test('composes with withMiddleware — bad origin rejected even when middleware passes', async () => {
    const passthrough: Middleware = (_r, next) => next();
    const e = wsEndpoint(withMiddleware(passthrough, websocket('/ws', target, allow)));
    expect((await e.authorize(req({ origin: 'https://evil.example.com' })))!.status).toBe(Status.Forbidden);
    expect(await e.authorize(req({ origin: 'https://app.example.com' }))).toBeNull();
  });
});
