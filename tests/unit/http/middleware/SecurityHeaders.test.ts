import { describe, expect, test } from 'bun:test';
import { DEFAULT_RESPONSE_SECURITY_HEADERS } from '../../../../src/http/backend/HttpServerBackend.js';
import { resolveSecurityHeaders, securityHeaders } from '../../../../src/http/middleware/SecurityHeaders.js';
import { SecurityHeadersOptions } from '../../../../src/http/middleware/SecurityHeadersOptions.js';
import type { Middleware } from '../../../../src/http/Route.js';
import { HttpError, Status, type HttpRequest, type HttpResponse } from '../../../../src/http/Types.js';

const request: HttpRequest = { method: 'GET', path: '/', headers: {}, query: {}, params: {}, body: null };
const run = (mw: Middleware, handlerHeaders?: Record<string, string>): Promise<HttpResponse> =>
  Promise.resolve(mw(request, async () => ({ status: Status.OK, body: 'x', headers: handlerHeaders })));
/** Drive the middleware over a `next` that throws — the idiomatic short-circuit. */
const rethrownBy = (mw: Middleware, error: unknown): Promise<unknown> =>
  Promise.resolve(mw(request, () => Promise.reject(error))).then(() => null, (rethrown: unknown) => rethrown);

describe('securityHeaders', () => {
  test('emits the default header set', async () => {
    const headers = (await run(securityHeaders())).headers ?? {};
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(headers['x-xss-protection']).toBe('0');
    // opt-in headers stay off by default
    expect(headers['cross-origin-embedder-policy']).toBeUndefined();
    expect(headers['permissions-policy']).toBeUndefined();
    expect(headers['strict-transport-security']).toBeUndefined();
  });

  test('false disables exactly its header', async () => {
    const options = SecurityHeadersOptions.create().withFrameOptions(false).withReferrerPolicy(false);
    const headers = (await run(securityHeaders(options))).headers ?? {};
    expect(headers['x-frame-options']).toBeUndefined();
    expect(headers['referrer-policy']).toBeUndefined();
    expect(headers['x-content-type-options']).toBe('nosniff'); // others untouched
  });

  test('contentTypeOptions: false omits nosniff from the map but not from the response (#1060)', async () => {
    // Two seams apply this bundle and `false` means different things in each.
    // Every test above drives the middleware alone, which is why the docs
    // could claim the header was disable-able for as long as they did: in
    // isolation the map really does lose it.
    const options = SecurityHeadersOptions.create().withContentTypeOptions(false);

    // The server-wide seam replaces the backend's default map, so `false`
    // there does turn the header off.
    const serverWide = resolveSecurityHeaders(options);
    expect(serverWide['x-content-type-options']).toBeUndefined();

    // As a middleware the same map is layered *over* what the backend has
    // already written, and a middleware can only add.
    const fromMiddleware = (await run(securityHeaders(options))).headers ?? {};
    expect(fromMiddleware['x-content-type-options']).toBeUndefined();
    const asSent = { ...DEFAULT_RESPONSE_SECURITY_HEADERS, ...fromMiddleware };
    expect(asSent['x-content-type-options']).toBe('nosniff');
  });

  test('withHsts includes STS; withHsts(false) suppresses it', async () => {
    const on = (await run(securityHeaders(SecurityHeadersOptions.create().withHsts()))).headers ?? {};
    expect(on['strict-transport-security']).toBe('max-age=15552000; includeSubDomains');
    const off = (await run(securityHeaders(SecurityHeadersOptions.create().withHsts(false)))).headers ?? {};
    expect(off['strict-transport-security']).toBeUndefined();
  });

  test('serialises a Permissions-Policy map', async () => {
    const options = SecurityHeadersOptions.create().withPermissionsPolicy({ camera: [], geolocation: ['self'] });
    const headers = (await run(securityHeaders(options))).headers ?? {};
    expect(headers['permissions-policy']).toBe('camera=(), geolocation=(self)');
  });

  test('a handler-set header wins over the bundle default', async () => {
    const headers = (await run(securityHeaders(), { 'x-frame-options': 'SAMEORIGIN' })).headers ?? {};
    expect(headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  test('COEP is emitted when opted in', async () => {
    const headers = (await run(securityHeaders(SecurityHeadersOptions.create().withCrossOriginEmbedderPolicy('require-corp')))).headers ?? {};
    expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
  });

  test('the bundle rides on a thrown HttpError short-circuit (#606)', async () => {
    // What a CSRF/auth rejection below this middleware throws — the case
    // that used to escape the whole decorator, because a rejected `await`
    // never reached the decoration.
    const rethrown = await rethrownBy(securityHeaders(), new HttpError(Status.Forbidden, 'CSRF verification failed'));
    expect(rethrown).toBeInstanceOf(HttpError);
    const error = rethrown as HttpError;
    expect(error.status).toBe(Status.Forbidden);
    expect(error.message).toBe('CSRF verification failed');
    expect(error.headers?.['x-frame-options']).toBe('DENY');
    expect(error.headers?.['referrer-policy']).toBe('no-referrer');
    expect(error.headers?.['cross-origin-opener-policy']).toBe('same-origin');
  });

  test('a header the thrower set itself still wins', async () => {
    const thrown = new HttpError(Status.Unauthorized, 'no', undefined, { 'www-authenticate': 'Basic', 'x-frame-options': 'SAMEORIGIN' });
    const headers = ((await rethrownBy(securityHeaders(), thrown)) as HttpError).headers ?? {};
    expect(headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(headers['www-authenticate']).toBe('Basic');
  });

  test('a non-HttpError throw is rethrown untouched — a crash stays a crash', async () => {
    const boom = new Error('kaboom');
    expect(await rethrownBy(securityHeaders(), boom)).toBe(boom);
  });
});
