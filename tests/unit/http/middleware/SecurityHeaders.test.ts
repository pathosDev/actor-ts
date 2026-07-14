import { describe, expect, test } from 'bun:test';
import { securityHeaders } from '../../../../src/http/middleware/SecurityHeaders.js';
import { SecurityHeadersOptions } from '../../../../src/http/middleware/SecurityHeadersOptions.js';
import type { Middleware } from '../../../../src/http/Route.js';
import { Status, type HttpRequest, type HttpResponse } from '../../../../src/http/types.js';

const req: HttpRequest = { method: 'GET', path: '/', headers: {}, query: {}, params: {}, body: null };
const run = (mw: Middleware, handlerHeaders?: Record<string, string>): Promise<HttpResponse> =>
  Promise.resolve(mw(req, async () => ({ status: Status.OK, body: 'x', headers: handlerHeaders })));

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
    const opts = SecurityHeadersOptions.create().withFrameOptions(false).withReferrerPolicy(false);
    const headers = (await run(securityHeaders(opts))).headers ?? {};
    expect(headers['x-frame-options']).toBeUndefined();
    expect(headers['referrer-policy']).toBeUndefined();
    expect(headers['x-content-type-options']).toBe('nosniff'); // others untouched
  });

  test('withHsts includes STS; withHsts(false) suppresses it', async () => {
    const on = (await run(securityHeaders(SecurityHeadersOptions.create().withHsts()))).headers ?? {};
    expect(on['strict-transport-security']).toBe('max-age=15552000; includeSubDomains');
    const off = (await run(securityHeaders(SecurityHeadersOptions.create().withHsts(false)))).headers ?? {};
    expect(off['strict-transport-security']).toBeUndefined();
  });

  test('serialises a Permissions-Policy map', async () => {
    const opts = SecurityHeadersOptions.create().withPermissionsPolicy({ camera: [], geolocation: ['self'] });
    const headers = (await run(securityHeaders(opts))).headers ?? {};
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
});
