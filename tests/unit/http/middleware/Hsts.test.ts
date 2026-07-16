import { describe, expect, test } from 'bun:test';
import { hsts, strictTransportSecurity } from '../../../../src/http/middleware/Hsts.js';
import { HstsOptions } from '../../../../src/http/middleware/HstsOptions.js';
import type { Middleware } from '../../../../src/http/Route.js';
import { Status, type HttpRequest, type HttpResponse } from '../../../../src/http/types.js';

const request: HttpRequest = { method: 'GET', path: '/', headers: {}, query: {}, params: {}, body: null };
const run = (mw: Middleware, handlerHeaders?: Record<string, string>): Promise<HttpResponse> =>
  Promise.resolve(mw(request, async () => ({ status: Status.OK, body: 'x', headers: handlerHeaders })));

describe('strictTransportSecurity', () => {
  test('default header value', async () => {
    const response = await run(strictTransportSecurity());
    expect(response.headers?.['strict-transport-security']).toBe('max-age=15552000; includeSubDomains');
  });

  test('hsts is an alias', () => {
    expect(hsts).toBe(strictTransportSecurity);
  });

  test('honours maxAge and includeSubDomains=false', async () => {
    const options = HstsOptions.create().withMaxAge(100).withIncludeSubDomains(false);
    const response = await run(strictTransportSecurity(options));
    expect(response.headers?.['strict-transport-security']).toBe('max-age=100');
  });

  test('preload requires a year + includeSubDomains', () => {
    expect(() => strictTransportSecurity(HstsOptions.create().withPreload())).toThrow(/preload/);
    expect(() => strictTransportSecurity({ preload: true, maxAge: 31_536_000, includeSubDomains: false })).toThrow(/preload/);
  });

  test('a valid preload policy emits the directive', async () => {
    const options = HstsOptions.create().withMaxAge(31_536_000).withPreload();
    const response = await run(strictTransportSecurity(options));
    expect(response.headers?.['strict-transport-security']).toBe('max-age=31536000; includeSubDomains; preload');
  });

  test('does not clobber a handler-set STS header', async () => {
    const response = await run(strictTransportSecurity(), { 'strict-transport-security': 'max-age=1' });
    expect(response.headers?.['strict-transport-security']).toBe('max-age=1');
  });
});
