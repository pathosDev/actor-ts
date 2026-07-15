import { describe, expect, test } from 'bun:test';
import { contentSecurityPolicy } from '../../../../src/http/middleware/Csp.js';
import { CspOptions } from '../../../../src/http/middleware/CspOptions.js';
import type { Middleware } from '../../../../src/http/Route.js';
import { Status, type HttpRequest, type HttpResponse } from '../../../../src/http/types.js';

const req: HttpRequest = { method: 'GET', path: '/', headers: {}, query: {}, params: {}, body: null };
const run = (mw: Middleware, handlerHeaders?: Record<string, string>): Promise<HttpResponse> =>
  Promise.resolve(mw(req, async () => ({ status: Status.OK, body: 'x', headers: handlerHeaders })));

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self' https: 'unsafe-inline'; "
  + "img-src 'self' data:; font-src 'self' https: data:; object-src 'none'; frame-ancestors 'self'; "
  + "base-uri 'self'; form-action 'self'; upgrade-insecure-requests";

describe('contentSecurityPolicy', () => {
  test('emits the helmet-parity baseline by default', async () => {
    const res = await run(contentSecurityPolicy());
    expect(res.headers?.['content-security-policy']).toBe(DEFAULT_CSP);
  });

  test('withoutDefaults emits only the given directives', async () => {
    const opts = CspOptions.create().withoutDefaults().withDirectives({ defaultSrc: ["'none'"] });
    const res = await run(contentSecurityPolicy(opts));
    expect(res.headers?.['content-security-policy']).toBe("default-src 'none'");
  });

  test('a user directive overrides the baseline; [] removes it', async () => {
    const opts = CspOptions.create().withDirectives({ scriptSrc: ["'self'", 'https://cdn.example'], upgradeInsecureRequests: false, objectSrc: [] });
    const res = await run(contentSecurityPolicy(opts));
    const csp = res.headers?.['content-security-policy'] ?? '';
    expect(csp).toContain("script-src 'self' https://cdn.example");
    expect(csp).not.toContain('object-src');            // removed via []
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  test('reportOnly switches the header name', async () => {
    const res = await run(contentSecurityPolicy(CspOptions.create().withReportOnly()));
    expect(res.headers?.['content-security-policy-report-only']).toBeDefined();
    expect(res.headers?.['content-security-policy']).toBeUndefined();
  });

  test('rejects a source token containing ";"', () => {
    expect(() => contentSecurityPolicy({ directives: { defaultSrc: ["'self'; script-src *"] } })).toThrow(/invalid source/);
  });

  test('does not clobber a handler-set CSP header', async () => {
    const res = await run(contentSecurityPolicy(), { 'content-security-policy': "default-src 'none'" });
    expect(res.headers?.['content-security-policy']).toBe("default-src 'none'");
  });
});
