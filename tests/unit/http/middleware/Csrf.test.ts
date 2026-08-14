import { describe, expect, test } from 'bun:test';
import { csrfProtection, readCsrfToken, requireSameOrigin } from '../../../../src/http/middleware/Csrf.js';
import { CsrfOptions, DEFAULT_CSRF_COOKIE_NAME, SameOriginOptions } from '../../../../src/http/middleware/CsrfOptions.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import type { Middleware } from '../../../../src/http/Route.js';
import { HttpError, Status, type HttpRequest, type HttpResponse } from '../../../../src/http/Types.js';

const ok: HttpResponse = { status: Status.OK, body: 'ok' };
const request = (method: HttpRequest['method'], headers: Record<string, string> = {}): HttpRequest => ({
  method, path: '/', headers, query: {}, params: {}, body: null,
});

const SECRET = 'a-very-long-test-secret-key-0123456789';

/** `Cookie` header carrying a CSRF token under the (default) cookie name. */
const cookieHeader = (token: string, name = DEFAULT_CSRF_COOKIE_NAME): string => `${name}=${token}`;

/** Run a GET through the middleware and extract the minted token from Set-Cookie. */
async function mint(mw: Middleware, name = DEFAULT_CSRF_COOKIE_NAME): Promise<string> {
  const response = await mw(request('GET'), async () => ok);
  const setCookie = response.headers?.['set-cookie'] ?? '';
  return new RegExp(`${name}=([^;]+)`).exec(setCookie)![1]!;
}

