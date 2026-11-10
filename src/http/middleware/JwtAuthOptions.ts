/**
 * Options for the {@link JwtAuth} middleware (#810).
 *
 * Code-only for now: there is no `actor-ts.http.jwt` block yet, so every
 * value comes from these options or the built-in defaults below.
 *
 *     const jwtOptions = JwtAuthOptions.create()
 *       .withAlgorithms('RS256')
 *       .withIssuer('https://auth.example.com/')
 *       .withAudience('orders-api')
 *       .withJwksUrl('https://auth.example.com/.well-known/jwks.json');
 *     const routes = withMiddleware(JwtAuth(jwtOptions), apiRoutes);
 *
 * Key material comes from two fields that are deliberately separate:
 * `publicKeys` (RS256, ES256) and `secrets` (HS256).  An HMAC secret is the
 * one kind of key an attacker can sign with when it equals something public,
 * which is how the classic RS256-to-HS256 confusion works — so it has a field
 * of its own, a PEM block is refused there, and a JWK set is never read for one.
 */
import type { Clock } from '../../Clock.js';
import type { Logger } from '../../Logger.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

/**
 * A JWS algorithm `JwtAuth` verifies.  The three every issuer offers between
 * them; each binds to exactly one WebCrypto key type, which is what keeps one
 * kind of key from ever being used as another.
 */
export type JwtAlgorithm = 'RS256' | 'ES256' | 'HS256';

/** Every algorithm `JwtAuth` can verify — what `algorithms` chooses from.  `none` is not one. */
const SUPPORTED_ALGORITHMS: readonly JwtAlgorithm[] = ['RS256', 'ES256', 'HS256'];

/**
 * A public key in JSON Web Key form (RFC 7517) — the members `JwtAuth` reads.
 *
 * Declared here rather than borrowed from the DOM library's `JsonWebKey`,
 * which has no `kid` and is not a global outside a DOM build.  Any other
 * member a JWK carries (`x5c`, `x5t`, …) is accepted and ignored.
 */
export type JwtPublicJwk = {
  /** `RSA` for RS256, `EC` for ES256. */
  readonly kty?: string;
  /** Key id; used as the entry's `keyId` when that is unset. */
  readonly kid?: string;
  /** When present, must name the entry's algorithm. */
  readonly alg?: string;
  /** When present, must be `sig`. */
  readonly use?: string;
  /** When present, must include `verify`. */
  readonly key_ops?: readonly string[];
  /** RSA modulus, base64url. */
  readonly n?: string;
  /** RSA public exponent, base64url. */
  readonly e?: string;
  /** EC curve — `P-256` for ES256. */
  readonly crv?: string;
  /** EC point x coordinate, base64url. */
  readonly x?: string;
  /** EC point y coordinate, base64url. */
  readonly y?: string;
  readonly [member: string]: unknown;
};

/** A static public key — RS256 or ES256. */
export type JwtPublicKey = {
  /**
   * Matched against the token header's `kid`.  Optional: a token without a
   * `kid` is verified by the one configured key of its algorithm, and refused
   * when there are several.  Defaults to the JWK's own `kid`.
   */
  readonly keyId?: string;
  /** The one algorithm this key verifies — bound when the key is imported. */
  readonly algorithm: 'RS256' | 'ES256';
  /**
   * The key: a JWK (`kty` RSA, or EC on `P-256`), or a PEM-encoded
   * SubjectPublicKeyInfo — the `-----BEGIN PUBLIC KEY-----` form.  RSA keys
   * must be at least 2048 bits (RFC 7518 §3.3).
   */
  readonly key: JwtPublicJwk | string;
};

/** A static HS256 secret. */
export type JwtSecret = {
  /** Matched against the token header's `kid`, as for {@link JwtPublicKey}. */
  readonly keyId?: string;
  /**
   * The shared secret, at least 32 bytes (RFC 7518 §3.2: no shorter than the
   * hash output).  A string is taken as its UTF-8 bytes.
   */
  readonly secret: string | Uint8Array;
};

/** Built-in tolerance for clock drift between the issuer and this process, 30 s. */
export const DEFAULT_JWT_CLOCK_SKEW_MS = 30_000;

/**
 * Largest clock skew accepted, 5 minutes.  Skew is added to `exp`, so a
 * larger value is an extension of every token's lifetime by that much — at
 * which point the bound is the token's expiry no longer, but this number.
 */
const MAX_JWT_CLOCK_SKEW_MS = 300_000;

