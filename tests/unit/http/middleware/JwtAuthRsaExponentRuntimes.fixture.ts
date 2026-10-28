/**
 * Bundled by `JwtAuthRsaExponentRuntimes.test.ts` and run under Bun, Node and
 * Deno: on whatever WebCrypto this runtime has, an RSA key with public
 * exponent 1 must never verify a token (#810).  Prints one JSON line — what
 * each route a key can take answered for the same forged token.
 *
 * The forgery needs no private key.  RSA verification raises the signature to
 * the public exponent, so under an exponent of 1 the signature that verifies
 * is the EMSA-PKCS1-v1_5 encoding of the token's own hash, computed below.
 * The key material is generated here and never leaves the process.
 */
import { JwtAuth } from '../../../../src/http/middleware/JwtAuth.js';
import type { Middleware } from '../../../../src/http/Route.js';
import type { HttpRequest } from '../../../../src/http/Types.js';
import { NoopLogger } from '../../../../src/Logger.js';

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const NOW_MS = 1_800_000_000_000;
const clock = { now: (): number => NOW_MS };
const logger = new NoopLogger();

const base64url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};
const bytesOf = (value: string): Uint8Array => Uint8Array.from(
  atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4)),
  (character) => character.charCodeAt(0),
);
const segment = (value: unknown): string => base64url(encoder.encode(JSON.stringify(value)));

/** A DER element: tag, length, content. */
const element = (tag: number, content: readonly number[]): number[] => {
  const size = content.length;
  const length = size < 0x80 ? [size] : size < 0x100 ? [0x81, size] : [0x82, size >> 8, size & 0xff];
  return [tag, ...length, ...content];
};
const derInteger = (value: Uint8Array): number[] => element(0x02, value[0]! & 0x80 ? [0, ...value] : [...value]);

/**
 * The SubjectPublicKeyInfo PEM of an RSA key, encoded here: a WebCrypto that
 * refuses the exponent could not be asked to export it.
 */
const rsaPem = (modulus: Uint8Array, exponent: Uint8Array): string => {
  const rsaEncryption = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const publicKey = element(0x30, [...derInteger(modulus), ...derInteger(exponent)]);
  const der = element(0x30, [...rsaEncryption, ...element(0x03, [0x00, ...publicKey])]);
  const base64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN PUBLIC KEY-----\n${base64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
};

/** EMSA-PKCS1-v1_5 with SHA-256 (RFC 8017 §9.2) of `input`, for a 2048-bit modulus. */
const pkcs1Encoding = async (input: Uint8Array): Promise<Uint8Array> => {
  const digestInfo = [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20];
  const tail = [...digestInfo, ...new Uint8Array(await subtle.digest('SHA-256', input as BufferSource))];
  const encoded = new Uint8Array(256).fill(0xff);
  encoded[0] = 0x00;
  encoded[1] = 0x01;
  encoded[256 - tail.length - 1] = 0x00;
  encoded.set(tail, 256 - tail.length);
  return encoded;
};

/** What a client would see: `200` when the handler was reached, else the status and the error. */
const answer = async (middleware: Middleware, token: string): Promise<string> => {
  const request: HttpRequest = { method: 'GET', path: '/', headers: { authorization: `Bearer ${token}` }, query: {}, params: {}, body: null };
  try {
    return String((await middleware(request, async () => ({ status: 200 }))).status);
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    return `${typeof status === 'number' ? status : 500} ${error instanceof Error ? error.message : String(error)}`;
  }
};

const pair = await subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
) as CryptoKeyPair;
const modulus = (await subtle.exportKey('jwk', pair.publicKey)).n!;
const exponentOne = { kty: 'RSA', n: modulus, e: 'AQ' };
const signingInput = `${segment({ alg: 'RS256', kid: 'e-1' })}.${segment({ sub: 'admin', exp: NOW_MS / 1000 + 600 })}`;
const signature = await pkcs1Encoding(encoder.encode(signingInput));
const forged = `${signingInput}.${base64url(signature)}`;
const result: Record<string, string> = {};

// For the record, not for the verdict: what this runtime's own WebCrypto
// makes of the forgery with such a key.
try {
  const key = await subtle.importKey('jwk', exponentOne, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const verifies = await subtle.verify('RSASSA-PKCS1-v1_5', key, signature as BufferSource, encoder.encode(signingInput));
  result['webCrypto'] = verifies ? 'verifies the forgery' : 'refuses the forgery';
} catch (error) {
  result['webCrypto'] = `throws ${error instanceof Error ? error.name : String(error)}`;
}

// A configured JWK: refused when the middleware is built, by its field.
try {
  JwtAuth({ algorithms: ['RS256'], publicKeys: [{ keyId: 'e-1', algorithm: 'RS256', key: exponentOne }], clock, logger });
  result['configuredJwk'] = 'built';
} catch (error) {
  result['configuredJwk'] = `${error instanceof Error ? error.name : String(error)} ${String((error as { field?: unknown }).field)}`;
}

// A configured PEM key: the validator cannot see its exponent, so the import refuses it.
const pem = rsaPem(bytesOf(modulus), new Uint8Array([1]));
result['configuredPem'] = await answer(
  JwtAuth({ algorithms: ['RS256'], publicKeys: [{ keyId: 'e-1', algorithm: 'RS256', key: pem }], clock, logger }),
  forged,
);

// A JWK-set entry: skipped, so the forged token names a key nobody holds.  The
// set is served by a fetch of our own — no socket, so nothing outlives the run.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(
  JSON.stringify({ keys: [{ ...exponentOne, kid: 'e-1', alg: 'RS256', use: 'sig' }] }),
  { status: 200, headers: { 'content-type': 'application/json' } },
)) as unknown as typeof fetch;
try {
  result['keySetEntry'] = await answer(JwtAuth({ algorithms: ['RS256'], jwksUrl: 'https://issuer.example/jwks', clock, logger }), forged);
} finally {
  globalThis.fetch = realFetch;
}

console.log(JSON.stringify(result));
