import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { HonoBackend } from '../../../src/http/backend/HonoBackend.js';
import type { HttpServerBackend, RouteRegistration, ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId, type ServerBuilder } from '../../../src/http/HttpExtension.js';
import { completeHtml, html } from '../../../src/http/Html.js';
import { contentSecurityPolicy } from '../../../src/http/middleware/Csp.js';
import { requestId } from '../../../src/http/middleware/RequestId.js';
import { securityHeaders } from '../../../src/http/middleware/SecurityHeaders.js';
import { SecurityHeadersOptions } from '../../../src/http/middleware/SecurityHeadersOptions.js';
import { complete, concat, fallback, get, path, withMiddleware, type Middleware, type Route } from '../../../src/http/Route.js';
import { HttpError, Status } from '../../../src/http/Types.js';
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

async function start(
  makeBackend: () => HttpServerBackend,
  routes: Route,
  configure: (builder: ServerBuilder) => ServerBuilder = (b) => b,
): Promise<string> {
  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('http-response-headers-test', sysOptions);
  const builder = system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).useBackend(makeBackend());
  const binding = await configure(builder).bind(routes);
  live.push({ binding, system });
  return `http://${binding.host}:${binding.port}`;
}

/** What a CSRF or auth rejection does: short-circuit by throwing, never returning. */
const rejecting: Middleware = async () => { throw new HttpError(Status.Forbidden, 'CSRF verification failed'); };

const guardedSecurityHeaders = SecurityHeadersOptions.create().withHsts();

/** Every route a case below needs, so one server covers the whole matrix. */
const routes = (): Route => concat(
  path('plain', get(() => complete(Status.OK, 'hello'))),
  path('own-header', get(() => ({ status: Status.OK, headers: { 'X-Content-Type-Options': 'off' }, body: 'hello' }))),
  path('already-nosniff', get(() => completeHtml(Status.OK, html`<p>hi</p>`))),
  path('http-error', get(() => { throw new HttpError(Status.Forbidden, 'nope'); })),
  path('boom', get(() => { throw new Error('kaboom'); })),
  // The decorator stack of the documented security page, over a middleware
  // that short-circuits by throwing (#606).
  path('guarded',
    withMiddleware(requestId(),
    withMiddleware(securityHeaders(guardedSecurityHeaders),
    withMiddleware(contentSecurityPolicy(),
    withMiddleware(rejecting,
      get(() => complete(Status.OK, 'unreachable'))))))),
  fallback(() => complete(Status.NotFound, 'nothing here')),
);

describe.each(backends)('response security headers — %s backend', (_name, makeBackend) => {
  test('a plain response carries nosniff without any configuration', async () => {
    const url = await start(makeBackend, routes());
    const response = await fetch(`${url}/plain`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('only nosniff — the embedding-relevant headers stay opt-in', async () => {
    const url = await start(makeBackend, routes());
    const response = await fetch(`${url}/plain`);
    expect(response.headers.get('x-frame-options')).toBeNull();
    expect(response.headers.get('cross-origin-resource-policy')).toBeNull();
    expect(response.headers.get('referrer-policy')).toBeNull();
  });

  test("the response's own header wins, matched case-insensitively", async () => {
    const url = await start(makeBackend, routes());
    const response = await fetch(`${url}/own-header`);
    expect(response.headers.get('x-content-type-options')).toBe('off');
  });

  test('a handler that already sends nosniff does not get it twice', async () => {
    const url = await start(makeBackend, routes());
    const response = await fetch(`${url}/already-nosniff`);
    // A duplicate would surface as the comma-joined "nosniff, nosniff".
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('the thrown-HttpError response carries it', async () => {
    const url = await start(makeBackend, routes());
    const response = await fetch(`${url}/http-error`);
    expect(response.status).toBe(403);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('the generic 500 carries it', async () => {
    const url = await start(makeBackend, routes());
    const response = await fetch(`${url}/boom`);
    expect(response.status).toBe(500);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('the fallback 404 carries it', async () => {
    const url = await start(makeBackend, routes());
    const response = await fetch(`${url}/nowhere`);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('withSecurityHeaders(false) opts out entirely', async () => {
    const url = await start(makeBackend, routes(), (b) => b.withSecurityHeaders(false));
    const response = await fetch(`${url}/plain`);
    expect(response.headers.get('x-content-type-options')).toBeNull();
  });

  test('withSecurityHeaders(false) also opts the error paths out', async () => {
    const url = await start(makeBackend, routes(), (b) => b.withSecurityHeaders(false));
    expect((await fetch(`${url}/boom`)).headers.get('x-content-type-options')).toBeNull();
    expect((await fetch(`${url}/nowhere`)).headers.get('x-content-type-options')).toBeNull();
  });

  test('passing options opts into the whole bundle, server-wide', async () => {
    const securityHeaders = SecurityHeadersOptions.create()
      .withFrameOptions('SAMEORIGIN')
      .withReferrerPolicy('strict-origin-when-cross-origin');
    const url = await start(makeBackend, routes(), (b) => b.withSecurityHeaders(securityHeaders));
    const response = await fetch(`${url}/plain`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    // Bundle defaults the caller did not mention come along too.
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });

  test('the opted-in bundle reaches the error paths a middleware would miss', async () => {
    const url = await start(makeBackend, routes(), (b) => b.withSecurityHeaders({}));
    const response = await fetch(`${url}/boom`);
    expect(response.status).toBe(500);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  test('a throwing short-circuit still carries the decorators above it (#606)', async () => {
    const url = await start(makeBackend, routes());
    const response = await fetch(`${url}/guarded`);
    expect(response.status).toBe(403);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    // The two with no server-wide equivalent — a skipped decorator was the
    // only way they could go missing.
    expect(response.headers.get('strict-transport-security')).toBe('max-age=15552000; includeSubDomains');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
  });
});

/*
 * NOT covered here: the Express backend's WebSocket upgrade-reject, which
 * writes HTTP straight onto the raw socket.  It does get the same defaults
 * merged in, but an end-to-end assertion is impossible under `bun test`:
 * measured on Bun 1.3.1, *nothing* written to a `node:http` `'upgrade'`
 * socket ever reaches the peer — write, end, destroy, delayed destroy all
 * deliver zero bytes, while the identical probe under Node 26 delivers the
 * full response.  So a test here would fail for a reason that has nothing
 * to do with the header, and a passing one would have proved nothing.  The
 * swallowed upgrade-reject is a defect of its own (an `authorize` guard's
 * 401 never reaching a Bun-hosted client) and is filed separately.
 */

/** A third-party backend that predates the hook — the DSL must say so, not ignore it. */
class HookLessBackend implements HttpServerBackend {
  readonly name = 'hookless';
  registerRoute(_route: RouteRegistration): void { /* never reached in this test */ }
  listen(): Promise<ServerBinding> {
    throw new Error('listen() must not be reached — bind() rejects before it');
  }
}

describe('withSecurityHeaders on a backend without the hook', () => {
  test('bind() fails with a message naming the backend', async () => {
    const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('http-response-headers-hookless', sysOptions);
    try {
      const builder = system.extension(HttpExtensionId)
        .newServerAt('127.0.0.1', 0)
        .useBackend(new HookLessBackend())
        .withSecurityHeaders(false);
      await expect(builder.bind(get(() => complete(Status.OK, 'x')))).rejects.toThrow(/hookless.*setDefaultResponseHeaders/s);
    } finally {
      await system.terminate();
    }
  });
});
