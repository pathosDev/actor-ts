import { afterEach, describe, expect, test } from 'bun:test';
import type { Clock } from '../../../../src/Clock.js';
import { JwtAuth } from '../../../../src/http/middleware/JwtAuth.js';
import type { Middleware } from '../../../../src/http/Route.js';
import { HttpError, type HttpRequest } from '../../../../src/http/Types.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';

/**
 * The JWK-set bounds JwtAuth applies when no `jwks*` option is given (#810),
 * each pinned by what it does rather than by the constant that holds it: the
 * 5 s fetch deadline, the 64 KiB document cap, the 10-minute trust window and
 * the 30 s refresh floor.  Every one of them is a security bound — how long a
 * request may be held, how much an issuer may make this process buffer, how
 * long a withdrawn key keeps verifying, how often a client sending random key
 * ids can make this process call the issuer — and any of them could be
 * loosened by a constant edit that leaves the other suites green.
 *
 * The fetch is a fake installed as `globalThis.fetch`, so the real
 * `HttpClient` runs on top of it and the deadline and the cap are the ones it
 * enforces.  The clock is a fake that moves — between requests where a test
 * says so, and for the refresh floor under the storm itself, which is what the
 * storm tests elsewhere do not do: their clock stands still during a storm, so
 * a floor of one millisecond passes them.
 */

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
});

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const START_MS = 1_800_000_000_000;
const JWKS_URL = 'https://issuer.example/.well-known/jwks.json';

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jsonSegment = (value: unknown): string => base64url(encoder.encode(JSON.stringify(value)));

// Generated once, at module scope: RSA generation is the slow part.
const rsa = await subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
) as CryptoKeyPair;
const { key_ops: _operations, ext: _extractable, ...publicJwk } = await subtle.exportKey('jwk', rsa.publicKey);
const setEntries = [{ ...publicJwk, kid: 'rsa-1', alg: 'RS256', use: 'sig' }];

/** A token the set's key verifies; it stays valid for a day, so no clock in this file expires it. */
const knownSigningInput = `${jsonSegment({ alg: 'RS256', kid: 'rsa-1' })}.${jsonSegment({ sub: 'user-1', exp: START_MS / 1000 + 86_400 })}`;
const knownToken = `${knownSigningInput}.${base64url(new Uint8Array(await subtle.sign('RSASSA-PKCS1-v1_5', rsa.privateKey, encoder.encode(knownSigningInput))))}`;
/** A token naming a key nobody holds.  Its key lookup refuses it, so its signature is never read. */
const unknownToken = (kid: string): string =>
  `${jsonSegment({ alg: 'RS256', kid })}.${jsonSegment({ sub: 'user-1', exp: START_MS / 1000 + 86_400 })}.AAAA`;

const movingClock = (): Clock & { advance(ms: number): void } => {
  let current = START_MS;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
};

/** The set's document as JSON, padded to exactly `bytes` bytes when asked. */
const documentOf = (bytes?: number): string => {
  const bare = JSON.stringify({ keys: setEntries, padding: '' });
  return bytes === undefined ? bare : JSON.stringify({ keys: setEntries, padding: 'x'.repeat(bytes - bare.length) });
};

/** Installs a fake `fetch` answering `answer`, and counts the calls. */
const fakeFetch = (answer: (init: RequestInit | undefined) => Promise<Response>): { readonly calls: () => number } => {
  let calls = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    calls += 1;
    return answer(init);
  }) as unknown as typeof fetch;
  return { calls: () => calls };
};

const jsonResponse = async (body: string): Promise<Response> =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/jwk-set+json' } });

/** JwtAuth over the set at {@link JWKS_URL}, with every `jwks*` option left to its default. */
const keySetAuth = (clock: Clock, logger = new RecordingLogger()): Middleware =>
  JwtAuth({ algorithms: ['RS256'], jwksUrl: JWKS_URL, clock, logger });