/**
 * Largest token accepted, 8 KiB.  An access token carrying a typical claim
 * set is well under 2 KiB; the cap is checked before anything is decoded, so
 * an oversized header costs a length comparison and nothing else.
 */
export const DEFAULT_JWT_MAX_TOKEN_BYTES = 8_192;

/** Realm advertised in `WWW-Authenticate` — the same default as `BearerTokenAuth` and `BasicAuth`. */
export const DEFAULT_JWT_REALM = 'actor-ts';

/**
 * Deadline for one key-set fetch, 5 s — not the `HttpClient` default of 30 s.
 * Every request that needs a key the cache does not hold waits on that fetch,
 * so its deadline is added to their latency; an issuer that has not answered
 * in five seconds is down, and the request is better answered 503 now.
 */
export const DEFAULT_JWKS_TIMEOUT_MS = 5_000;

/** Longest key-set deadline accepted, 60 s — past that the requests waiting on it have given up anyway. */
const MAX_JWKS_TIMEOUT_MS = 60_000;

/**
 * Largest key-set document accepted, 64 KiB — not the `HttpClient` default of
 * 8 MiB.  A key set is a handful of keys; the largest public ones, with an
 * `x5c` certificate chain on every key, stay under 30 KiB.  Whatever the
 * endpoint sends is buffered in this process, so the cap is what keeps a
 * misbehaving issuer from deciding how much heap that is.
 */
export const DEFAULT_JWKS_MAX_RESPONSE_BYTES = 65_536;

/**
 * How long a fetched key set is trusted, 10 minutes.  This is also how long a
 * key the issuer has withdrawn — rotated out, or revoked — keeps verifying
 * here, so it is a security bound as much as a cache setting.
 */
export const DEFAULT_JWKS_CACHE_TTL_MS = 600_000;

/**
 * Least time between two key-set fetches, 30 s.  A token naming a key the
 * cache does not hold triggers a refresh, since that is what an issuer's key
 * rotation looks like from here — and without this floor, a client sending
 * random key ids would turn every request into a fetch against the issuer.
 */
export const DEFAULT_JWKS_MIN_REFRESH_INTERVAL_MS = 30_000;

/** RFC 7518 §3.2 — an HS256 key must be at least as long as the SHA-256 output. */
const MIN_HMAC_SECRET_BYTES = 32;

/**
 * RFC 8017 §3.1 — the smallest public exponent an RSA key can have.  The
 * exponent must also be odd: an even one has no private counterpart.
 */
export const MIN_RSA_PUBLIC_EXPONENT = 3;

/**
 * Whether `exponent` — big-endian, the way a JWK's `e` and WebCrypto's
 * `publicExponent` carry it — is one an RSA signature key can have: odd, and
 * at least {@link MIN_RSA_PUBLIC_EXPONENT}.  The bound is not pedantry.  RSA
 * verification raises the signature to this power, so with an exponent of 1
 * a valid signature is the encoded message itself, which anyone can compute
 * from the token — and at least one runtime's WebCrypto imports such a key
 * and verifies with it.
 */
export function isAcceptedRsaPublicExponent(exponent: Uint8Array): boolean {
  const first = exponent.findIndex((byte) => byte !== 0);
  if (first === -1 || (exponent[exponent.length - 1]! & 1) === 0) return false;
  // One significant byte is the only case below the bound: two are 256 or more.
  return first < exponent.length - 1 || exponent[first]! >= MIN_RSA_PUBLIC_EXPONENT;
}

/** A base64url value without padding (RFC 7515 §2) — the encoding of every JWK number. */
const BASE64URL_VALUE = /^[A-Za-z0-9_-]+$/;

/** The bytes a base64url value encodes, or `undefined` when `value` is not one. */
function base64urlBytes(value: string): Uint8Array | undefined {
  if (!BASE64URL_VALUE.test(value) || value.length % 4 === 1) return undefined;
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (character) => character.charCodeAt(0));
}

