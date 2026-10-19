import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import type { Clock } from '../../../../src/Clock.js';
import { JwtAuth, jwtClaimsOf, type JwtClaims } from '../../../../src/http/middleware/JwtAuth.js';
import { JwtAuthOptions, type JwtAuthOptionsType } from '../../../../src/http/middleware/JwtAuthOptions.js';
import {
  compile,
  completeText,
  defaultErrorResponse,
  get,
  withMiddleware,
  type CompiledRoute,
  type CompiledWebsocketRoute,
  type Middleware,
  type Route,
} from '../../../../src/http/Route.js';
import { HttpError, Status, type HttpRequest, type HttpResponse } from '../../../../src/http/Types.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

/* ------------------------------- fixtures ------------------------------- */
// Keys are generated once, at module scope: RSA generation is the slow part
// and bun's per-test cap is 5 000 ms.

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const fixedClock: Clock = { now: () => NOW_MS };

const rsaParameters: RsaHashedKeyGenParams = {
  name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
};
const rsa = await subtle.generateKey(rsaParameters, true, ['sign', 'verify']) as CryptoKeyPair;
const rsaRotated = await subtle.generateKey(rsaParameters, true, ['sign', 'verify']) as CryptoKeyPair;
const attacker = await subtle.generateKey(rsaParameters, true, ['sign', 'verify']) as CryptoKeyPair;
const rsaSmall = await subtle.generateKey({ ...rsaParameters, modulusLength: 1024 }, true, ['sign', 'verify']) as CryptoKeyPair;
const ec = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
const SECRET = 's'.repeat(32);

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jsonSegment = (value: unknown): string => base64url(encoder.encode(JSON.stringify(value)));

