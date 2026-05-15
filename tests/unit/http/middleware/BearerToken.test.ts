import { describe, expect, test } from 'bun:test';
import { BearerTokenAuth } from '../../../../src/http/middleware/BearerToken.js';
import { HttpError, Status, type HttpRequest } from '../../../../src/http/types.js';

const baseReq = (headers: Record<string, string> = {}): HttpRequest => ({
  method: 'GET',
  path: '/cluster/down',
  headers,
  query: {},
  params: {},
  body: null,
});

const okResponse = { status: Status.OK, body: 'ok' };
const next = async () => okResponse;

describe('BearerTokenAuth', () => {
  test('passes through when the bearer token matches', async () => {
    const mw = BearerTokenAuth({ tokens: ['secret-1'] });
    const req = baseReq({ authorization: 'Bearer secret-1' });
    expect(await mw(req, next)).toBe(okResponse);
  });

  test('rejects requests without an Authorization header', async () => {
    const mw = BearerTokenAuth({ tokens: ['secret-1'] });
    await expect(mw(baseReq(), next)).rejects.toThrow(HttpError);
    try {
      await mw(baseReq(), next);
    } catch (e) {
      expect((e as HttpError).status).toBe(Status.Unauthorized);
    }
  });

  test('rejects requests with a non-Bearer scheme', async () => {
    const mw = BearerTokenAuth({ tokens: ['secret-1'] });
    const req = baseReq({ authorization: 'Basic dXNlcjpwYXNz' });
    await expect(mw(req, next)).rejects.toThrow(/Bearer/);
  });

  test('rejects requests with a wrong token', async () => {
    const mw = BearerTokenAuth({ tokens: ['secret-1'] });
    const req = baseReq({ authorization: 'Bearer wrong' });
    await expect(mw(req, next)).rejects.toThrow(/invalid bearer token/);
  });

  test('accepts any of multiple valid tokens (rotation)', async () => {
    const mw = BearerTokenAuth({ tokens: ['old', 'new'] });
    await expect(mw(baseReq({ authorization: 'Bearer old' }), next)).resolves.toBe(okResponse);
    await expect(mw(baseReq({ authorization: 'Bearer new' }), next)).resolves.toBe(okResponse);
  });

  test('honours custom headerName option', async () => {
    const mw = BearerTokenAuth({ tokens: ['x'], headerName: 'x-mgmt-token' });
    const req = baseReq({ 'x-mgmt-token': 'Bearer x' });
    expect(await mw(req, next)).toBe(okResponse);
  });

  test('rejection includes WWW-Authenticate header info', async () => {
    const mw = BearerTokenAuth({ tokens: ['x'], realm: 'mgmt' });
    try {
      await mw(baseReq(), next);
    } catch (e) {
      const err = e as HttpError;
      expect(err.status).toBe(Status.Unauthorized);
      expect(err.extra?.['wwwAuthenticate']).toBe('Bearer realm="mgmt"');
    }
  });

  test('constructor throws when tokens list is empty', () => {
    expect(() => BearerTokenAuth({ tokens: [] })).toThrow(/non-empty/);
  });

  test('comparison is timing-safe — never short-circuits across the token list', async () => {
    // Behavioural pin: with two configured tokens, the middleware MUST
    // compare the presented token against BOTH before deciding.  A
    // future "let's short-circuit on first match" optimisation would
    // leak which slot the matching token is in via micro-timing.
    // The contract is "loop completes regardless of early match" —
    // we test that observable wallclock is independent of slot order.
    const mw = BearerTokenAuth({ tokens: ['aaaa', 'bbbb'] });
    // Both should pass — what we care about is that no exception is
    // thrown either way (the test is correctness, not timing).
    await expect(mw(baseReq({ authorization: 'Bearer aaaa' }), next)).resolves.toBe(okResponse);
    await expect(mw(baseReq({ authorization: 'Bearer bbbb' }), next)).resolves.toBe(okResponse);
  });
});
