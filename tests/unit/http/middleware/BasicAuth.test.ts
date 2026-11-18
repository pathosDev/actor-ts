import { describe, expect, test } from 'bun:test';
import { BasicAuth } from '../../../../src/http/middleware/BasicAuth.js';
import { BasicAuthOptions } from '../../../../src/http/middleware/BasicAuthOptions.js';
import { HttpError, Status, type HttpRequest } from '../../../../src/http/Types.js';

const ok = { status: Status.OK, body: 'ok' };
const next = async () => ok;
const request = (headers: Record<string, string> = {}): HttpRequest => ({
  method: 'GET', path: '/', headers, query: {}, params: {}, body: null,
});
const basic = (user: string, pass: string): string => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('BasicAuth', () => {
  test('constructor requires users or validate', () => {
    expect(() => BasicAuth({})).toThrow(/users or a validate/);
  });

  test('passes with correct credentials from the users map', async () => {
    const mw = BasicAuth({ users: { alice: 's3cret' } });
    expect((await mw(request({ authorization: basic('alice', 's3cret') }), next)).status).toBe(Status.OK);
  });

  test('401 with a WWW-Authenticate header when missing', async () => {
    const mw = BasicAuth(BasicAuthOptions.create().withUsers({ alice: 's3cret' }).withRealm('mgmt'));
    try {
      await mw(request(), next);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as HttpError;
      expect(err.status).toBe(Status.Unauthorized);
      expect(err.headers?.['www-authenticate']).toBe('Basic realm="mgmt"');
    }
  });

  test('401 on wrong scheme, wrong password, and unknown user', async () => {
    const mw = BasicAuth({ users: { alice: 's3cret' } });
    await expect(mw(request({ authorization: 'Bearer x' }), next)).rejects.toThrow(HttpError);
    await expect(mw(request({ authorization: basic('alice', 'wrong') }), next)).rejects.toThrow(/invalid credentials/);
    await expect(mw(request({ authorization: basic('mallory', 's3cret') }), next)).rejects.toThrow(/invalid credentials/);
  });

  test('supports a custom validate function', async () => {
    const mw = BasicAuth({ validate: (u, p) => u === 'x' && p === 'y' });
    expect((await mw(request({ authorization: basic('x', 'y') }), next)).status).toBe(Status.OK);
    await expect(mw(request({ authorization: basic('x', 'z') }), next)).rejects.toThrow(HttpError);
  });

  // #968: the comparison count is the invariant, so it is counted rather than
  // timed. `safeEqual` turns each side into a Buffer, so the number of
  // `Buffer.from` calls during one request counts the comparisons exactly
  // (plus one constant call for the base64 decode of the header).
  describe('the comparison count does not depend on whether the username exists (#968)', () => {
    const countBufferFrom = async (run: () => unknown): Promise<number> => {
      const original = Buffer.from;
      let calls = 0;
      (Buffer as { from: unknown }).from = (...parameters: unknown[]) => {
        calls += 1;
        return (original as (...values: unknown[]) => Buffer).apply(Buffer, parameters);
      };
      try {
        await Promise.resolve(run()).catch(() => undefined);
      } finally {
        (Buffer as { from: unknown }).from = original;
      }
      return calls;
    };
    const users = { alice: 's3cret', bob: 'hunter22', carol: 'correct-horse' };
    const headers = {
      unknownUser: basic('nosuchuser', 'wrong'),
      knownUserWrongPassword: basic('alice', 'wrong'),
      knownUserSameLengthPassword: basic('alice', 's3crex'),
      validCredentials: basic('alice', 's3cret'),
    };

    test('an unknown user, a wrong password and a valid login all perform the same comparisons', async () => {
      const mw = BasicAuth({ users });
      const counts: Record<string, number> = {};
      for (const [name, authorization] of Object.entries(headers)) {
        counts[name] = await countBufferFrom(() => mw(request({ authorization }), next));
      }
      expect(counts.knownUserWrongPassword).toBe(counts.unknownUser!);
      expect(counts.knownUserSameLengthPassword).toBe(counts.unknownUser!);
      expect(counts.validCredentials).toBe(counts.unknownUser!);
      // One decode, then two Buffers per comparison and two comparisons per entry.
      expect(counts.unknownUser).toBe(1 + Object.keys(users).length * 2 * 2);
    });

    test('an unknown user and a wrong password still answer the same 401', async () => {
      const mw = BasicAuth({ users });
      const failures: HttpError[] = [];
      for (const authorization of [headers.unknownUser, headers.knownUserWrongPassword]) {
        try {
          await mw(request({ authorization }), next);
          throw new Error('should have thrown');
        } catch (e) {
          failures.push(e as HttpError);
        }
      }
      expect(failures[0]!.status).toBe(Status.Unauthorized);
      expect(failures[0]!.message).toBe(failures[1]!.message);
      expect(failures[0]!.headers).toEqual(failures[1]!.headers!);
    });
  });
});
