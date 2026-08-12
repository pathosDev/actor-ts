import { describe, expect, test } from 'bun:test';
import { csrfProtection, readCsrfToken, requireSameOrigin } from '../../../../src/http/middleware/Csrf.js';
import { CsrfOptions, SameOriginOptions } from '../../../../src/http/middleware/CsrfOptions.js';
import type { Middleware } from '../../../../src/http/Route.js';
import { HttpError, Status, type HttpRequest, type HttpResponse } from '../../../../src/http/types.js';

const ok: HttpResponse = { status: Status.OK, body: 'ok' };
const request = (method: HttpRequest['method'], headers: Record<string, string> = {}): HttpRequest => ({
  method, path: '/', headers, query: {}, params: {}, body: null,
});

const SECRET = 'a-very-long-test-secret-key-0123456789';

/** Run a GET through the middleware and extract the minted token from Set-Cookie. */
async function mint(mw: Middleware): Promise<string> {
  const response = await mw(request('GET'), async () => ok);
  const setCookie = response.headers?.['set-cookie'] ?? '';
  return /csrf-token=([^;]+)/.exec(setCookie)![1]!;
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
    expect(setCookie).toContain('csrf-token=');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure');
    expect(setCookie).not.toContain('HttpOnly');
    expect(forwarded).toBeTruthy();
    expect(setCookie).toContain(`csrf-token=${forwarded}`);
  });

  test('a POST with a matching valid pair passes', async () => {
    const mw = csrfProtection({ secret: SECRET });
    const token = await mint(mw);
    const response = await mw(request('POST', { cookie: `csrf-token=${token}`, 'x-csrf-token': token }), async () => ok);
    expect(response.status).toBe(Status.OK);
  });

  test('a POST missing the header / cookie / with a mismatch is rejected', async () => {
    const mw = csrfProtection({ secret: SECRET });
    const token = await mint(mw);
    const other = await mint(mw);
    await expect(mw(request('POST', { cookie: `csrf-token=${token}` }), async () => ok)).rejects.toThrow(HttpError);
    await expect(mw(request('POST', { 'x-csrf-token': token }), async () => ok)).rejects.toThrow(HttpError);
    await expect(mw(request('POST', { cookie: `csrf-token=${token}`, 'x-csrf-token': other }), async () => ok)).rejects.toThrow(HttpError);
  });

  test('a planted unsigned token pair is rejected (the HMAC binding)', async () => {
    const mw = csrfProtection({ secret: SECRET });
    const planted = 'attacker.forged';
    await expect(mw(request('POST', { cookie: `csrf-token=${planted}`, 'x-csrf-token': planted }), async () => ok))
      .rejects.toThrow(/CSRF verification failed/);
  });

  test('a cross-origin POST is rejected even with a valid token pair', async () => {
    const mw = csrfProtection({ secret: SECRET });
    const token = await mint(mw);
    await expect(mw(request('POST', {
      cookie: `csrf-token=${token}`,
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
    const pair = { cookie: `csrf-token=${token}`, 'x-csrf-token': token, host: 'app.example' };
    await expect(mw(request('POST', { ...pair, origin: 'http://app.example' }), async () => ok))
      .rejects.toThrow(/CSRF verification failed/);
    expect((await mw(request('POST', { ...pair, origin: 'https://app.example' }), async () => ok)).status).toBe(Status.OK);
  });

  test('a plain-HTTP app (non-Secure cookie) expects http:// origins instead', async () => {
    const mw = csrfProtection(CsrfOptions.create()
      .withSecret(SECRET)
      .withCookie({ secure: false }));
    const token = await mint(mw);
    const pair = { cookie: `csrf-token=${token}`, 'x-csrf-token': token, host: 'app.example' };
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
      headers: { cookie: `csrf-token=${token}`, 'content-type': 'application/x-www-form-urlencoded' },
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