/** Plain settings shape for the JWT middleware. */
export type JwtAuthOptionsType = {
  /**
   * The algorithms a token may be signed with.  Required, and never
   * defaulted: an accepted algorithm is a security decision, and the
   * algorithm a token *claims* is attacker-chosen.  `none` is not accepted
   * in any spelling.
   */
  readonly algorithms: readonly JwtAlgorithm[];
  /** Accepted `iss` value(s), compared exactly.  Unset: `iss` is not checked. */
  readonly issuer?: string | readonly string[];
  /**
   * Accepted `aud` value(s), compared exactly; a token passes when its `aud`
   * (a string or a list) names one of them.  Unset: a token that names an
   * audience at all is refused, since this service cannot identify itself
   * with it (RFC 7519 §4.1.3).
   */
  readonly audience?: string | readonly string[];
  /** Tolerance for clock drift when checking `exp` and `nbf`.  Default 30 s, at most 5 min. */
  readonly clockSkewMs?: number;
  /** Static RS256 / ES256 public keys. */
  readonly publicKeys?: readonly JwtPublicKey[];
  /** Static HS256 secrets.  The only source of HMAC keys: a JWK set is never read for one. */
  readonly secrets?: readonly JwtSecret[];
  /**
   * The issuer's JWK set (`https:` — plain `http:` only to a loopback host).
   * RSA and P-256 keys are read from it; anything else is skipped.
   */
  readonly jwksUrl?: string;
  /** Deadline for one key-set fetch.  Default 5 s, at most 60 s. */
  readonly jwksTimeoutMs?: number;
  /** Largest key-set document accepted.  Default 64 KiB. */
  readonly jwksMaxResponseBytes?: number;
  /** How long a fetched key set is trusted.  Default 10 min. */
  readonly jwksCacheTtlMs?: number;
  /** Least time between two key-set fetches.  Default 30 s, at most `jwksCacheTtlMs`. */
  readonly jwksMinRefreshIntervalMs?: number;
  /** Largest token accepted, in bytes.  Default 8 KiB. */
  readonly maxTokenBytes?: number;
  /** Realm advertised in `WWW-Authenticate` on 401.  Default `'actor-ts'`. */
  readonly realm?: string;
  /** Where the middleware reads the time — for `exp`, `nbf` and the key-set cache.  Default: the wall clock. */
  readonly clock?: Clock;
  /**
   * Where the middleware reports what no response shows: a JWK set that
   * cannot be fetched, at warn and once per outage, and why an entry of the
   * set yields no key, at debug.  Default: the console, at warn.  Pass
   * `system.log` to send it where the rest of the application logs.
   */
  readonly logger?: Logger;
};

/** Fluent builder for {@link JwtAuthOptionsType}. */
export class JwtAuthOptionsBuilder extends OptionsBuilder<JwtAuthOptionsType> {
  /** Start a fresh builder.  Equivalent to `new JwtAuthOptionsBuilder()`. */
  static create(): JwtAuthOptionsBuilder {
    return new JwtAuthOptionsBuilder();
  }
  /** The algorithms a token may be signed with.  Required. */
  withAlgorithms(...algorithms: JwtAlgorithm[]): this {
    return this.set('algorithms', algorithms);
  }
  /** Accepted `iss` value(s). */
  withIssuer(...issuer: string[]): this {
    return this.set('issuer', issuer);
  }
  /** Accepted `aud` value(s). */
  withAudience(...audience: string[]): this {
    return this.set('audience', audience);
  }
  /** Tolerance for clock drift.  Default 30 s. */
  withClockSkewMs(clockSkewMs: number): this {
    return this.set('clockSkewMs', clockSkewMs);
  }
  /** Static RS256 / ES256 public keys. */
  withPublicKeys(...publicKeys: JwtPublicKey[]): this {
    return this.set('publicKeys', publicKeys);
  }
  /** Static HS256 secrets. */
  withSecrets(...secrets: JwtSecret[]): this {
    return this.set('secrets', secrets);
  }
  /** The issuer's JWK set URL. */
  withJwksUrl(jwksUrl: string): this {
    return this.set('jwksUrl', jwksUrl);
  }
  /** Deadline for one key-set fetch.  Default 5 s. */
  withJwksTimeoutMs(jwksTimeoutMs: number): this {
    return this.set('jwksTimeoutMs', jwksTimeoutMs);
  }
  /** Largest key-set document accepted.  Default 64 KiB. */
  withJwksMaxResponseBytes(jwksMaxResponseBytes: number): this {
    return this.set('jwksMaxResponseBytes', jwksMaxResponseBytes);
  }
  /** How long a fetched key set is trusted.  Default 10 min. */
  withJwksCacheTtlMs(jwksCacheTtlMs: number): this {
    return this.set('jwksCacheTtlMs', jwksCacheTtlMs);
  }
  /** Least time between two key-set fetches.  Default 30 s. */
  withJwksMinRefreshIntervalMs(jwksMinRefreshIntervalMs: number): this {
    return this.set('jwksMinRefreshIntervalMs', jwksMinRefreshIntervalMs);
  }
  /** Largest token accepted, in bytes.  Default 8 KiB. */
  withMaxTokenBytes(maxTokenBytes: number): this {
    return this.set('maxTokenBytes', maxTokenBytes);
  }
  /** Realm advertised in `WWW-Authenticate`.  Default `'actor-ts'`. */
  withRealm(realm: string): this {
    return this.set('realm', realm);
  }
  /**
   * Where the middleware reads the time.  Default: the wall clock.  Pass
   * `system.clock` and a `ManualScheduler` drives token expiry and the
   * key-set cache, so a test advances time instead of waiting for it.
   */
  withClock(clock: Clock): this {
    return this.set('clock', clock);
  }
  /** Where the middleware reports what no response shows.  Default: the console, at warn. */
  withLogger(logger: Logger): this {
    return this.set('logger', logger);
  }
}

