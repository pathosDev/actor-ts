import { describe, expect, test } from 'bun:test';
import { csrfProtection, readCsrfToken, requireSameOrigin } from '../../../../src/http/middleware/Csrf.js';
import { CsrfOptions } from '../../../../src/http/middleware/CsrfOptions.js';
import type { Middleware } from '../../../../src/http/Route.js';
import { HttpError, Status, type HttpRequest, type HttpResponse } from '../../../../src/http/types.js';

const ok: HttpResponse = { status: Status.OK, body: 'ok' };
const req = (method: HttpRequest['method'], headers: Record<string, string> = {}): HttpRequest => ({
  method, path: '/', headers, query: {}, params: {}, body: null,
});

const SECRET = 'a-very-long-test-secret-key-0123456789';

/** Run a GET through the middleware and extract the minted token from Set-Cookie. */
async function mint(mw: Middleware): Promise<string> {
  const res = await mw(req('GET'), async () => ok);
  const setCookie = res.headers?.['set-cookie'] ?? '';
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
    const res = await mw(req('GET'), async (enriched) => {
      forwarded = readCsrfToken(enriched ?? req('GET'));
      return ok;
    });
    const setCookie = res.headers?.['set-cookie'] ?? '';
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
    const res = await mw(req('POST', { cookie: `csrf-token=${token}`, 'x-csrf-token': token }), async () => ok);
    expect(res.status).toBe(Status.OK);
  });

  test('a POST missing the header / cookie / with a mismatch is rejected', async () => {
    const mw = csrfProtection({ secret: SECRET });
    const token = await mint(mw);
    const other = await mint(mw);
    await expect(mw(req('POST', { cookie: `csrf-token=${token}` }), async () => ok)).rejects.toThrow(HttpError);
    await expect(mw(req('POST', { 'x-csrf-token': token }), async () => ok)).rejects.toThrow(HttpError);
    await expect(mw(req('POST', { cookie: `csrf-token=${token}`, 'x-csrf-token': other }), async () => ok)).rejects.toThrow(HttpError);
  });

  test('a planted unsigned token pair is rejected (the HMAC binding)', async () => {
    const mw = csrfProtection({ secret: SECRET });
    const planted = 'attacker.forged';
    await expect(mw(req('POST', { cookie: `csrf-token=${planted}`, 'x-csrf-token': planted }), async () => ok))
      .rejects.toThrow(/CSRF verification failed/);
  });

  test('a cross-origin POST is rejected even with a valid token pair', async () => {
    const mw = csrfProtection({ secret: SECRET });
    const token = await mint(mw);
    await expect(mw(req('POST', {
      cookie: `csrf-token=${token}`,
      'x-csrf-token': token,
      origin: 'https://evil.example',
      host: 'app.example',
    }), async () => ok)).rejects.toThrow(/CSRF verification failed/);
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
    const res = await mw(req('GET'), async () => ({ status: Status.OK, body: 'x', headers: { 'set-cookie': 'other=1' } }));
    expect(res.headers?.['set-cookie']).toBe('other=1');
  });
});

describe('requireSameOrigin', () => {
  test('safe methods always pass', async () => {
    const mw = requireSameOrigin();
    expect((await mw(req('GET', { origin: 'https://evil.example', host: 'app.example' }), async () => ok)).status).toBe(200);
  });

  test('same-host POST passes', async () => {
    const mw = requireSameOrigin();
    expect((await mw(req('POST', { origin: 'https://app.example', host: 'app.example' }), async () => ok)).status).toBe(200);
  });

  test('cross-origin POST is rejected', async () => {
    const mw = requireSameOrigin();
    await expect(mw(req('POST', { origin: 'https://evil.example', host: 'app.example' }), async () => ok)).rejects.toThrow(HttpError);
  });

  test('missing Origin/Referer is rejected by default, allowed when opted in', async () => {
    await expect(requireSameOrigin()(req('POST', { host: 'app.example' }), async () => ok)).rejects.toThrow(HttpError);
    const lax = requireSameOrigin({ allowMissingOrigin: true });
    expect((await lax(req('POST', { host: 'app.example' }), async () => ok)).status).toBe(200);
  });

  test('falls back to the Referer host', async () => {
    const mw = requireSameOrigin();
    expect((await mw(req('POST', { referer: 'https://app.example/page', host: 'app.example' }), async () => ok)).status).toBe(200);
  });
});
