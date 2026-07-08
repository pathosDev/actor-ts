import { describe, expect, test } from 'bun:test';
import { BasicAuth } from '../../../../src/http/middleware/BasicAuth.js';
import { BasicAuthOptions } from '../../../../src/http/middleware/BasicAuthOptions.js';
import { HttpError, Status, type HttpRequest } from '../../../../src/http/types.js';

const ok = { status: Status.OK, body: 'ok' };
const next = async () => ok;
const req = (headers: Record<string, string> = {}): HttpRequest => ({
  method: 'GET', path: '/', headers, query: {}, params: {}, body: null,
});
const basic = (user: string, pass: string): string => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('BasicAuth', () => {
  test('constructor requires users or validate', () => {
    expect(() => BasicAuth({})).toThrow(/users or a validate/);
  });

  test('passes with correct credentials from the users map', async () => {
    const mw = BasicAuth({ users: { alice: 's3cret' } });
    expect((await mw(req({ authorization: basic('alice', 's3cret') }), next)).status).toBe(Status.OK);
  });

  test('401 with a WWW-Authenticate header when missing', async () => {
    const mw = BasicAuth(BasicAuthOptions.create().withUsers({ alice: 's3cret' }).withRealm('mgmt'));
    try {
      await mw(req(), next);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as HttpError;
      expect(err.status).toBe(Status.Unauthorized);
      expect(err.headers?.['www-authenticate']).toBe('Basic realm="mgmt"');
    }
  });

  test('401 on wrong scheme, wrong password, and unknown user', async () => {
    const mw = BasicAuth({ users: { alice: 's3cret' } });
    await expect(mw(req({ authorization: 'Bearer x' }), next)).rejects.toThrow(HttpError);
    await expect(mw(req({ authorization: basic('alice', 'wrong') }), next)).rejects.toThrow(/invalid credentials/);
    await expect(mw(req({ authorization: basic('mallory', 's3cret') }), next)).rejects.toThrow(/invalid credentials/);
  });

  test('supports a custom validate function', async () => {
    const mw = BasicAuth({ validate: (u, p) => u === 'x' && p === 'y' });
    expect((await mw(req({ authorization: basic('x', 'y') }), next)).status).toBe(Status.OK);
    await expect(mw(req({ authorization: basic('x', 'z') }), next)).rejects.toThrow(HttpError);
  });
});