/**
 * Accepted input: the builder or a plain object.  Not `Partial` — like
 * `ThrottleOptions`, the plain object must name `algorithms`, so `JwtAuth({})`
 * is a compile error rather than a middleware that refuses everything.
 */
export type JwtAuthOptions = JwtAuthOptionsBuilder | JwtAuthOptionsType;
export const JwtAuthOptions = JwtAuthOptionsBuilder;

/** Loopback host names a `jwksUrl` may reach over plain `http:` — a local issuer in development or a test. */
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** A `PEM` block's label, e.g. `PUBLIC KEY`, or `undefined` when `text` is not one. */
const PEM_BLOCK = /^\s*-----BEGIN ([A-Z0-9 ]+)-----([A-Za-z0-9+/=\s]*)-----END \1-----\s*$/;

/** A realm goes inside a quoted string in a header: printable ASCII, no quote, no backslash. */
const QUOTABLE_REALM = /^[\x20\x21\x23-\x5B\x5D-\x7E]+$/;

/**
 * Members only a private or symmetric JWK carries — a verifier holds none of
 * them.  Refused in a configured public key, and a JWK-set entry carrying one
 * is skipped rather than trusted.
 */
export const PRIVATE_JWK_MEMBERS: readonly string[] = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

/**
 * Validates resolved {@link JwtAuthOptionsType} settings, once, when
 * `JwtAuth(...)` builds the middleware.
 *
 * Most rules here exist because the mistake they catch is silent at runtime:
 * a middleware that verifies against no key refuses every request with the
 * same 401 a forged token gets, and nothing says the configuration is what is
 * wrong.  So an algorithm no key can verify, a key no allowed algorithm uses,
 * and a short or PEM-shaped HMAC secret all fail here, by name.
 */
export class JwtAuthOptionsValidator extends OptionsValidator<JwtAuthOptionsType> {
  constructor() {
    super('JwtAuthOptions');
  }

  protected rules(s: Partial<JwtAuthOptionsType>): void {
    this.nonEmptyArray('algorithms');
    s.algorithms?.forEach((algorithm, index) => {
      if (!SUPPORTED_ALGORITHMS.includes(algorithm)) {
        this.fail(`algorithms[${index}]`, `must be one of ${SUPPORTED_ALGORITHMS.join(', ')}`, algorithm);
      }
    });
    this.claimValues('issuer', s.issuer);
    this.claimValues('audience', s.audience);
    this.numberInRange('clockSkewMs', 0, MAX_JWT_CLOCK_SKEW_MS);
    this.positiveInt('maxTokenBytes');
    if (s.realm !== undefined && (typeof s.realm !== 'string' || !QUOTABLE_REALM.test(s.realm))) {
      this.fail('realm', 'must be non-empty printable ASCII without a quote or a backslash — it is sent inside a quoted header value', s.realm);
    }
    this.jwksRules(s);
    this.nonEmptyArray('publicKeys');
    s.publicKeys?.forEach((entry, index) => this.publicKeyRules(entry, `publicKeys[${index}]`));
    this.nonEmptyArray('secrets');
    s.secrets?.forEach((entry, index) => this.secretRules(entry, `secrets[${index}]`));
    this.keyIdRules(s);
    this.keySourceRules(s);
  }

