/**
 * Smoke case: `JwtAuth` verifies RS256, ES256 and HS256 tokens with WebCrypto
 * on the runtime the user actually runs (#810).
 *
 * `tests/unit/http/middleware/JwtAuth.test.ts` proves the checks under
 * `bun test`, which is Bun only.  The middleware depends on nothing but
 * `globalThis.crypto.subtle`, and that is exactly the part that differs by
 * runtime — key import formats, the ECDSA signature encoding, whether an RSA
 * key refuses to verify an HMAC signature.  So this case signs real tokens
 * with keys generated here, by the same WebCrypto, and runs them through the
 * compiled middleware: three valid tokens must reach the handler with their
 * claims, and the classic forgeries must be refused with a 401 carrying
 * `error="invalid_token"`.
 *
 * Static keys only: no JWK set, so no `HttpClient`, no socket, no timer —
 * nothing that could hold a runtime's event loop open after the case.
 */
export const name = 'jwt webcrypto';
export const description = 'JwtAuth accepts RS256, ES256 and HS256 tokens signed by this runtime\'s WebCrypto and refuses none, HS256-with-the-public-key, a DER ES256 signature, a tampered payload and an expired token';

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const SECRET = 'smoke-secret-of-at-least-32-bytes!';

const base64url = (bytes) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const jsonSegment = (value) => base64url(encoder.encode(JSON.stringify(value)));

const pemOf = async (publicKey) => {
  const der = new Uint8Array(await subtle.exportKey('spki', publicKey));
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  return `-----BEGIN PUBLIC KEY-----\n${btoa(binary).match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;
};

const sign = async (algorithm, key, signingInput) => new Uint8Array(await subtle.sign(algorithm, key, encoder.encode(signingInput)));

const token = async (header, claims, algorithm, key) => {
  const signingInput = `${jsonSegment(header)}.${jsonSegment(claims)}`;
  return `${signingInput}.${base64url(await sign(algorithm, key, signingInput))}`;
};

/** The raw `r || s` ES256 signature as the DER `SEQUENCE` other tooling produces. */
const derOf = (raw) => {
  const integer = (bytes) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const value = [...bytes.slice(start)];
    if (value[0] & 0x80) value.unshift(0);
    return [0x02, value.length, ...value];
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
};

export async function run({ loadEntry }) {
  const {
    JwtAuth, JwtAuthOptions, jwtClaimsOf, compile, completeText, defaultErrorResponse, get, withMiddleware,
  } = await loadEntry('http');

  const rsa = await subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const ec = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const hmac = await subtle.importKey('raw', encoder.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const rsaPem = await pemOf(rsa.publicKey);

  const jwtOptions = JwtAuthOptions.create()
    .withAlgorithms('RS256', 'ES256', 'HS256')
    .withPublicKeys(
      { keyId: 'rsa-1', algorithm: 'RS256', key: rsaPem },
      { keyId: 'ec-1', algorithm: 'ES256', key: await subtle.exportKey('jwk', ec.publicKey) },
    )
    .withSecrets({ keyId: 'hmac-1', secret: SECRET })
    .withAudience('smoke')
    .withClock({ now: () => NOW_MS });

  let reachedWith;
  const [endpoint] = compile(withMiddleware(JwtAuth(jwtOptions), get((request) => {
    reachedWith = jwtClaimsOf(request);
    return completeText(200, 'ok');
  })));

  const call = async (bearer) => {
    reachedWith = undefined;
    const request = {
      method: 'GET', path: '/', headers: { authorization: `Bearer ${bearer}` }, query: {}, params: {}, body: null,
    };
    try {
      return { response: await endpoint.handler(request), claims: reachedWith };
    } catch (error) {
      return { response: defaultErrorResponse(error), claims: reachedWith };
    }
  };

  const claims = { sub: 'smoke-user', aud: 'smoke', exp: NOW + 600 };
  const rsaSigning = { name: 'RSASSA-PKCS1-v1_5' };
  const ecSigning = { name: 'ECDSA', hash: 'SHA-256' };

  const valid = [
    ['RS256', await token({ alg: 'RS256', kid: 'rsa-1' }, claims, rsaSigning, rsa.privateKey)],
    ['ES256', await token({ alg: 'ES256', kid: 'ec-1' }, claims, ecSigning, ec.privateKey)],
    ['HS256', await token({ alg: 'HS256', kid: 'hmac-1' }, claims, 'HMAC', hmac)],
  ];
  for (const [algorithm, bearer] of valid) {
    const { response, claims: seen } = await call(bearer);
    if (response.status !== 200) {
      throw new Error(`a valid ${algorithm} token was refused: ${response.status} ${JSON.stringify(response.body)}`);
    }
    if (seen?.sub !== 'smoke-user') throw new Error(`the handler behind a valid ${algorithm} token did not see its claims`);
  }

  // The forgeries.  Each one is a classic way a JWT verifier has been broken.
  const rsaPublicBytes = new Uint8Array(await subtle.exportKey('spki', rsa.publicKey));
  const confusionKey = await subtle.importKey('raw', rsaPublicBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const esInput = `${jsonSegment({ alg: 'ES256', kid: 'ec-1' })}.${jsonSegment(claims)}`;
  const esRaw = await sign(ecSigning, ec.privateKey, esInput);
  const validRs = valid[0][1].split('.');
  const forgeries = [
    ['alg none', `${jsonSegment({ alg: 'none' })}.${jsonSegment(claims)}.`],
    ['alg None with a signature', `${jsonSegment({ alg: 'None' })}.${jsonSegment(claims)}.c2lnbmF0dXJl`],
    ['HS256 keyed with the RSA public key, naming the RSA key', await token({ alg: 'HS256', kid: 'rsa-1' }, claims, 'HMAC', confusionKey)],
    ['HS256 keyed with the RSA public key, naming no key', await token({ alg: 'HS256' }, claims, 'HMAC', confusionKey)],
    ['a DER-encoded ES256 signature', `${esInput}.${base64url(derOf(esRaw))}`],
    ['a tampered payload', `${validRs[0]}.${jsonSegment({ ...claims, sub: 'admin' })}.${validRs[2]}`],
    ['an expired token', await token({ alg: 'RS256', kid: 'rsa-1' }, { ...claims, exp: NOW - 3600 }, rsaSigning, rsa.privateKey)],
    ['a token for another audience', await token({ alg: 'RS256', kid: 'rsa-1' }, { ...claims, aud: 'elsewhere' }, rsaSigning, rsa.privateKey)],
  ];
  for (const [what, bearer] of forgeries) {
    const { response, claims: seen } = await call(bearer);
    if (response.status !== 401) throw new Error(`${what} was not refused: ${response.status}`);
    if (seen !== undefined) throw new Error(`${what} reached the handler`);
    const challenge = response.headers?.['www-authenticate'] ?? '';
    if (!challenge.includes('error="invalid_token"')) throw new Error(`${what} was refused without error="invalid_token": ${challenge}`);
  }
}
