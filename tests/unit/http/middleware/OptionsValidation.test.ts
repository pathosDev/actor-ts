import { describe, expect, test } from 'bun:test';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import { TimeoutOptionsValidator } from '../../../../src/http/middleware/TimeoutOptions.js';
import { HstsOptionsValidator } from '../../../../src/http/middleware/HstsOptions.js';
import { CorsOptionsValidator } from '../../../../src/http/middleware/CorsOptions.js';
import { CsrfOptionsValidator, SameOriginOptionsValidator } from '../../../../src/http/middleware/CsrfOptions.js';
import { IpAllowlistOptionsValidator } from '../../../../src/http/middleware/IpAllowlistOptions.js';
import { StaticFilesOptionsValidator } from '../../../../src/http/static/StaticFilesOptions.js';
import { RateLimitOptions, RateLimitOptionsValidator } from '../../../../src/http/cache/RateLimitOptions.js';
import { IdempotencyOptions, IdempotencyOptionsValidator } from '../../../../src/http/cache/IdempotencyOptions.js';
import {
  JwtAuthOptions,
  JwtAuthOptionsValidator,
  type JwtAuthOptionsType,
} from '../../../../src/http/middleware/JwtAuthOptions.js';
import { systemClock } from '../../../../src/Clock.js';

// WP7 — the HTTP middleware / directive options merged after the options-
// validator sweep and were only checked with ad-hoc bare `Error`s (or not at
// all). They now validate through OptionsValidator, throwing OptionsError.
describe('HTTP middleware option validators', () => {
  test('TimeoutOptions.deadlineMs must be a positive finite number', () => {
    const validator = new TimeoutOptionsValidator();
    expect(() => validator.validate({ deadlineMs: 0 })).toThrow(OptionsError);
    expect(() => validator.validate({ deadlineMs: -1 })).toThrow(/deadlineMs/);
    expect(() => validator.validate({ deadlineMs: Number.NaN })).toThrow(/deadlineMs/);
    expect(() => validator.validate({ deadlineMs: 30_000 })).not.toThrow();
    expect(() => validator.validate({})).not.toThrow();   // unset → default later
  });

  test('HstsOptions: maxAge non-negative + preload cross-field', () => {
    const validator = new HstsOptionsValidator();
    expect(() => validator.validate({ maxAge: -1 })).toThrow(OptionsError);
    // preload requires maxAge >= 1 year AND includeSubDomains
    expect(() => validator.validate({ preload: true, maxAge: 100, includeSubDomains: true })).toThrow(/preload/);
    expect(() => validator.validate({ preload: true, maxAge: 31_536_000, includeSubDomains: false })).toThrow(/preload/);
    expect(() => validator.validate({ preload: true, maxAge: 31_536_000, includeSubDomains: true })).not.toThrow();
    expect(() => validator.validate({ preload: false, maxAge: 0 })).not.toThrow();
  });

  test('HstsOptions: maxAge is a whole number of seconds a header can carry as digits (#1462)', () => {
    // RFC 6797 writes max-age as delta-seconds — digits only — and a browser
    // ignores a header it cannot parse, so `max-age=1.5` and `max-age=1e+21`
    // switched HSTS off while looking configured.  Both are refused instead.
    const validator = new HstsOptionsValidator();
    expect(() => validator.validate({ maxAge: 1.5 })).toThrow(OptionsError);
    expect(() => validator.validate({ maxAge: 1.5 })).toThrow(/maxAge/);
    expect(() => validator.validate({ maxAge: 1e21 })).toThrow(OptionsError);
    // The bound is exact: the largest safe integer is the last one a double
    // holds exactly, and the refusal says that rather than blaming exponent
    // form, which only starts at 1e21.
    expect(() => validator.validate({ maxAge: Number.MAX_SAFE_INTEGER })).not.toThrow();
    expect(() => validator.validate({ maxAge: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/maxAge/);
    expect(() => validator.validate({ maxAge: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/exactly/);
  });

  test('CorsOptions: maxAge non-negative + credentials forbidden with "*"', () => {
    const validator = new CorsOptionsValidator();
    expect(() => validator.validate({ maxAge: -5 })).toThrow(/maxAge/);
    expect(() => validator.validate({ credentials: true, origins: '*' })).toThrow(OptionsError);
    expect(() => validator.validate({ credentials: true, origins: ['https://app.example.com'] })).not.toThrow();
    expect(() => validator.validate({ credentials: false, origins: '*', maxAge: 600 })).not.toThrow();
  });

  test('CorsOptions: maxAge is a whole number of seconds, as Access-Control-Max-Age requires', () => {
    // The header is delta-seconds — digits only. `1.5` would go out as
    // `Access-Control-Max-Age: 1.5`, which browsers ignore, so preflight
    // caching is silently off while the code looks configured. The HOCON path
    // already refuses a fraction through getInt; the code path must too.
    const validator = new CorsOptionsValidator();
    expect(() => validator.validate({ maxAge: 1.5 })).toThrow(/maxAge/);
    expect(() => validator.validate({ maxAge: 0 })).not.toThrow();
    expect(() => validator.validate({ maxAge: 86_400 })).not.toThrow();
  });

  test('CsrfOptions: present secret >= 16 bytes + cookie enums', () => {
    const validator = new CsrfOptionsValidator();
    expect(() => validator.validate({ secret: 'too-short' })).toThrow(/secret/);
    expect(() => validator.validate({ secret: 'x'.repeat(32) })).not.toThrow();
    expect(() => validator.validate({ secret: new Uint8Array(8) })).toThrow(OptionsError);
    expect(() => validator.validate({ secret: new Uint8Array(32) })).not.toThrow();
    expect(() => validator.validate({ secret: 'x'.repeat(16), cookie: { sameSite: 'bogus' as never } })).toThrow(/sameSite/);
    expect(() => validator.validate({ secret: 'x'.repeat(16), cookie: { maxAgeSeconds: -1 } })).toThrow(/maxAgeSeconds/);
    expect(() => validator.validate({})).not.toThrow();   // missing secret is a required-field concern, not this validator's
  });

  // #604 — allowedOrigins are compared as whole origins, so an entry that is
  // not one (a bare host, a wildcard) can never match: fail at construction
  // rather than silently letting the allowlist do nothing.
  test('CsrfOptions: allowedOrigins entries are full origins + expectedScheme enum', () => {
    const validator = new CsrfOptionsValidator();
    expect(() => validator.validate({ allowedOrigins: ['app.example'] })).toThrow(OptionsError);
    expect(() => validator.validate({ allowedOrigins: ['https://app.example', '*'] })).toThrow(/allowedOrigins/);
    expect(() => validator.validate({ allowedOrigins: ['https://app.example', 'https://b.example:8443'] })).not.toThrow();
    expect(() => validator.validate({ expectedScheme: 'ftp' as never })).toThrow(/expectedScheme/);
    expect(() => validator.validate({ expectedScheme: 'http' })).not.toThrow();
  });

  // #605 — the __Host- default has attribute preconditions.  Checking them
  // here turns a per-request 500 (serializeCookie throws while the response
  // is built) into an error when the middleware is wired.
  test('CsrfOptions: the default __Host- cookie name constrains the attributes', () => {
    const validator = new CsrfOptionsValidator();
    expect(() => validator.validate({ cookie: { secure: false } })).toThrow(/cookie\.secure/);
    expect(() => validator.validate({ cookie: { path: '/app' } })).toThrow(/cookie\.path/);
    expect(() => validator.validate({ cookie: { domain: 'app.example' } })).toThrow(OptionsError);
    expect(() => validator.validate({ cookie: { secure: true, path: '/' } })).not.toThrow();
    // Opting out of the prefix lifts all three.
    const unprefixed = { cookieName: 'csrf-token', cookie: { secure: false, path: '/app', domain: 'app.example' } };
    expect(() => validator.validate(unprefixed)).not.toThrow();
    // __Secure- carries the Secure requirement alone.
    expect(() => validator.validate({ cookieName: '__Secure-csrf', cookie: { secure: false } })).toThrow(/cookie\.secure/);
    expect(() => validator.validate({ cookieName: '__Secure-csrf', cookie: { path: '/app' } })).not.toThrow();
    expect(() => validator.validate({ cookieName: '' })).toThrow(/cookieName/);
  });

  test('SameOriginOptions: the same two rules', () => {
    const validator = new SameOriginOptionsValidator();
    expect(() => validator.validate({ allowedOrigins: ['app.example'] })).toThrow(/allowedOrigins/);
    expect(() => validator.validate({ expectedScheme: 'ftp' as never })).toThrow(OptionsError);
    expect(() => validator.validate({ allowedOrigins: ['https://app.example'], expectedScheme: 'https' })).not.toThrow();
    expect(() => validator.validate({})).not.toThrow();
  });

  // #715 — this validator exists for the mistakes that would otherwise be
  // *silent*: an allowlist that reads as proxy-aware and filters nothing.
  // CIDR syntax stays with `parseCidr`, which names the bad entry.
  test('IpAllowlistOptions: no silently-inert forwarded-header configuration', () => {
    const validator = new IpAllowlistOptionsValidator();
    expect(() => validator.validate({ trustedProxies: [] })).toThrow(/trustedProxies/);
    expect(() => validator.validate({ forwardedHeader: 'cf-connecting-ip' })).toThrow(/forwardedHeader/);
    expect(() => validator.validate({ trustedProxies: ['10.9.9.0/24'], forwardedHeader: '' })).toThrow(OptionsError);
    expect(() => validator.validate({
      trustedProxies: ['10.9.9.0/24'],
      getClientIp: (request) => request.remoteAddress,
    })).toThrow(/getClientIp/);
    // The two supported shapes, and the unset case.
    expect(() => validator.validate({ allow: ['10.0.0.0/8'], trustedProxies: ['10.9.9.0/24'] })).not.toThrow();
    expect(() => validator.validate({ allow: ['10.0.0.0/8'], getClientIp: (r) => r.remoteAddress })).not.toThrow();
    expect(() => validator.validate({})).not.toThrow();
  });

  test('StaticFilesOptions: maxFileSize positive int + policy enums', () => {
    const validator = new StaticFilesOptionsValidator();
    expect(() => validator.validate({ maxFileSize: 0 })).toThrow(/maxFileSize/);
    expect(() => validator.validate({ maxFileSize: 2.5 })).toThrow(OptionsError);
    expect(() => validator.validate({ dotfiles: 'nope' as never })).toThrow(/dotfiles/);
    expect(() => validator.validate({ symlinks: 'maybe' as never })).toThrow(/symlinks/);
    expect(() => validator.validate({ maxFileSize: 1_048_576, dotfiles: 'allow', symlinks: 'follow' })).not.toThrow();
  });
});

describe('rateLimit / idempotent option builders + validators', () => {
  test('RateLimitOptions builder feeds the same fields as a plain object', () => {
    const built = RateLimitOptions.create().withWindowMs(60_000).withMax(100).withKeyPrefix('rl:');
    expect({ ...built }).toMatchObject({ windowMs: 60_000, max: 100, keyPrefix: 'rl:' });
    const validator = new RateLimitOptionsValidator();
    expect(() => validator.validate({ ...built })).not.toThrow();
    expect(() => validator.validate({ windowMs: 0, max: 100 })).toThrow(/windowMs/);
    expect(() => validator.validate({ windowMs: 60_000, max: 0 })).toThrow(OptionsError);
    expect(() => validator.validate({ windowMs: 60_000, max: -1 })).toThrow(/max/);
  });

  test('IdempotencyOptions builder + validator', () => {
    const built = IdempotencyOptions.create().withTtlMs(3_600_000).withMissingHeader('pass-through');
    expect({ ...built }).toMatchObject({ ttlMs: 3_600_000, missingHeader: 'pass-through' });
    const validator = new IdempotencyOptionsValidator();
    expect(() => validator.validate({ ...built })).not.toThrow();
    expect(() => validator.validate({ ttlMs: 0 })).toThrow(/ttlMs/);
    expect(() => validator.validate({ missingHeader: 'bogus' as never })).toThrow(/missingHeader/);
  });
});

// #810 — JwtAuth refuses a token with the same 401 whether it is forged or
// the configuration can never verify anything, so every configuration that
// cannot work is refused here, by name, before the first request.
describe('JwtAuthOptions validator', () => {
  const SECRET = 's'.repeat(32);
  const PEM = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n';
  const RSA_JWK = { kty: 'RSA', n: 'sXchDaQebHnPiGvyDOAT4saGEUetSyo9MKLOoWFsueri', e: 'AQAB' };
  const EC_JWK = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' };
  const validator = new JwtAuthOptionsValidator();
  const hs256 = (extra: Partial<JwtAuthOptionsType> = {}): Partial<JwtAuthOptionsType> => ({
    algorithms: ['HS256'], secrets: [{ secret: SECRET }], ...extra,
  });

  test('algorithms is a non-empty list of RS256, ES256 and HS256 — none is not one in any spelling', () => {
    expect(() => validator.validate(hs256())).not.toThrow();
    expect(() => validator.validate(hs256({ algorithms: [] }))).toThrow(/algorithms/);
    for (const unsupported of ['none', 'None', 'NONE', 'HS512', 'RS512', 'PS256', 'rs256']) {
      expect(() => validator.validate(hs256({ algorithms: ['HS256', unsupported as never] }))).toThrow(OptionsError);
      expect(() => validator.validate(hs256({ algorithms: ['HS256', unsupported as never] }))).toThrow(/algorithms\[1\]/);
    }
  });

  test('every allowed algorithm has a key that can verify it, and every key an allowed algorithm', () => {
    // HS256 with no secret: a JWK set never supplies an HMAC key.
    expect(() => validator.validate({ algorithms: ['HS256'], jwksUrl: 'https://issuer.example/jwks' })).toThrow(/HS256/);
    // A secret HS256 is not allowed for.
    expect(() => validator.validate({ algorithms: ['RS256'], jwksUrl: 'https://issuer.example/jwks', secrets: [{ secret: SECRET }] })).toThrow(/secrets/);
    // RS256 / ES256 with neither a public key of that algorithm nor a JWK set.
    expect(() => validator.validate({ algorithms: ['RS256'] })).toThrow(/RS256/);
    expect(() => validator.validate({ algorithms: ['RS256', 'ES256'], publicKeys: [{ algorithm: 'RS256', key: RSA_JWK }] })).toThrow(/allows ES256/);
    // A public key whose algorithm is not allowed.
    expect(() => validator.validate({ algorithms: ['RS256'], publicKeys: [{ algorithm: 'RS256', key: RSA_JWK }, { algorithm: 'ES256', key: EC_JWK }] }))
      .toThrow(/publicKeys\[1\]\.algorithm/);
    // The shapes that work.
    expect(() => validator.validate({ algorithms: ['RS256'], publicKeys: [{ algorithm: 'RS256', key: PEM }] })).not.toThrow();
    expect(() => validator.validate({ algorithms: ['RS256', 'ES256'], jwksUrl: 'https://issuer.example/jwks' })).not.toThrow();
    expect(() => validator.validate({ algorithms: ['ES256', 'HS256'], publicKeys: [{ algorithm: 'ES256', key: EC_JWK }], secrets: [{ secret: SECRET }] }))
      .not.toThrow();
  });

  test('an HS256 secret is at least 32 bytes and never a PEM block', () => {
    expect(() => validator.validate(hs256({ secrets: [{ secret: 's'.repeat(31) }] }))).toThrow(/secrets\[0\]\.secret/);
    expect(() => validator.validate(hs256({ secrets: [{ secret: new Uint8Array(31) }] }))).toThrow(/32 bytes/);
    expect(() => validator.validate(hs256({ secrets: [{ secret: new Uint8Array(32) }] }))).not.toThrow();
    // Bytes, not characters: 16 two-byte characters are 32 bytes.
    expect(() => validator.validate(hs256({ secrets: [{ secret: 'é'.repeat(16) }] }))).not.toThrow();
    // The public key configured as an HMAC secret is the RS256-to-HS256
    // confusion, written down by the operator instead of chosen by the token.
    expect(() => validator.validate(hs256({ secrets: [{ secret: PEM }] }))).toThrow(/PEM/);
    expect(() => validator.validate(hs256({ secrets: [{ secret: new TextEncoder().encode(PEM) }] }))).toThrow(/PEM/);
    // The secret itself never appears in the message.
    expect(() => validator.validate(hs256({ secrets: [{ secret: 'short-secret' }] }))).not.toThrow(/short-secret/);
    expect(() => validator.validate(hs256({ secrets: [] }))).toThrow(/secrets/);
  });

  test('a public key is a JWK of the bound type or a PUBLIC KEY block, and never private material', () => {
    const rs256 = (key: unknown): Partial<JwtAuthOptionsType> => ({ algorithms: ['RS256'], publicKeys: [{ algorithm: 'RS256', key: key as never }] });
    const es256 = (key: unknown): Partial<JwtAuthOptionsType> => ({ algorithms: ['ES256'], publicKeys: [{ algorithm: 'ES256', key: key as never }] });
    expect(() => validator.validate(rs256(RSA_JWK))).not.toThrow();
    expect(() => validator.validate(es256(EC_JWK))).not.toThrow();
    expect(() => validator.validate(rs256(EC_JWK))).toThrow(/kty/);
    expect(() => validator.validate(es256(RSA_JWK))).toThrow(/kty/);
    expect(() => validator.validate(es256({ ...EC_JWK, crv: 'P-384' }))).toThrow(/crv/);
    expect(() => validator.validate(rs256({ ...RSA_JWK, alg: 'RS512' }))).toThrow(/alg/);
    expect(() => validator.validate(rs256({ ...RSA_JWK, use: 'enc' }))).toThrow(/use/);
    expect(() => validator.validate(rs256({ ...RSA_JWK, key_ops: ['encrypt'] }))).toThrow(/key_ops/);
    expect(() => validator.validate(rs256({ ...RSA_JWK, alg: 'RS256', use: 'sig', key_ops: ['verify'] }))).not.toThrow();
    expect(() => validator.validate(rs256({ ...RSA_JWK, d: 'private' }))).toThrow(/private key material \(d\)/);
    expect(() => validator.validate(es256({ ...EC_JWK, d: 'private' }))).toThrow(/private/);
    expect(() => validator.validate(rs256(PEM.replace(/PUBLIC KEY/g, 'RSA PUBLIC KEY')))).toThrow(/PKCS#1/);
    expect(() => validator.validate(rs256(PEM.replace(/PUBLIC KEY/g, 'CERTIFICATE')))).toThrow(/certificate/);
    expect(() => validator.validate(rs256(PEM.replace(/PUBLIC KEY/g, 'PRIVATE KEY')))).toThrow(/private key/);
    expect(() => validator.validate(rs256('not a key'))).toThrow(/PUBLIC KEY/);
    expect(() => validator.validate({ algorithms: ['RS256'], publicKeys: [{ algorithm: 'HS256' as never, key: RSA_JWK }] })).toThrow(/secrets/);
  });

  test('key ids name one key each, across publicKeys and secrets, the JWK kid included', () => {
    expect(() => validator.validate({
      algorithms: ['RS256', 'HS256'],
      publicKeys: [{ keyId: 'a', algorithm: 'RS256', key: RSA_JWK }],
      secrets: [{ keyId: 'a', secret: SECRET }],
    })).toThrow(/keyId/);
    expect(() => validator.validate({
      algorithms: ['RS256'],
      publicKeys: [{ algorithm: 'RS256', key: { ...RSA_JWK, kid: 'a' } }, { keyId: 'a', algorithm: 'RS256', key: PEM }],
    })).toThrow(/keyId/);
    expect(() => validator.validate({
      algorithms: ['RS256'],
      publicKeys: [{ keyId: 'b', algorithm: 'RS256', key: { ...RSA_JWK, kid: 'a' } }],
    })).toThrow(/differs/);
    expect(() => validator.validate(hs256({ secrets: [{ keyId: '', secret: SECRET }] }))).toThrow(/keyId/);
    expect(() => validator.validate({
      algorithms: ['RS256', 'HS256'],
      publicKeys: [{ keyId: 'a', algorithm: 'RS256', key: RSA_JWK }],
      secrets: [{ keyId: 'b', secret: SECRET }, { secret: SECRET }],
    })).not.toThrow();
  });

  test('jwksUrl is https:, or plain http: to a loopback host only', () => {
    const jwks = (jwksUrl: string): Partial<JwtAuthOptionsType> => ({ algorithms: ['RS256'], jwksUrl });
    expect(() => validator.validate(jwks('https://issuer.example/.well-known/jwks.json'))).not.toThrow();
    expect(() => validator.validate(jwks('http://issuer.example/.well-known/jwks.json'))).toThrow(/https/);
    expect(() => validator.validate(jwks('http://10.0.0.5/jwks'))).toThrow(/jwksUrl/);
    for (const loopback of ['http://localhost:8080/jwks', 'http://127.0.0.1:9000/jwks', 'http://127.1.2.3/jwks', 'http://[::1]:8443/jwks']) {
      expect(() => validator.validate(jwks(loopback))).not.toThrow();
    }
    expect(() => validator.validate(jwks('ftp://issuer.example/jwks'))).toThrow(/jwksUrl/);
    expect(() => validator.validate(jwks('not a url'))).toThrow(/jwksUrl/);
    // A host that only starts like loopback is not loopback.
    expect(() => validator.validate(jwks('http://localhost.attacker.example/jwks'))).toThrow(/https/);
  });

  test('the key-set bounds: a deadline in (0, 60 s], a positive integer cap, a refresh floor within the cache lifetime', () => {
    const jwks = (extra: Partial<JwtAuthOptionsType>): Partial<JwtAuthOptionsType> => ({ algorithms: ['RS256'], jwksUrl: 'https://issuer.example/jwks', ...extra });
    // 0 is what HttpClient reads as "no deadline", so it must not get through.
    expect(() => validator.validate(jwks({ jwksTimeoutMs: 0 }))).toThrow(/jwksTimeoutMs/);
    expect(() => validator.validate(jwks({ jwksTimeoutMs: Number.NaN }))).toThrow(/jwksTimeoutMs/);
    expect(() => validator.validate(jwks({ jwksTimeoutMs: 60_001 }))).toThrow(/jwksTimeoutMs/);
    expect(() => validator.validate(jwks({ jwksTimeoutMs: 60_000 }))).not.toThrow();
    expect(() => validator.validate(jwks({ jwksMaxResponseBytes: 0 }))).toThrow(/jwksMaxResponseBytes/);
    expect(() => validator.validate(jwks({ jwksMaxResponseBytes: 1.5 }))).toThrow(/jwksMaxResponseBytes/);
    expect(() => validator.validate(jwks({ jwksCacheTtlMs: 0 }))).toThrow(/jwksCacheTtlMs/);
    expect(() => validator.validate(jwks({ jwksMinRefreshIntervalMs: 0 }))).toThrow(/jwksMinRefreshIntervalMs/);
    expect(() => validator.validate(jwks({ jwksCacheTtlMs: 10_000, jwksMinRefreshIntervalMs: 10_001 }))).toThrow(/jwksMinRefreshIntervalMs/);
    expect(() => validator.validate(jwks({ jwksCacheTtlMs: 10_000, jwksMinRefreshIntervalMs: 10_000 }))).not.toThrow();
  });

  test('clockSkewMs within [0, 5 min], maxTokenBytes a positive integer, realm safe inside a quoted header value', () => {
    expect(() => validator.validate(hs256({ clockSkewMs: 0 }))).not.toThrow();
    expect(() => validator.validate(hs256({ clockSkewMs: 300_000 }))).not.toThrow();
    expect(() => validator.validate(hs256({ clockSkewMs: 300_001 }))).toThrow(/clockSkewMs/);
    expect(() => validator.validate(hs256({ clockSkewMs: -1 }))).toThrow(/clockSkewMs/);
    expect(() => validator.validate(hs256({ maxTokenBytes: 0 }))).toThrow(/maxTokenBytes/);
    expect(() => validator.validate(hs256({ maxTokenBytes: 100.5 }))).toThrow(/maxTokenBytes/);
    expect(() => validator.validate(hs256({ realm: 'orders api' }))).not.toThrow();
    for (const unsafe of ['', 'say "hi"', 'back\\slash', 'line\r\nbreak', 'tab\there', 'ümlaut']) {
      expect(() => validator.validate(hs256({ realm: unsafe }))).toThrow(/realm/);
    }
  });

  test('issuer and audience are a non-empty string or a non-empty list of them', () => {
    expect(() => validator.validate(hs256({ issuer: 'https://issuer.example/', audience: ['orders', 'billing'] }))).not.toThrow();
    expect(() => validator.validate(hs256({ issuer: '' }))).toThrow(/issuer/);
    expect(() => validator.validate(hs256({ issuer: [] }))).toThrow(/issuer/);
    expect(() => validator.validate(hs256({ audience: ['orders', ''] }))).toThrow(/audience/);
    expect(() => validator.validate(hs256({ audience: [] }))).toThrow(/audience/);
  });

  test('the builder sets every field it names', () => {
    const builder = JwtAuthOptions.create()
      .withAlgorithms('RS256', 'HS256')
      .withIssuer('https://issuer.example/')
      .withAudience('orders', 'billing')
      .withClockSkewMs(5_000)
      .withPublicKeys({ algorithm: 'RS256', key: RSA_JWK })
      .withSecrets({ keyId: 'v1', secret: SECRET })
      .withJwksUrl('https://issuer.example/jwks')
      .withJwksTimeoutMs(2_000)
      .withJwksMaxResponseBytes(32_768)
      .withJwksCacheTtlMs(300_000)
      .withJwksMinRefreshIntervalMs(10_000)
      .withMaxTokenBytes(4_096)
      .withRealm('orders')
      .withClock(systemClock);
    expect({ ...builder }).toEqual({
      algorithms: ['RS256', 'HS256'],
      issuer: ['https://issuer.example/'],
      audience: ['orders', 'billing'],
      clockSkewMs: 5_000,
      publicKeys: [{ algorithm: 'RS256', key: RSA_JWK }],
      secrets: [{ keyId: 'v1', secret: SECRET }],
      jwksUrl: 'https://issuer.example/jwks',
      jwksTimeoutMs: 2_000,
      jwksMaxResponseBytes: 32_768,
      jwksCacheTtlMs: 300_000,
      jwksMinRefreshIntervalMs: 10_000,
      maxTokenBytes: 4_096,
      realm: 'orders',
      clock: systemClock,
    });
    expect(() => validator.validate({ ...builder })).not.toThrow();
  });
});