/** The status a client sees: 200 when the handler was reached. */
const statusOf = async (middleware: Middleware, token: string): Promise<number> => {
  const request: HttpRequest = { method: 'GET', path: '/orders', headers: { authorization: `Bearer ${token}` }, query: {}, params: {}, body: null };
  try {
    return (await middleware(request, async () => ({ status: 200 }))).status;
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
};

describe('JwtAuth — the JWK-set defaults, held by what they do', () => {
  test('a fetched set is trusted for 10 minutes, and not one millisecond longer', async () => {
    const clock = movingClock();
    const fetches = fakeFetch(() => jsonResponse(documentOf()));
    const middleware = keySetAuth(clock);
    expect(await statusOf(middleware, knownToken)).toBe(200);
    expect(fetches.calls()).toBe(1);
    clock.advance(600_000 - 1);
    expect(await statusOf(middleware, knownToken)).toBe(200);
    expect(fetches.calls()).toBe(1);
    clock.advance(1);
    expect(await statusOf(middleware, knownToken)).toBe(200);
    expect(fetches.calls()).toBe(2);
  });

  test('unknown key ids refetch the set at most once per 30 s — with the clock moving under the storm', async () => {
    const clock = movingClock();
    const fetches = fakeFetch(() => jsonResponse(documentOf()));
    const middleware = keySetAuth(clock);
    expect(await statusOf(middleware, knownToken)).toBe(200);
    // 29.9 s of storm, one unknown id every 100 ms: every one inside the floor.
    for (let i = 1; i < 300; i += 1) {
      clock.advance(100);
      expect(await statusOf(middleware, unknownToken(`storm-${i}`))).toBe(401);
    }
    clock.advance(99);
    expect(await statusOf(middleware, unknownToken('one-millisecond-short'))).toBe(401);
    expect(fetches.calls()).toBe(1);
    clock.advance(1);
    expect(await statusOf(middleware, unknownToken('on-the-floor'))).toBe(401);
    expect(fetches.calls()).toBe(2);
  });

  test('a fetch is given 5 s: that is the deadline armed, and when it runs out the token is answered 503', async () => {
    const clock = movingClock();
    let fetchStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    fakeFetch((init) => new Promise<Response>((_resolve, reject) => {
      fetchStarted();
      // Only the deadline ends this fetch: it answers nothing.
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    }));
    const armed: { readonly delayMs: number; readonly fire: () => void }[] = [];
    globalThis.setTimeout = ((handler: () => void, delayMs?: number) => {
      armed.push({ delayMs: delayMs ?? 0, fire: handler });
      // A real timer that does nothing, so the client's clearTimeout has one to clear.
      return realSetTimeout(() => undefined, delayMs);
    }) as unknown as typeof setTimeout;
    const logger = new RecordingLogger();
    const answer = statusOf(keySetAuth(clock, logger), knownToken);
    await started;
    globalThis.setTimeout = realSetTimeout;
    expect(armed.map((timer) => timer.delayMs)).toEqual([5_000]);
    armed[0]!.fire();
    expect(await answer).toBe(503);
    expect(logger.records.map((record) => record.message)).toEqual([
      `JwtAuth: the JWK set at ${JWKS_URL} could not be fetched: no answer within 5000 ms — an RS256 or ES256 token that needs it is answered 503 until a fetch succeeds`,
    ]);
  });

  test('a set of 64 KiB is read, and one byte more is refused', async () => {
    const atCap = documentOf(65_536);
    const overCap = documentOf(65_537);
    expect([encoder.encode(atCap).byteLength, encoder.encode(overCap).byteLength]).toEqual([65_536, 65_537]);

    fakeFetch(() => jsonResponse(atCap));
    expect(await statusOf(keySetAuth(movingClock()), knownToken)).toBe(200);

    fakeFetch(() => jsonResponse(overCap));
    const logger = new RecordingLogger();
    expect(await statusOf(keySetAuth(movingClock(), logger), knownToken)).toBe(503);
    expect(logger.records.map((record) => record.level)).toEqual(['warn']);
    expect(logger.records[0]?.message).toContain('exceeded maxResponseBytes=65536');
  });
});
