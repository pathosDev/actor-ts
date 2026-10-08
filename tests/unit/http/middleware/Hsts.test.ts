import { describe, expect, test } from 'bun:test';
import { hsts, resolveHsts, strictTransportSecurity } from '../../../../src/http/middleware/Hsts.js';
import {
  DEFAULT_HSTS_INCLUDE_SUB_DOMAINS,
  DEFAULT_HSTS_MAX_AGE_SECONDS,
  DEFAULT_HSTS_PRELOAD,
  HstsOptions,
} from '../../../../src/http/middleware/HstsOptions.js';
import { resolveSecurityHeaders } from '../../../../src/http/middleware/SecurityHeaders.js';
import { compile, complete, get, withMiddleware, type Middleware } from '../../../../src/http/Route.js';
import { HttpError, Status, type HttpRequest, type HttpResponse } from '../../../../src/http/Types.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';

const request: HttpRequest = { method: 'GET', path: '/', headers: {}, query: {}, params: {}, body: null };
const ok = (): HttpResponse => complete(Status.OK, 'ok');
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

  test('an unset field resolves to its named default', () => {
    // The names are what DOCUMENTED_DEFAULTS pins the published reference.conf
    // values against, so they have to be the values an empty policy gets.
    expect(resolveHsts({})).toEqual({
      maxAge: DEFAULT_HSTS_MAX_AGE_SECONDS,
      includeSubDomains: DEFAULT_HSTS_INCLUDE_SUB_DOMAINS,
      preload: DEFAULT_HSTS_PRELOAD,
    });
    expect([DEFAULT_HSTS_MAX_AGE_SECONDS, DEFAULT_HSTS_INCLUDE_SUB_DOMAINS, DEFAULT_HSTS_PRELOAD])
      .toEqual([15_552_000, true, false]);
  });

  test('honours maxAge and includeSubDomains=false', async () => {
    const options = HstsOptions.create().withMaxAge(100).withIncludeSubDomains(false);
    const response = await run(strictTransportSecurity(options));
    expect(response.headers?.['strict-transport-security']).toBe('max-age=100');
  });

  test('preload requires a year + includeSubDomains, checked when the policy is resolved', async () => {
    // Not at construction any more (#1462): the year can come from
    // actor-ts.http.hsts, which does not exist until the tree is compiled, so
    // the rule runs on the merged policy — from bind(), or from compile().
    const tooShort = strictTransportSecurity(HstsOptions.create().withPreload());
    const noSubDomains = strictTransportSecurity({ preload: true, maxAge: 31_536_000, includeSubDomains: false });
    expect(() => compile(withMiddleware(tooShort, get(ok)))).toThrow(/preload/);
    expect(() => compile(withMiddleware(noSubDomains, get(ok)))).toThrow(/preload/);
    // Called directly there is no tree to compile, so its first request is
    // where the merge happens.
    const firstRequest = async (): Promise<HttpResponse> => tooShort(request, async () => ok());
    await expect(firstRequest()).rejects.toThrow(/preload/);
  });

  test('a max-age the header cannot carry as delta-seconds is refused, not sent (#1462)', () => {
    // `max-age=1.5` and `max-age=1e+21` are not delta-seconds, and a browser
    // must ignore an STS header it cannot parse — so these used to switch
    // HSTS off without a word.  The bundle shares the same resolution, so
    // its `hsts` field is held to the same rule.
    expect(() => compile(withMiddleware(strictTransportSecurity({ maxAge: 1.5 }), get(ok)))).toThrow(OptionsError);
    expect(() => compile(withMiddleware(strictTransportSecurity({ maxAge: 1e21 }), get(ok)))).toThrow(OptionsError);
    expect(() => resolveSecurityHeaders({ hsts: { maxAge: 1.5 } })).toThrow(OptionsError);
  });

  test('the options are taken when hsts() is called, not when the tree is compiled', async () => {
    // A builder is its settings and stays mutable; a later withX on the same
    // builder must not reach a middleware that was already handed it.
    const options = HstsOptions.create().withMaxAge(100);
    const middleware = strictTransportSecurity(options);
    options.withMaxAge(200);
    const endpoint = compile(withMiddleware(middleware, get(ok)))[0]!;
    if (endpoint.kind !== 'http') throw new Error(`expected an http route, got ${endpoint.kind}`);
    expect((await endpoint.handler(request)).headers?.['strict-transport-security']).toBe('max-age=100; includeSubDomains');
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
