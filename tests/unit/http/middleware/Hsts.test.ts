import { describe, expect, test } from 'bun:test';
import { hsts, strictTransportSecurity } from '../../../../src/http/middleware/Hsts.js';
import { HstsOptions } from '../../../../src/http/middleware/HstsOptions.js';
import { resolveSecurityHeaders } from '../../../../src/http/middleware/SecurityHeaders.js';
import type { Middleware } from '../../../../src/http/Route.js';
import { HttpError, Status, type HttpRequest, type HttpResponse } from '../../../../src/http/Types.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';

const request: HttpRequest = { method: 'GET', path: '/', headers: {}, query: {}, params: {}, body: null };
const run = (mw: Middleware, handlerHeaders?: Record<string, string>): Promise<HttpResponse> =>
  Promise.resolve(mw(request, async () => ({ status: Status.OK, body: 'x', headers: handlerHeaders })));
/** Drive the middleware over a `next` that throws — the idiomatic short-circuit. */
const rethrownBy = (mw: Middleware, error: unknown): Promise<unknown> =>
  Promise.resolve(mw(request, () => Promise.reject(error))).then(() => null, (rethrown: unknown) => rethrown);

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

  test('a max-age the header cannot carry as delta-seconds is refused, not sent (#1462)', () => {
    // `max-age=1.5` and `max-age=1e+21` are not delta-seconds, and a browser
    // must ignore an STS header it cannot parse — so these used to switch
    // HSTS off without a word.  The bundle shares the same resolution, so
    // its `hsts` field is held to the same rule.
    expect(() => strictTransportSecurity({ maxAge: 1.5 })).toThrow(OptionsError);
    expect(() => strictTransportSecurity({ maxAge: 1e21 })).toThrow(OptionsError);
    expect(() => resolveSecurityHeaders({ hsts: { maxAge: 1.5 } })).toThrow(OptionsError);
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

  test('the pin rides on a thrown HttpError short-circuit (#606)', async () => {
    // A first-contact client whose very first request is the rejected one
    // is exactly who needs the pin, and used to be the one who never got it.
    const rethrown = await rethrownBy(strictTransportSecurity(), new HttpError(Status.Unauthorized, 'no'));
    expect(rethrown).toBeInstanceOf(HttpError);
    expect((rethrown as HttpError).headers?.['strict-transport-security']).toBe('max-age=15552000; includeSubDomains');
  });
});