const pemOf = async (pair: CryptoKeyPair): Promise<string> => {
  const der = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  return `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
};
const jwkOf = async (pair: CryptoKeyPair, extra: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const { key_ops: _operations, ext: _extractable, ...jwk } = await subtle.exportKey('jwk', pair.publicKey);
  return { ...jwk, ...extra };
};

type Signer = (signingInput: Uint8Array<ArrayBuffer>) => Promise<Uint8Array<ArrayBuffer>>;
const rsaSigner = (pair: CryptoKeyPair): Signer => async (input) =>
  new Uint8Array(await subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, input));
const ecSigner = (pair: CryptoKeyPair): Signer => async (input) =>
  new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, input));
const hmacSigner = (secret: BufferSource): Signer => async (input) => {
  const key = await subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, input));
};

const signToken = async (header: Record<string, unknown>, claims: Record<string, unknown>, signer: Signer): Promise<string> => {
  const signingInput = `${jsonSegment(header)}.${jsonSegment(claims)}`;
  return `${signingInput}.${base64url(await signer(encoder.encode(signingInput)))}`;
};

const claims = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ sub: 'user-1', exp: NOW + 600, ...extra });

/** The raw `r || s` ES256 signature re-encoded as the DER `SEQUENCE` other tooling produces. */
const derOf = (raw: Uint8Array): Uint8Array => {
  const integer = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const value = [...bytes.slice(start)];
    if (value[0]! & 0x80) value.unshift(0);
    return [0x02, value.length, ...value];
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
};

const rsaPem = await pemOf(rsa);
const ecPem = await pemOf(ec);

const rs256 = (extra: Partial<JwtAuthOptionsType> = {}): JwtAuthOptionsType => ({
  algorithms: ['RS256'],
  publicKeys: [{ keyId: 'rsa-1', algorithm: 'RS256', key: rsaPem }],
  clock: fixedClock,
  ...extra,
});

const requestWith = (authorization?: string): HttpRequest => ({
  method: 'GET',
  path: '/orders',
  headers: authorization === undefined ? {} : { authorization },
  query: {},
  params: {},
  body: null,
});

/* ------------------------------- harness -------------------------------- */

type Outcome = {
  readonly response: HttpResponse;
  readonly reached: boolean;
  readonly claims: JwtClaims | undefined;
  readonly thrown: unknown;
};

/** Run `request` through `middleware` the way a server does: compiled, with errors mapped to responses. */
const through = async (middleware: Middleware, request: HttpRequest): Promise<Outcome> => {
  let reached = false;
  let seen: JwtClaims | undefined;
  const [endpoint] = compile(withMiddleware(middleware, get((handled) => {
    reached = true;
    seen = jwtClaimsOf(handled);
    return completeText(Status.OK, 'ok');
  }))) as CompiledRoute[];
  try {
    const response = await endpoint!.handler(request);
    return { response, reached, claims: seen, thrown: undefined };
  } catch (thrown) {
    return { response: defaultErrorResponse(thrown), reached, claims: seen, thrown };
  }
};

const bearer = (token: string): HttpRequest => requestWith(`Bearer ${token}`);

const errorOf = (outcome: Outcome): string => (outcome.response.body as { error: string }).error;

const expectAccepted = (outcome: Outcome): void => {
  expect(outcome.thrown).toBeUndefined();
  expect(outcome.response.status).toBe(Status.OK);
  expect(outcome.reached).toBe(true);
};

const expectRefused = (outcome: Outcome, message: string, realm = 'actor-ts'): void => {
  expect(outcome.response.status).toBe(Status.Unauthorized);
  expect(outcome.reached).toBe(false);
  expect(outcome.response.headers?.['www-authenticate']).toBe(`Bearer realm="${realm}", error="invalid_token"`);
  expect(errorOf(outcome)).toBe(message);
};

/* -------------------------------- tests --------------------------------- */

describe('JwtAuth — a valid token', () => {
  test('an RS256 token from a configured PEM key reaches the handler, which reads its claims', async () => {
    const token = await signToken({ alg: 'RS256', typ: 'JWT', kid: 'rsa-1' }, claims({ scope: 'orders:read' }), rsaSigner(rsa));
    const outcome = await through(JwtAuth(rs256()), bearer(token));
    expectAccepted(outcome);
    expect(outcome.claims?.sub).toBe('user-1');
    expect(outcome.claims?.exp).toBe(NOW + 600);
    expect(outcome.claims?.['scope']).toBe('orders:read');
    expect(Object.isFrozen(outcome.claims)).toBe(true);
  });

  test('an ES256 token with its raw r||s signature, and an HS256 token with a configured secret', async () => {
    const es256 = JwtAuth({ algorithms: ['ES256'], publicKeys: [{ algorithm: 'ES256', key: ecPem }], clock: fixedClock });
    expectAccepted(await through(es256, bearer(await signToken({ alg: 'ES256' }, claims(), ecSigner(ec)))));
    const secretOptions = JwtAuthOptions.create()
      .withAlgorithms('HS256')
      .withSecrets({ keyId: 'v1', secret: SECRET })
      .withClock(fixedClock);
    const hs256 = JwtAuth(secretOptions);
    expectAccepted(await through(hs256, bearer(await signToken({ alg: 'HS256', kid: 'v1' }, claims(), hmacSigner(encoder.encode(SECRET))))));
  });

  test('the scheme is matched case-insensitively and surrounding spaces do not matter', async () => {
    const token = await signToken({ alg: 'RS256', kid: 'rsa-1' }, claims(), rsaSigner(rsa));
    expectAccepted(await through(JwtAuth(rs256()), requestWith(`bearer   ${token}  `)));
  });

  test('a route the middleware does not wrap sees no claims, whatever the client sends', async () => {
    let seen: JwtClaims | undefined = { exp: 0 };
    const [endpoint] = compile(get((handled) => {
      seen = jwtClaimsOf(handled);
      return completeText(Status.OK, 'ok');
    })) as CompiledRoute[];
    await endpoint!.handler({ ...requestWith(), headers: { 'actor-ts.jwt': '{"sub":"admin"}', 'x-jwt-claims': '{"sub":"admin"}' } });
    expect(seen).toBeUndefined();
  });
});

describe('JwtAuth — the challenge (RFC 6750 §3.1)', () => {
  test('no credentials at all: 401 with a bare challenge, no error code', async () => {
    const outcome = await through(JwtAuth(rs256()), requestWith());
    expect(outcome.response.status).toBe(Status.Unauthorized);
    expect(outcome.response.headers?.['www-authenticate']).toBe('Bearer realm="actor-ts"');
    expect(errorOf(outcome)).toBe('missing Authorization header');
  });

  test('another scheme: 401 with a bare challenge', async () => {
    const outcome = await through(JwtAuth(rs256()), requestWith('Basic dXNlcjpwYXNz'));
    expect(outcome.response.status).toBe(Status.Unauthorized);
    expect(outcome.response.headers?.['www-authenticate']).toBe('Bearer realm="actor-ts"');
    expect(errorOf(outcome)).toBe('authorization scheme must be Bearer');
  });

  test('a token that fails: 401 with error="invalid_token" in the configured realm', async () => {
    expectRefused(await through(JwtAuth(rs256({ realm: 'orders' })), bearer('not-a-token')), 'malformed token', 'orders');
    expectRefused(await through(JwtAuth(rs256()), requestWith('Bearer')), 'malformed token');
  });
});

describe('JwtAuth — the classic pitfalls', () => {
  test('alg "none" is refused in every spelling, with or without a signature', async () => {
    const middleware = JwtAuth(rs256());
    for (const none of ['none', 'None', 'NONE', 'nOnE']) {
      const unsigned = `${jsonSegment({ alg: none, typ: 'JWT' })}.${jsonSegment(claims())}`;
      expectRefused(await through(middleware, bearer(`${unsigned}.`)), 'malformed token');
      expectRefused(await through(middleware, bearer(`${unsigned}.c2lnbmF0dXJl`)), 'token algorithm not accepted');
    }
    expect(() => JwtAuth({ algorithms: ['none' as never], secrets: [{ secret: SECRET }] })).toThrow(OptionsError);
  });

  test('the algorithm is matched exactly — a correctly signed "rs256" is not RS256', async () => {
    const token = await signToken({ alg: 'rs256', kid: 'rsa-1' }, claims(), rsaSigner(rsa));
    expectRefused(await through(JwtAuth(rs256()), bearer(token)), 'token algorithm not accepted');
  });

  test('an algorithm the application did not allow is refused even with a valid signature', async () => {
    const token = await signToken({ alg: 'RS256', kid: 'rsa-1' }, claims(), rsaSigner(rsa));
    const esOnly = JwtAuth({ algorithms: ['ES256'], publicKeys: [{ algorithm: 'ES256', key: ecPem }], clock: fixedClock });
    expectRefused(await through(esOnly, bearer(token)), 'token algorithm not accepted');
  });

  test('an empty signature is refused', async () => {
    const valid = await signToken({ alg: 'RS256', kid: 'rsa-1' }, claims(), rsaSigner(rsa));
    const [header, payload] = valid.split('.');
    expectRefused(await through(JwtAuth(rs256()), bearer(`${header}.${payload}.`)), 'malformed token');
  });

  test('an HS256 token signed with the RSA public key bytes is refused — and would pass a naive verifier', async () => {
    const der = new Uint8Array(await subtle.exportKey('spki', rsa.publicKey));
    const both = JwtAuth(rs256({ algorithms: ['RS256', 'HS256'], secrets: [{ keyId: 'hmac-1', secret: SECRET }] }));
    for (const publicBytes of [der, encoder.encode(rsaPem)]) {
      // Naming the RSA key: it verifies RS256 only.
      const named = await signToken({ alg: 'HS256', kid: 'rsa-1' }, claims(), hmacSigner(publicBytes));
      expectRefused(await through(both, bearer(named)), 'no key verifies this token');
      // Naming no key: the only HS256 key is the configured secret.
      const unnamed = await signToken({ alg: 'HS256' }, claims(), hmacSigner(publicBytes));
      expectRefused(await through(both, bearer(unnamed)), 'token signature invalid');
      // With HS256 not allowed at all, the algorithm alone refuses it.
      expectRefused(await through(JwtAuth(rs256()), bearer(named)), 'token algorithm not accepted');
      // The forgery is a real one: an HMAC key made from those bytes accepts it.
      const [header, payload, signature] = unnamed.split('.') as [string, string, string];
      const naive = await subtle.importKey('raw', publicBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
      const signatureBytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      expect(await subtle.verify('HMAC', naive, signatureBytes, encoder.encode(`${header}.${payload}`))).toBe(true);
    }
  });

  test('a kid naming a key of another algorithm is refused, whichever way round', async () => {
    const mixed = JwtAuth({
      algorithms: ['RS256', 'ES256'],
      publicKeys: [{ keyId: 'rsa-1', algorithm: 'RS256', key: rsaPem }, { keyId: 'ec-1', algorithm: 'ES256', key: ecPem }],
      clock: fixedClock,
    });
    expectRefused(await through(mixed, bearer(await signToken({ alg: 'ES256', kid: 'rsa-1' }, claims(), ecSigner(ec)))), 'no key verifies this token');
    expectRefused(await through(mixed, bearer(await signToken({ alg: 'RS256', kid: 'ec-1' }, claims(), rsaSigner(rsa)))), 'no key verifies this token');
    expectAccepted(await through(mixed, bearer(await signToken({ alg: 'ES256', kid: 'ec-1' }, claims(), ecSigner(ec)))));
  });

  test('a key the token carries or points at is never used: jwk, x5c and x5u are ignored', async () => {
    const attackerJwk = await jwkOf(attacker, {});
    for (const header of [
      { alg: 'RS256', jwk: attackerJwk },
      { alg: 'RS256', x5c: ['MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA'] },
      { alg: 'RS256', x5u: 'https://attacker.example/cert.pem' },
    ]) {
      const token = await signToken(header, claims(), rsaSigner(attacker));
      expectRefused(await through(JwtAuth(rs256()), bearer(token)), 'token signature invalid');
    }
  });

  test('a crit header is refused, even on a correctly signed token', async () => {
    const token = await signToken({ alg: 'RS256', kid: 'rsa-1', crit: ['exp'] }, claims(), rsaSigner(rsa));
    expectRefused(await through(JwtAuth(rs256()), bearer(token)), 'token carries an unsupported critical header');
  });

  test('a DER-encoded ES256 signature is refused as malformed, its raw form accepted', async () => {
    const es256 = JwtAuth({ algorithms: ['ES256'], publicKeys: [{ algorithm: 'ES256', key: ecPem }], clock: fixedClock });
    const signingInput = `${jsonSegment({ alg: 'ES256' })}.${jsonSegment(claims())}`;
    const raw = await ecSigner(ec)(encoder.encode(signingInput));
    expect(raw.byteLength).toBe(64);
    expectAccepted(await through(es256, bearer(`${signingInput}.${base64url(raw)}`)));
    expectRefused(await through(es256, bearer(`${signingInput}.${base64url(derOf(raw))}`)), 'malformed token');
  });

  test('a token over maxTokenBytes is refused before it is decoded', async () => {
    const token = await signToken({ alg: 'RS256', kid: 'rsa-1' }, claims({ padding: 'x'.repeat(10_000) }), rsaSigner(rsa));
    expect(token.length).toBeGreaterThan(8_192);
    expectRefused(await through(JwtAuth(rs256()), bearer(token)), 'token too large');
    expectAccepted(await through(JwtAuth(rs256({ maxTokenBytes: 16_384 })), bearer(token)));
  });

  test('a tampered payload fails the signature', async () => {
    const valid = await signToken({ alg: 'RS256', kid: 'rsa-1' }, claims(), rsaSigner(rsa));
    const [header, , signature] = valid.split('.');
    const tampered = `${header}.${jsonSegment(claims({ sub: 'admin' }))}.${signature}`;
    expectRefused(await through(JwtAuth(rs256()), bearer(tampered)), 'token signature invalid');
  });

  test('a segment that is not the canonical base64url of its bytes is malformed — one token, one spelling', async () => {
    const valid = await signToken({ alg: 'RS256', kid: 'rsa-1' }, claims(), rsaSigner(rsa));
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    // A 256-byte signature leaves 4 spare bits in its last character:
    // flipping one spells the same bytes differently.
    const last = valid.at(-1)!;
    const respelled = valid.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1];
    expectAccepted(await through(JwtAuth(rs256()), bearer(valid)));
    expectRefused(await through(JwtAuth(rs256()), bearer(respelled)), 'malformed token');
  });

  test('structurally broken tokens are malformed', async () => {
    const middleware = JwtAuth(rs256());
    const payload = jsonSegment(claims());
    for (const broken of [
      'a.b',
      'a.b.c.d',
      `${base64url(encoder.encode('not json'))}.${payload}.c2ln`,
      `${jsonSegment(['RS256'])}.${payload}.c2ln`,
      `${base64url(new Uint8Array([0xff, 0xfe, 0xfd]))}.${payload}.c2ln`,
      `${jsonSegment({ alg: 'RS256', kid: 7 })}.${payload}.c2ln`,
      `${jsonSegment({ alg: 'RS256', kid: '' })}.${payload}.c2ln`,
      `${jsonSegment({ alg: 'RS256' })}.${payload}.c2l=`,
    ]) {
      expectRefused(await through(middleware, bearer(broken)), 'malformed token');
    }
  });

  test('a key id nothing configured knows is refused, and a key-less token needs exactly one candidate', async () => {
    expectRefused(await through(JwtAuth(rs256()), bearer(await signToken({ alg: 'RS256', kid: 'other' }, claims(), rsaSigner(rsa)))), 'no key verifies this token');
    const unnamed = await signToken({ alg: 'RS256' }, claims(), rsaSigner(rsa));
    expectAccepted(await through(JwtAuth(rs256()), bearer(unnamed)));
    const two = JwtAuth(rs256({ publicKeys: [{ keyId: 'rsa-1', algorithm: 'RS256', key: rsaPem }, { keyId: 'rsa-2', algorithm: 'RS256', key: await pemOf(rsaRotated) }] }));
    expectRefused(await through(two, bearer(unnamed)), 'token key is ambiguous');
  });
});

describe('JwtAuth — the claims', () => {
  const token = (extra: Record<string, unknown>, remove: readonly string[] = []): Promise<string> => {
    const body = claims(extra);
    for (const name of remove) delete body[name];
    return signToken({ alg: 'RS256', kid: 'rsa-1' }, body, rsaSigner(rsa));
  };

  test('exp is required, and must be a number', async () => {
    expectRefused(await through(JwtAuth(rs256()), bearer(await token({}, ['exp']))), 'token has no expiry');
    expectRefused(await through(JwtAuth(rs256()), bearer(await token({ exp: String(NOW + 600) }))), 'token claims malformed');
    expectRefused(await through(JwtAuth(rs256()), bearer(await token({ exp: null }))), 'token claims malformed');
  });

  test('exp: refused from the instant it passes, after the clock skew', async () => {
    const middleware = JwtAuth(rs256());
    expectRefused(await through(middleware, bearer(await token({ exp: NOW - 31 }))), 'token expired');
    expectRefused(await through(middleware, bearer(await token({ exp: NOW - 30 }))), 'token expired');
    expectAccepted(await through(middleware, bearer(await token({ exp: NOW - 29 }))));
    const strict = JwtAuth(rs256({ clockSkewMs: 0 }));
    expectRefused(await through(strict, bearer(await token({ exp: NOW }))), 'token expired');
    expectAccepted(await through(strict, bearer(await token({ exp: NOW + 1 }))));
  });

  test('nbf: refused until it arrives, less the clock skew; a non-number is malformed', async () => {
    const middleware = JwtAuth(rs256());
    expectRefused(await through(middleware, bearer(await token({ nbf: NOW + 31 }))), 'token not yet valid');
    expectAccepted(await through(middleware, bearer(await token({ nbf: NOW + 30 }))));
    expectAccepted(await through(middleware, bearer(await token({ nbf: NOW - 100 }))));
    expectRefused(await through(middleware, bearer(await token({ nbf: 'now' }))), 'token claims malformed');
    expectRefused(await through(middleware, bearer(await token({ iat: '2026-10-19' }))), 'token claims malformed');
  });

  test('iss is compared exactly when an issuer is configured', async () => {
    const middleware = JwtAuth(rs256({ issuer: 'https://issuer.example/' }));
    expectAccepted(await through(middleware, bearer(await token({ iss: 'https://issuer.example/' }))));
    expectRefused(await through(middleware, bearer(await token({ iss: 'https://issuer.example' }))), 'token issuer not accepted');
    expectRefused(await through(middleware, bearer(await token({ iss: 'https://ISSUER.example/' }))), 'token issuer not accepted');
    expectRefused(await through(middleware, bearer(await token({}))), 'token issuer not accepted');
    const either = JwtAuth(rs256({ issuer: ['https://a.example/', 'https://b.example/'] }));
    expectAccepted(await through(either, bearer(await token({ iss: 'https://b.example/' }))));
    expectAccepted(await through(JwtAuth(rs256()), bearer(await token({ iss: 'https://anyone.example/' }))));
    expectRefused(await through(JwtAuth(rs256()), bearer(await token({ iss: 42 }))), 'token claims malformed');
  });

  test('aud names this service, as a string or in a list — and a token naming any audience is refused when none is configured', async () => {
    const orders = JwtAuth(rs256({ audience: 'orders' }));
    expectAccepted(await through(orders, bearer(await token({ aud: 'orders' }))));
    expectAccepted(await through(orders, bearer(await token({ aud: ['billing', 'orders'] }))));
    expectRefused(await through(orders, bearer(await token({ aud: ['billing'] }))), 'token audience not accepted');
    expectRefused(await through(orders, bearer(await token({ aud: 'Orders' }))), 'token audience not accepted');
    expectRefused(await through(orders, bearer(await token({}))), 'token audience not accepted');
    expectRefused(await through(orders, bearer(await token({ aud: ['orders', 7] }))), 'token claims malformed');
    const unconfigured = JwtAuth(rs256());
    expectRefused(await through(unconfigured, bearer(await token({ aud: 'orders' }))), 'token audience not accepted');
    expectRefused(await through(unconfigured, bearer(await token({ aud: [] }))), 'token audience not accepted');
    expectAccepted(await through(unconfigured, bearer(await token({}))));
  });

  test('sub and jti, when present, are strings; a payload that is not a JSON object is malformed', async () => {
    expectRefused(await through(JwtAuth(rs256()), bearer(await token({ sub: 12 }))), 'token claims malformed');
    expectRefused(await through(JwtAuth(rs256()), bearer(await token({ jti: { id: 1 } }))), 'token claims malformed');
    const signingInput = `${jsonSegment({ alg: 'RS256', kid: 'rsa-1' })}.${jsonSegment([1, 2, 3])}`;
    const arrayPayload = `${signingInput}.${base64url(await rsaSigner(rsa)(encoder.encode(signingInput)))}`;
    expectRefused(await through(JwtAuth(rs256()), bearer(arrayPayload)), 'token claims malformed');
  });
});

describe('JwtAuth — construction', () => {
  test('algorithms is required, and options that cannot work are refused when the middleware is built', () => {
    expect(() => JwtAuth({} as JwtAuthOptionsType)).toThrow(/algorithms is required/);
    expect(() => JwtAuth(JwtAuthOptions.create())).toThrow(/algorithms is required/);
    expect(() => JwtAuth({ algorithms: ['HS256'] })).toThrow(OptionsError);
    expect(() => JwtAuth({ algorithms: ['RS256'], jwksUrl: 'http://issuer.example/jwks' })).toThrow(/https/);
  });

  test('a configured key that cannot be imported fails every request as a server error — never a pass, never a 401', async () => {
    const middleware = JwtAuth(rs256({ publicKeys: [{ keyId: 'rsa-1', algorithm: 'RS256', key: await pemOf(rsaSmall) }] }));
    const token = await signToken({ alg: 'RS256', kid: 'rsa-1' }, claims(), rsaSigner(rsaSmall));
    for (let i = 0; i < 2; i += 1) {
      const outcome = await through(middleware, bearer(token));
      expect(outcome.reached).toBe(false);
      expect(outcome.thrown).toBeInstanceOf(Error);
      expect(outcome.thrown).not.toBeInstanceOf(HttpError);
      expect(String(outcome.thrown)).toContain('publicKeys[0]');
      expect(String(outcome.thrown)).toContain('2048');
      expect(outcome.response.status).toBe(Status.InternalServerError);
    }
  });
});

describe('JwtAuth — around a websocket() route', () => {
  test('the middleware gates the upgrade: a bad token is the 401 response, a good one proceeds', async () => {
    const socketRoute: Route = {
      kind: 'websocket',
      connect: () => undefined,
      resolvePolicy: () => {
        throw new Error('not resolved in this test');
      },
    };
    const [endpoint] = compile(withMiddleware(JwtAuth(rs256()), socketRoute)) as CompiledWebsocketRoute[];
    const refused = await endpoint!.authorize(requestWith());
    expect(refused?.status).toBe(Status.Unauthorized);
    expect(refused?.headers?.['www-authenticate']).toBe('Bearer realm="actor-ts"');
    const forged = await signToken({ alg: 'RS256', kid: 'rsa-1' }, claims(), rsaSigner(attacker));
    expect((await endpoint!.authorize(bearer(forged)))?.status).toBe(Status.Unauthorized);
    const valid = await signToken({ alg: 'RS256', kid: 'rsa-1' }, claims(), rsaSigner(rsa));
    expect(await endpoint!.authorize(bearer(valid))).toBeNull();
  });
});

describe('JwtAuth — keys from the issuer’s JWK set', () => {
  const hits = new Map<string, number>();
  const sockets = new Set<Socket>();
  let published: Record<string, unknown>[] = [];
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = request.url ?? '';
      hits.set(path, (hits.get(path) ?? 0) + 1);
      if (path.startsWith('/jwks')) {
        response.writeHead(200, { 'content-type': 'application/jwk-set+json' }).end(JSON.stringify({ keys: published }));
      } else if (path.startsWith('/broken')) {
        response.writeHead(500).end('boom');
      } else if (path === '/down') {
        response.writeHead(503).end();
      } else {
        response.writeHead(404).end();
      }
    });
    server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const manualClock = (): Clock & { advance(ms: number): void } => {
    let current = NOW_MS;
    return { now: () => current, advance: (ms: number) => { current += ms; } };
  };

  test('a token is verified with a key from the set', async () => {
    published = [await jwkOf(rsa, { kid: 'rsa-1', alg: 'RS256', use: 'sig' })];
    const middleware = JwtAuth({ algorithms: ['RS256'], jwksUrl: `${base}/jwks-basic`, clock: fixedClock });
    expectAccepted(await through(middleware, bearer(await signToken({ alg: 'RS256', kid: 'rsa-1' }, claims(), rsaSigner(rsa)))));
    expectRefused(await through(middleware, bearer(await signToken({ alg: 'RS256', kid: 'rsa-1' }, claims(), rsaSigner(attacker)))), 'token signature invalid');
  });

  test('a rotated key is found by refreshing on its unknown kid', async () => {
    const clock = manualClock();
    published = [await jwkOf(rsa, { kid: 'rsa-1' })];
    const middleware = JwtAuth({ algorithms: ['RS256'], jwksUrl: `${base}/jwks-rotation`, clock });
    expectAccepted(await through(middleware, bearer(await signToken({ alg: 'RS256', kid: 'rsa-1' }, claims(), rsaSigner(rsa)))));
    published = [await jwkOf(rsa, { kid: 'rsa-1' }), await jwkOf(rsaRotated, { kid: 'rsa-2' })];
    clock.advance(30_000);
    expectAccepted(await through(middleware, bearer(await signToken({ alg: 'RS256', kid: 'rsa-2' }, claims(), rsaSigner(rsaRotated)))));
    expect(hits.get('/jwks-rotation')).toBe(2);
  });

  test('an unknown-kid storm costs one fetch per refresh floor', async () => {
    const clock = manualClock();
    published = [await jwkOf(rsa, { kid: 'rsa-1' })];
    const middleware = JwtAuth({ algorithms: ['RS256'], jwksUrl: `${base}/jwks-storm`, clock });
    expectAccepted(await through(middleware, bearer(await signToken({ alg: 'RS256', kid: 'rsa-1' }, claims(), rsaSigner(rsa)))));
    const storm = async (prefix: string): Promise<Outcome[]> => Promise.all(Array.from({ length: 40 }, async (_, i) =>
      through(middleware, bearer(await signToken({ alg: 'RS256', kid: `${prefix}-${i}` }, claims(), rsaSigner(attacker))))));
    for (const outcome of await storm('inside')) expectRefused(outcome, 'no key verifies this token');
    expect(hits.get('/jwks-storm')).toBe(1);
    clock.advance(30_000);
    for (const outcome of await storm('after')) expectRefused(outcome, 'no key verifies this token');
    expect(hits.get('/jwks-storm')).toBe(2);
  });

  test('an unreachable key set is 503, not 401 — and a token refused before any key is needed is still 401', async () => {
    const middleware = JwtAuth({ algorithms: ['RS256'], jwksUrl: `${base}/down`, clock: fixedClock });
    const outcome = await through(middleware, bearer(await signToken({ alg: 'RS256', kid: 'rsa-1' }, claims(), rsaSigner(rsa))));
    expect(outcome.response.status).toBe(Status.ServiceUnavailable);
    expect(outcome.reached).toBe(false);
    expect(errorOf(outcome)).toBe('token key set unavailable');
    expect(outcome.response.headers?.['www-authenticate']).toBeUndefined();
    const unsigned = `${jsonSegment({ alg: 'none' })}.${jsonSegment(claims())}.c2ln`;
    expectRefused(await through(middleware, bearer(unsigned)), 'token algorithm not accepted');
  });

  test('a jku in the token is never fetched — only the configured set is', async () => {
    published = [await jwkOf(rsa, { kid: 'rsa-1' })];
    const middleware = JwtAuth({ algorithms: ['RS256'], jwksUrl: `${base}/jwks-configured`, clock: fixedClock });
    const token = await signToken({ alg: 'RS256', kid: 'attacker-1', jku: `${base}/attacker-jwks` }, claims(), rsaSigner(attacker));
    expectRefused(await through(middleware, bearer(token)), 'no key verifies this token');
    expect(hits.get('/attacker-jwks')).toBeUndefined();
    expect(hits.get('/jwks-configured')).toBe(1);
  });

  // A JWK set never yields an HMAC key, so an HS256 token has nothing to ask
  // it: it is answered from the configured secrets alone, and the set's
  // outage must not reach it.
  const hs256BesideBrokenSet = (path: string): Middleware => JwtAuth({
    algorithms: ['RS256', 'HS256'],
    secrets: [{ keyId: 'hmac-1', secret: SECRET }],
    jwksUrl: `${base}${path}`,
    clock: fixedClock,
  });
  const signedWithSecret = (header: Record<string, unknown>): Promise<string> =>
    signToken(header, claims(), hmacSigner(encoder.encode(SECRET)));

  test('a kid-less HS256 token is verified with the one secret, without a fetch, while the set answers 500', async () => {
    const middleware = hs256BesideBrokenSet('/broken-hs256-unnamed');
    expectAccepted(await through(middleware, bearer(await signedWithSecret({ alg: 'HS256' }))));
    expect(hits.get('/broken-hs256-unnamed')).toBeUndefined();
  });

  test('an HS256 token naming an unknown key is 401, without a fetch, while the set answers 500', async () => {
    const middleware = hs256BesideBrokenSet('/broken-hs256-unknown');
    expectRefused(await through(middleware, bearer(await signedWithSecret({ alg: 'HS256', kid: 'unknown' }))), 'no key verifies this token');
    expectAccepted(await through(middleware, bearer(await signedWithSecret({ alg: 'HS256', kid: 'hmac-1' }))));
    expect(hits.get('/broken-hs256-unknown')).toBeUndefined();
    // An RS256 token beside it does need the set: that one is 503, and fetches.
    const outcome = await through(middleware, bearer(await signToken({ alg: 'RS256', kid: 'rsa-1' }, claims(), rsaSigner(rsa))));
    expect(outcome.response.status).toBe(Status.ServiceUnavailable);
    expect(hits.get('/broken-hs256-unknown')).toBe(1);
  });
});