describe('csrfProtection', () => {
  test('constructor requires a secret of at least 16 bytes', () => {
    expect(() => csrfProtection({})).toThrow(/secret of at least 16 bytes/);
    expect(() => csrfProtection({ secret: 'short' })).toThrow(/16 bytes/);
  });

  test('a GET issues a Set-Cookie and forwards the token to the handler', async () => {
    const mw = csrfProtection({ secret: SECRET });
    let forwarded: string | null = null;
    const response = await mw(request('GET'), async (enriched) => {
      forwarded = readCsrfToken(enriched ?? request('GET'));
      return ok;
    });
    const setCookie = response.headers?.['set-cookie'] ?? '';
    // #605 — the __Host- prefix is the default, and its rules hold.
    expect(setCookie).toContain(`${DEFAULT_CSRF_COOKIE_NAME}=`);
    expect(DEFAULT_CSRF_COOKIE_NAME).toBe('__Host-csrf-token');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Domain=');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure');
    expect(setCookie).not.toContain('HttpOnly');
    expect(forwarded).toBeTruthy();
    expect(setCookie).toContain(`${DEFAULT_CSRF_COOKIE_NAME}=${forwarded}`);
  });

  test('readCsrfToken falls back to the prefixed cookie', () => {
    const carrier = request('GET', { cookie: cookieHeader('a-token') });
    expect(readCsrfToken(carrier)).toBe('a-token');
    expect(readCsrfToken(request('GET', { cookie: 'csrf-token=a-token' }))).toBeNull();
  });

  test('a POST with a matching valid pair passes', async () => {
    const mw = csrfProtection({ secret: SECRET });
    const token = await mint(mw);
    const response = await mw(request('POST', { cookie: cookieHeader(token), 'x-csrf-token': token }), async () => ok);
    expect(response.status).toBe(Status.OK);
  });

  test('a POST missing the header / cookie / with a mismatch is rejected', async () => {
    const mw = csrfProtection({ secret: SECRET });
    const token = await mint(mw);
    const other = await mint(mw);
    await expect(mw(request('POST', { cookie: cookieHeader(token) }), async () => ok)).rejects.toThrow(HttpError);
    await expect(mw(request('POST', { 'x-csrf-token': token }), async () => ok)).rejects.toThrow(HttpError);
    await expect(mw(request('POST', { cookie: cookieHeader(token), 'x-csrf-token': other }), async () => ok)).rejects.toThrow(HttpError);
  });

  test('a planted unsigned token pair is rejected (the HMAC binding)', async () => {
    const mw = csrfProtection({ secret: SECRET });
    const planted = 'attacker.forged';
    await expect(mw(request('POST', { cookie: cookieHeader(planted), 'x-csrf-token': planted }), async () => ok))
      .rejects.toThrow(/CSRF verification failed/);
  });

  // #605 — pins what the HMAC actually buys.  A token this server minted
  // verifies no matter who presents it, so an attacker who can plant a
  // cookie plants a SIGNED one; the cookie name and the origin gate are the
  // defences, not the signature.
  test('a signed token minted for someone else still verifies', async () => {
    const attacker = csrfProtection({ secret: SECRET });
    const victimFacing = csrfProtection({ secret: SECRET });
    const planted = await mint(attacker);
    const response = await victimFacing(
      request('POST', { cookie: cookieHeader(planted), 'x-csrf-token': planted }),
      async () => ok,
    );
    expect(response.status).toBe(Status.OK);
    // Planting it cross-site is what fails: the origin gate rejects it …
    await expect(victimFacing(request('POST', {
      cookie: cookieHeader(planted),
      'x-csrf-token': planted,
      origin: 'https://evil.app.example',
      host: 'app.example',
    }), async () => ok)).rejects.toThrow(/CSRF verification failed/);
    // … and the cookie a sibling subdomain would have to write is __Host-.
    expect(DEFAULT_CSRF_COOKIE_NAME.startsWith('__Host-')).toBe(true);
  });

  test('a __Host- cookie name with incompatible attributes fails at construction', () => {
    // Would otherwise be a serializeCookie throw on every safe-method
    // request — a 500 per request instead of an error at wiring time.
    expect(() => csrfProtection({ secret: SECRET, cookie: { secure: false } })).toThrow(OptionsError);
    expect(() => csrfProtection({ secret: SECRET, cookie: { secure: false } })).toThrow(/__Host-csrf-token/);
    expect(() => csrfProtection({ secret: SECRET, cookie: { path: '/app' } })).toThrow(/cookie.path/);
    expect(() => csrfProtection({ secret: SECRET, cookie: { domain: 'app.example' } })).toThrow(/cookie.domain/);
    // The documented opt-out for a plain-HTTP deployment.
    const plainHttp = CsrfOptions.create()
      .withSecret(SECRET)
      .withCookieName('csrf-token')
      .withCookie({ secure: false });
    expect(() => csrfProtection(plainHttp)).not.toThrow();
  });

  test('a cross-origin POST is rejected even with a valid token pair', async () => {
    const mw = csrfProtection({ secret: SECRET });
    const token = await mint(mw);
    await expect(mw(request('POST', {
      cookie: cookieHeader(token),
      'x-csrf-token': token,
      origin: 'https://evil.example',
      host: 'app.example',
    }), async () => ok)).rejects.toThrow(/CSRF verification failed/);
  });

  // #604 — the origin gate compares whole origins, so a plaintext origin is
  // NOT the request's own origin for a (default) HTTPS site.
  test('an http:// origin is cross-origin for an https:// site', async () => {
    const mw = csrfProtection({ secret: SECRET });
    const token = await mint(mw);
    const pair = { cookie: cookieHeader(token), 'x-csrf-token': token, host: 'app.example' };
    await expect(mw(request('POST', { ...pair, origin: 'http://app.example' }), async () => ok))
      .rejects.toThrow(/CSRF verification failed/);
    expect((await mw(request('POST', { ...pair, origin: 'https://app.example' }), async () => ok)).status).toBe(Status.OK);
  });

  test('a plain-HTTP app (non-Secure cookie) expects http:// origins instead', async () => {
    const plainHttpOptions = CsrfOptions.create()
      .withSecret(SECRET)
      .withCookieName('csrf-token')
      .withCookie({ secure: false });
    const mw = csrfProtection(plainHttpOptions);
    const token = await mint(mw, 'csrf-token');
    const pair = { cookie: cookieHeader(token, 'csrf-token'), 'x-csrf-token': token, host: 'app.example' };
    expect((await mw(request('POST', { ...pair, origin: 'http://app.example' }), async () => ok)).status).toBe(Status.OK);
    await expect(mw(request('POST', { ...pair, origin: 'https://app.example' }), async () => ok))
      .rejects.toThrow(/CSRF verification failed/);
  });

  test('reads the token from a urlencoded form field when configured', async () => {
    const mw = csrfProtection(CsrfOptions.create().withSecret(SECRET).withFormField('_csrf'));
    const token = await mint(mw);
    const body = new TextEncoder().encode(`_csrf=${encodeURIComponent(token)}&x=1`);
    const r: HttpRequest = {
      method: 'POST', path: '/', query: {}, params: {},
      headers: { cookie: cookieHeader(token), 'content-type': 'application/x-www-form-urlencoded' },
      body,
    };
    expect((await mw(r, async () => ok)).status).toBe(Status.OK);
  });

  test('does not overwrite a Set-Cookie the handler already sent', async () => {
    const mw = csrfProtection({ secret: SECRET });
    const response = await mw(request('GET'), async () => ({ status: Status.OK, body: 'x', headers: { 'set-cookie': 'other=1' } }));
    expect(response.headers?.['set-cookie']).toBe('other=1');
  });
});