  /** `issuer` / `audience`: a non-empty string, or a non-empty list of them. */
  private claimValues(field: 'issuer' | 'audience', value: string | readonly string[] | undefined): void {
    if (value === undefined) return;
    const values = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(values) || values.length === 0 || values.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      this.fail(field, 'must be a non-empty string or a non-empty list of them', value);
    }
  }

  private jwksRules(s: Partial<JwtAuthOptionsType>): void {
    this.url('jwksUrl', ['https', 'http']);
    if (s.jwksUrl !== undefined) {
      const url = new URL(s.jwksUrl);
      if (url.protocol === 'http:' && !LOOPBACK_HOST.test(url.hostname)) {
        this.fail('jwksUrl', 'must be an https: URL — a key set fetched in clear text lets anyone on the path substitute keys of their own (plain http: is accepted for a loopback host only)', `http://${url.host}${url.pathname}`);
      }
    }
    this.positiveNumber('jwksTimeoutMs');
    if (s.jwksTimeoutMs !== undefined && s.jwksTimeoutMs > MAX_JWKS_TIMEOUT_MS) {
      this.fail('jwksTimeoutMs', `must be at most ${MAX_JWKS_TIMEOUT_MS} — every request waiting on a key-set fetch waits that long`, s.jwksTimeoutMs);
    }
    this.positiveInt('jwksMaxResponseBytes');
    this.positiveNumber('jwksCacheTtlMs');
    this.positiveNumber('jwksMinRefreshIntervalMs');
    if (
      s.jwksCacheTtlMs !== undefined && s.jwksMinRefreshIntervalMs !== undefined
      && s.jwksMinRefreshIntervalMs > s.jwksCacheTtlMs
    ) {
      this.fail('jwksMinRefreshIntervalMs', `must be at most jwksCacheTtlMs (${s.jwksCacheTtlMs})`, s.jwksMinRefreshIntervalMs);
    }
  }

  private publicKeyRules(entry: JwtPublicKey, path: string): void {
    if (entry.algorithm !== 'RS256' && entry.algorithm !== 'ES256') {
      this.fail(`${path}.algorithm`, "must be 'RS256' or 'ES256' — an HS256 key is a secret and goes in secrets", entry.algorithm);
    }
    if (entry.keyId !== undefined && (typeof entry.keyId !== 'string' || entry.keyId.length === 0)) {
      this.fail(`${path}.keyId`, 'must be a non-empty string', entry.keyId);
    }
    const key = entry.key;
    if (typeof key === 'string') {
      this.pemPublicKeyRules(key, `${path}.key`);
      return;
    }
    if (typeof key !== 'object' || key === null || Array.isArray(key)) {
      this.fail(`${path}.key`, 'must be a JWK object or a PEM-encoded public key');
    }
    this.jwkRules(key, entry.algorithm, `${path}.key`);
    if (entry.keyId !== undefined && key.kid !== undefined && key.kid !== entry.keyId) {
      this.fail(`${path}.keyId`, `differs from the JWK's own kid (${String(key.kid)})`, entry.keyId);
    }
  }

  private pemPublicKeyRules(text: string, path: string): void {
    const label = PEM_BLOCK.exec(text)?.[1];
    if (label === 'PUBLIC KEY') return;
    if (label === 'RSA PUBLIC KEY') {
      this.fail(path, 'is a PKCS#1 "RSA PUBLIC KEY" block — convert it to the SubjectPublicKeyInfo "PUBLIC KEY" form');
    }
    if (label === 'CERTIFICATE') {
      this.fail(path, 'is a certificate — pass the public key it carries, as a "PUBLIC KEY" block');
    }
    if (label !== undefined && label.includes('PRIVATE KEY')) {
      this.fail(path, 'is a private key — a verifier needs only the public half, and must not hold the other');
    }
    this.fail(path, 'must be a JWK object or a PEM "-----BEGIN PUBLIC KEY-----" block');
  }

  private jwkRules(jwk: JwtPublicJwk, algorithm: JwtPublicKey['algorithm'], path: string): void {
    const privateMember = PRIVATE_JWK_MEMBERS.find((member) => jwk[member] !== undefined);
    if (privateMember !== undefined) {
      this.fail(path, `carries private key material (${privateMember}) — a verifier needs only the public half, and must not hold the other`);
    }
    const expectedType = algorithm === 'RS256' ? 'RSA' : 'EC';
    if (jwk.kty !== expectedType) {
      this.fail(`${path}.kty`, `must be ${expectedType} for ${algorithm}`, jwk.kty);
    }
    if (algorithm === 'ES256' && jwk.crv !== 'P-256') {
      this.fail(`${path}.crv`, 'must be P-256 for ES256', jwk.crv);
    }
    if (algorithm === 'RS256') {
      const exponent = typeof jwk.e === 'string' ? base64urlBytes(jwk.e) : undefined;
      if (exponent === undefined || !isAcceptedRsaPublicExponent(exponent)) {
        this.fail(
          `${path}.e`,
          `must be the base64url public exponent of an RSA signature key: odd, and at least ${MIN_RSA_PUBLIC_EXPONENT} (RFC 8017 §3.1)`,
          jwk.e,
        );
      }
    }
    if (jwk.alg !== undefined && jwk.alg !== algorithm) {
      this.fail(`${path}.alg`, `names ${String(jwk.alg)}, but the entry binds the key to ${algorithm}`, jwk.alg);
    }
    if (jwk.use !== undefined && jwk.use !== 'sig') {
      this.fail(`${path}.use`, "must be 'sig' — the key is published for something other than signatures", jwk.use);
    }
    if (jwk.key_ops !== undefined && !(Array.isArray(jwk.key_ops) && jwk.key_ops.includes('verify'))) {
      this.fail(`${path}.key_ops`, "must include 'verify'", jwk.key_ops);
    }
    if (jwk.kid !== undefined && (typeof jwk.kid !== 'string' || jwk.kid.length === 0)) {
      this.fail(`${path}.kid`, 'must be a non-empty string', jwk.kid);
    }
  }

  private secretRules(entry: JwtSecret, path: string): void {
    if (entry.keyId !== undefined && (typeof entry.keyId !== 'string' || entry.keyId.length === 0)) {
      this.fail(`${path}.keyId`, 'must be a non-empty string', entry.keyId);
    }
    const secret = entry.secret;
    if (typeof secret !== 'string' && !(secret instanceof Uint8Array)) {
      this.fail(`${path}.secret`, 'must be a string or a Uint8Array');
    }
    const bytes = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
    // Never report the value: it is the secret.
    if (bytes.byteLength < MIN_HMAC_SECRET_BYTES) {
      this.fail(`${path}.secret`, `must be at least ${MIN_HMAC_SECRET_BYTES} bytes (RFC 7518 §3.2), got ${bytes.byteLength}`);
    }
    if (new TextDecoder().decode(bytes.subarray(0, 256)).includes('-----BEGIN')) {
      this.fail(`${path}.secret`, 'looks like a PEM key — an HMAC secret equal to a public key is exactly the material an attacker has, so HS256 tokens signed with it would verify');
    }
  }

  /** Key ids name one key each, across both fields — a token's `kid` must not be ambiguous. */
  private keyIdRules(s: Partial<JwtAuthOptionsType>): void {
    const seen = new Set<string>();
    const keyIds = [
      ...(s.publicKeys ?? []).map((entry) => entry.keyId ?? (typeof entry.key === 'object' ? entry.key.kid : undefined)),
      ...(s.secrets ?? []).map((entry) => entry.keyId),
    ];
    for (const keyId of keyIds) {
      if (keyId === undefined) continue;
      if (seen.has(keyId)) this.fail('keyId', 'names more than one configured key', keyId);
      seen.add(keyId);
    }
  }

  /** Every allowed algorithm has a key that can verify it, and every key has an allowed algorithm. */
  private keySourceRules(s: Partial<JwtAuthOptionsType>): void {
    if (s.algorithms === undefined) return;
    const allowed = new Set(s.algorithms);
    s.publicKeys?.forEach((entry, index) => {
      if (!allowed.has(entry.algorithm)) {
        this.fail(`publicKeys[${index}].algorithm`, `is ${entry.algorithm}, which algorithms does not allow — the key could never verify a token`, entry.algorithm);
      }
    });
    const hasSecrets = (s.secrets?.length ?? 0) > 0;
    if (hasSecrets && !allowed.has('HS256')) {
      this.fail('secrets', 'are configured, but algorithms does not allow HS256 — they could never verify a token');
    }
    if (allowed.has('HS256') && !hasSecrets) {
      this.fail('algorithms', 'allows HS256, but no secret is configured — a JWK set never supplies an HMAC key, so nothing could verify an HS256 token');
    }
    for (const algorithm of ['RS256', 'ES256'] as const) {
      if (!allowed.has(algorithm) || s.jwksUrl !== undefined) continue;
      if (!(s.publicKeys ?? []).some((entry) => entry.algorithm === algorithm)) {
        this.fail('algorithms', `allows ${algorithm}, but no public key verifies it and no jwksUrl is configured`);
      }
    }
  }
}