describe('requireSameOrigin', () => {
  test('safe methods always pass', async () => {
    const mw = requireSameOrigin();
    expect((await mw(request('GET', { origin: 'https://evil.example', host: 'app.example' }), async () => ok)).status).toBe(200);
  });

  test('same-host POST passes', async () => {
    const mw = requireSameOrigin();
    expect((await mw(request('POST', { origin: 'https://app.example', host: 'app.example' }), async () => ok)).status).toBe(200);
  });

  test('cross-origin POST is rejected', async () => {
    const mw = requireSameOrigin();
    await expect(mw(request('POST', { origin: 'https://evil.example', host: 'app.example' }), async () => ok)).rejects.toThrow(HttpError);
  });

  test('missing Origin/Referer is rejected by default, allowed when opted in', async () => {
    await expect(requireSameOrigin()(request('POST', { host: 'app.example' }), async () => ok)).rejects.toThrow(HttpError);
    const lax = requireSameOrigin({ allowMissingOrigin: true });
    expect((await lax(request('POST', { host: 'app.example' }), async () => ok)).status).toBe(200);
  });

  test('falls back to the Referer host', async () => {
    const mw = requireSameOrigin();
    expect((await mw(request('POST', { referer: 'https://app.example/page', host: 'app.example' }), async () => ok)).status).toBe(200);
  });

  // #604 — the whole origin is compared, not just the host.
  test('a same-host POST on another scheme is rejected', async () => {
    const mw = requireSameOrigin();
    await expect(mw(request('POST', { origin: 'http://app.example', host: 'app.example' }), async () => ok))
      .rejects.toThrow(HttpError);
    // Any scheme that parses an authority used to pass the host compare.
    await expect(mw(request('POST', { origin: 'foo://app.example', host: 'app.example' }), async () => ok))
      .rejects.toThrow(HttpError);
    await expect(mw(request('POST', { origin: 'null', host: 'app.example' }), async () => ok))
      .rejects.toThrow(HttpError);
  });

  test('expectedScheme names the scheme the site is served over', async () => {
    const sameOriginOptions = SameOriginOptions.create().withExpectedScheme('http');
    const mw = requireSameOrigin(sameOriginOptions);
    expect((await mw(request('POST', { origin: 'http://app.example', host: 'app.example' }), async () => ok)).status).toBe(200);
    await expect(mw(request('POST', { origin: 'https://app.example', host: 'app.example' }), async () => ok))
      .rejects.toThrow(HttpError);
  });

  test('an allowlisted origin is matched whole — scheme included, case and default port normalised', async () => {
    const sameOriginOptions = SameOriginOptions.create().withAllowedOrigins('https://Partner.example/', 'https://other.example:8443');
    const mw = requireSameOrigin(sameOriginOptions);
    const pass = async (origin: string): Promise<number> =>
      (await mw(request('POST', { origin, host: 'app.example' }), async () => ok)).status;
    expect(await pass('https://partner.example')).toBe(200);
    expect(await pass('https://partner.example:443')).toBe(200);
    expect(await pass('https://other.example:8443')).toBe(200);
    // The host-only fallback that used to accept these is gone.
    await expect(mw(request('POST', { origin: 'http://partner.example', host: 'app.example' }), async () => ok))
      .rejects.toThrow(HttpError);
    await expect(mw(request('POST', { origin: 'https://other.example', host: 'app.example' }), async () => ok))
      .rejects.toThrow(HttpError);
  });

  test('a case-differing Host header still matches its own origin', async () => {
    const mw = requireSameOrigin();
    expect((await mw(request('POST', { origin: 'https://app.example', host: 'APP.example' }), async () => ok)).status).toBe(200);
    expect((await mw(request('POST', { origin: 'https://app.example', host: 'app.example:443' }), async () => ok)).status).toBe(200);
  });

  test('an allowedOrigins entry that is not a full origin is rejected at construction', () => {
    expect(() => requireSameOrigin({ allowedOrigins: ['app.example'] })).toThrow(/allowedOrigins/);
    expect(() => requireSameOrigin({ expectedScheme: 'ftp' as never })).toThrow(/expectedScheme/);
  });
});
