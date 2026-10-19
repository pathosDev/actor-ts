/**
 * JWT bearer-token authentication middleware (#810) — RS256, ES256 and HS256
 * verified with WebCrypto, with no dependency: keys configured statically or
 * read from the issuer's JWK set.
 *
 *     const jwtOptions = JwtAuthOptions.create()
 *       .withAlgorithms('RS256')
 *       .withIssuer('https://auth.example.com/')
 *       .withAudience('orders-api')
 *       .withJwksUrl('https://auth.example.com/.well-known/jwks.json');
 *     const routes = withMiddleware(JwtAuth(jwtOptions), apiRoutes);
 *     // in a handler: jwtClaimsOf(request)?.sub
 *
 * Verification only: issuing tokens and OpenID Connect discovery are not
 * this middleware's business — the JWK set URL is passed explicitly.
 *
 * The order of the checks is the point.  Nothing in the token is trusted
 * before its signature verifies except what is needed to find the key, and
 * that is held to the allowlist: the algorithm must be exactly one the
 * application named (`none` never is), the key comes from configuration or
 * the configured JWK set and never from the token (`jku`, `x5u`, `jwk` and
 * `x5c` are ignored), and the key is used with the algorithm it was bound to
 * at import.  Only then are the claims read: `exp` is required, `nbf`, `iss`
 * and `aud` are checked, all exactly.
 *
 * A token that fails is answered `401` with `WWW-Authenticate: Bearer
 * realm="…", error="invalid_token"` (RFC 6750 §3.1); a request with no token
 * at all gets the challenge without an error code, as the RFC asks.  When the
 * JWK set cannot be fetched the answer is `503` — the token was never judged,
 * so `401` would be a lie a client acts on by discarding a good token.
 *
 * Verified claims reach the handlers inside the middleware through a request
 * attribute — {@link jwtClaimsOf} — which no client can set.  HTTP routes
 * only: around a `websocket()` route the middleware gates the upgrade, but
 * the connection is handed the upgrade request the backend adapted, so the
 * claims do not reach the socket.
 */
import { systemClock } from '../../Clock.js';
import { RequestAttributeKey, attribute, withAttribute } from '../RequestAttributes.js';
import type { Middleware } from '../Route.js';
import { HttpError, Status, type HttpRequest } from '../Types.js';
import {
  JwksKeySet,
  JwksUnavailableError,
  importPublicKey,
  importSecret,
  subtleCrypto,
  verifySignature,
  type VerificationKey,
} from './Jwks.js';
import {
  DEFAULT_JWKS_CACHE_TTL_MS,
  DEFAULT_JWKS_MAX_RESPONSE_BYTES,
  DEFAULT_JWKS_MIN_REFRESH_INTERVAL_MS,
  DEFAULT_JWKS_TIMEOUT_MS,
  DEFAULT_JWT_CLOCK_SKEW_MS,
  DEFAULT_JWT_MAX_TOKEN_BYTES,
  DEFAULT_JWT_REALM,
  JwtAuthOptionsValidator,
} from './JwtAuthOptions.js';
import type { JwtAlgorithm, JwtAuthOptions, JwtAuthOptionsType } from './JwtAuthOptions.js';

/**
 * The claims of a verified token.  The registered claims are typed as the
 * middleware guarantees them — `exp` always present, every other one checked
 * for its type when present — and every other claim is passed through as the
 * issuer wrote it.
 */
export type JwtClaims = {
  /** Expiry, seconds since the epoch.  Always present: a token without one is refused. */
  readonly exp: number;
  /** Not-before, seconds since the epoch. */
  readonly nbf?: number;
  /** Issued-at, seconds since the epoch. */
  readonly iat?: number;
  readonly iss?: string;
  readonly sub?: string;
  readonly aud?: string | readonly string[];
  readonly jti?: string;
  readonly [claim: string]: unknown;
};

/** Where the verified claims travel to the handlers.  Named under `actor-ts.`, the framework's prefix. */
const JWT_CLAIMS = RequestAttributeKey.of<JwtClaims>('actor-ts.jwt');

/**
 * The claims {@link JwtAuth} verified for this request, or `undefined` on a
 * route no `JwtAuth` wraps.  Read from a request attribute, not a header, so
 * a client cannot supply them.
 */
export function jwtClaimsOf(request: HttpRequest): JwtClaims | undefined {
  return attribute(request, JWT_CLAIMS);
}

/** Three base64url segments — the only token shape accepted.  An empty signature is not one. */
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** `bytes` as unpadded base64url. */
function encodeSegment(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A base64url segment's bytes, or `undefined` unless the segment is the one
 * canonical encoding of them.  `atob` alone tolerates whitespace and padding,
 * and ignores the spare bits of a final character — so two different token
 * strings could carry the same signature, and anything that tells tokens
 * apart by their text (a deny list, a replay cache) would be fooled.
 */
function decodeSegment(segment: string): Uint8Array | undefined {
  if (segment.length % 4 === 1) return undefined;
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try {
    binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  } catch {
    return undefined;
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return encodeSegment(bytes) === segment ? bytes : undefined;
}

/** A JSON object from UTF-8 bytes, or `undefined` for anything else — invalid UTF-8 included. */
function decodeJsonObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(strictUtf8.decode(bytes));
  } catch {
    return undefined;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isNumericDate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A token taken apart, with nothing in it trusted yet. */
type ParsedToken = {
  readonly algorithm: JwtAlgorithm;
  readonly keyId: string | undefined;
  /** The bytes the signature covers: `header.payload`, exactly as sent. */
  readonly signingInput: Uint8Array;
  readonly signature: Uint8Array;
  readonly payload: Uint8Array;
};

/** The settings the middleware runs on — options over the built-in defaults. */
type JwtAuthSettings = JwtAuthOptionsType & {
  readonly clockSkewMs: number;
  readonly jwksTimeoutMs: number;
  readonly jwksMaxResponseBytes: number;
  readonly jwksCacheTtlMs: number;
  readonly jwksMinRefreshIntervalMs: number;
  readonly maxTokenBytes: number;
  readonly realm: string;
};

/** `value` as a list, or `undefined` when the check it configures is off. */
function listOf(value: string | readonly string[] | undefined): readonly string[] | undefined {
  return value === undefined ? undefined : typeof value === 'string' ? [value] : value;
}

/**
 * Every configured key, imported once.  Started at construction so the first
 * request does not pay for it; a key that cannot be imported fails every
 * request as a server error — loud in the log, and never a pass.
 */
function importConfiguredKeys(settings: JwtAuthSettings): Promise<readonly VerificationKey[]> {
  const failed = (field: string) => (cause: unknown): never => {
    throw new Error(`JwtAuth: ${field} could not be imported: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  };
  const imports = [
    ...(settings.publicKeys ?? []).map((entry, index) => importPublicKey(entry).catch(failed(`publicKeys[${index}]`))),
    ...(settings.secrets ?? []).map((entry, index) => importSecret(entry).catch(failed(`secrets[${index}]`))),
  ];
  const keys = Promise.all(imports);
  // Observed here, so a bad key is not an unhandled rejection before the
  // first request; every request still awaits `keys` and sees the failure.
  keys.catch(() => undefined);
  return keys;
}

/**
 * Build the JWT middleware.  `algorithms` is required, and at least one key
 * source for each of them — `JwtAuthOptionsValidator` says which is missing.
 */
export function JwtAuth(options: JwtAuthOptions): Middleware {
  const given = options as Partial<JwtAuthOptionsType>;
  if (given.algorithms === undefined) {
    throw new Error("JwtAuth: algorithms is required — name the algorithms your issuer signs with, e.g. ['RS256']");
  }
  const settings: JwtAuthSettings = {
    ...given,
    algorithms: given.algorithms,
    clockSkewMs: given.clockSkewMs ?? DEFAULT_JWT_CLOCK_SKEW_MS,
    jwksTimeoutMs: given.jwksTimeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS,
    jwksMaxResponseBytes: given.jwksMaxResponseBytes ?? DEFAULT_JWKS_MAX_RESPONSE_BYTES,
    jwksCacheTtlMs: given.jwksCacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS,
    jwksMinRefreshIntervalMs: given.jwksMinRefreshIntervalMs ?? DEFAULT_JWKS_MIN_REFRESH_INTERVAL_MS,
    maxTokenBytes: given.maxTokenBytes ?? DEFAULT_JWT_MAX_TOKEN_BYTES,
    realm: given.realm ?? DEFAULT_JWT_REALM,
  };
  new JwtAuthOptionsValidator().validate(settings);
  subtleCrypto();

  const allowed: ReadonlySet<JwtAlgorithm> = new Set(settings.algorithms);
  const issuers = listOf(settings.issuer);
  const audiences = listOf(settings.audience);
  const skewSeconds = settings.clockSkewMs / 1000;
  const clock = settings.clock ?? systemClock;
  const challenge = { 'www-authenticate': `Bearer realm="${settings.realm}"` };
  const invalidTokenChallenge = { 'www-authenticate': `Bearer realm="${settings.realm}", error="invalid_token"` };
  const configuredKeys = importConfiguredKeys(settings);
  const keySet = settings.jwksUrl === undefined
    ? undefined
    : new JwksKeySet({
      url: settings.jwksUrl,
      algorithms: allowed,
      timeoutMs: settings.jwksTimeoutMs,
      maxResponseBytes: settings.jwksMaxResponseBytes,
      cacheTtlMs: settings.jwksCacheTtlMs,
      minRefreshIntervalMs: settings.jwksMinRefreshIntervalMs,
    }, clock);

  /** A request that carries no usable credentials at all: the challenge, without an error code (RFC 6750 §3.1). */
  const unauthenticated = (message: string): never => {
    throw new HttpError(Status.Unauthorized, message, undefined, challenge);
  };
  /** A token that was presented and failed. */
  const refuse = (message: string): never => {
    throw new HttpError(Status.Unauthorized, message, undefined, invalidTokenChallenge);
  };

  const bearerToken = (header: string | undefined): string => {
    const value = header?.trim() ?? '';
    if (value.length === 0) return unauthenticated('missing Authorization header');
    const separator = value.indexOf(' ');
    const scheme = separator === -1 ? value : value.slice(0, separator);
    if (scheme.toLowerCase() !== 'bearer') return unauthenticated('authorization scheme must be Bearer');
    const token = separator === -1 ? '' : value.slice(separator + 1).trim();
    // Before anything is decoded: an oversized token costs a comparison.
    if (token.length > settings.maxTokenBytes) return refuse('token too large');
    return token;
  };

  const parse = (token: string): ParsedToken => {
    if (!COMPACT_JWS.test(token)) return refuse('malformed token');
    const [headerSegment, payloadSegment, signatureSegment] = token.split('.') as [string, string, string];
    const headerBytes = decodeSegment(headerSegment);
    const payload = decodeSegment(payloadSegment);
    const signature = decodeSegment(signatureSegment);
    if (headerBytes === undefined || payload === undefined || signature === undefined) return refuse('malformed token');
    const header = decodeJsonObject(headerBytes) ?? refuse('malformed token');
    // Exactly one of the allowed names: `none`, `None` and a lower-case
    // `rs256` are not on the list, so none of them gets this far.
    const algorithm = header['alg'];
    if (typeof algorithm !== 'string' || !allowed.has(algorithm as JwtAlgorithm)) return refuse('token algorithm not accepted');
    // No extension is understood here, so any `crit` must be refused
    // (RFC 7515 §4.1.11).  `jku`, `x5u`, `jwk` and `x5c` are not read at
    // all: the token does not get to say which key verifies it.
    if (header['crit'] !== undefined) return refuse('token carries an unsupported critical header');
    const keyId = header['kid'];
    if (keyId !== undefined && (typeof keyId !== 'string' || keyId.length === 0)) return refuse('malformed token');
    return {
      algorithm: algorithm as JwtAlgorithm,
      keyId,
      signingInput: new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
      signature,
      payload,
    };
  };

  /** The keys that could verify `token`: by key id when it names one, else every key of its algorithm. */
  const candidates = async (token: ParsedToken): Promise<readonly VerificationKey[]> => {
    const configured = await configuredKeys;
    if (token.keyId !== undefined) {
      const named = configured.filter((key) => key.keyId === token.keyId);
      // A configured key answers for its id: it never falls through to the
      // JWK set, and its algorithm is the only one it verifies.
      if (named.length > 0) return named.filter((key) => key.algorithm === token.algorithm);
      return keySet === undefined ? [] : keySet.keysFor(token.keyId, token.algorithm);
    }
    const unnamed = configured.filter((key) => key.algorithm === token.algorithm);
    return keySet === undefined ? unnamed : [...unnamed, ...await keySet.keysFor(undefined, token.algorithm)];
  };

  const verificationKey = async (token: ParsedToken): Promise<VerificationKey> => {
    let found: readonly VerificationKey[];
    try {
      found = await candidates(token);
    } catch (error) {
      if (error instanceof JwksUnavailableError) throw new HttpError(Status.ServiceUnavailable, 'token key set unavailable');
      throw error;
    }
    if (found.length === 0) return refuse('no key verifies this token');
    // Trying each would let one forged token cost a verification per key.
    if (found.length > 1) return refuse('token key is ambiguous');
    return found[0]!;
  };

  const verifiedClaims = (payload: Uint8Array): JwtClaims => {
    const claims = decodeJsonObject(payload) ?? refuse('token claims malformed');
    const { exp, nbf, iat, iss, sub, aud, jti } = claims;
    if (exp === undefined) return refuse('token has no expiry');
    if (!isNumericDate(exp) || (nbf !== undefined && !isNumericDate(nbf)) || (iat !== undefined && !isNumericDate(iat))) {
      return refuse('token claims malformed');
    }
    for (const value of [iss, sub, jti]) {
      if (value !== undefined && typeof value !== 'string') return refuse('token claims malformed');
    }
    if (aud !== undefined && typeof aud !== 'string' && !(Array.isArray(aud) && aud.every((entry) => typeof entry === 'string'))) {
      return refuse('token claims malformed');
    }
    const nowSeconds = clock.now() / 1000;
    // RFC 7519 §4.1.4: valid only *before* `exp`; §4.1.5: from `nbf` on.
    if (nowSeconds - skewSeconds >= exp) return refuse('token expired');
    if (nbf !== undefined && nowSeconds + skewSeconds < nbf) return refuse('token not yet valid');
    if (issuers !== undefined && !issuers.includes(iss as string)) return refuse('token issuer not accepted');
    const named: readonly string[] = aud === undefined ? [] : typeof aud === 'string' ? [aud] : aud as string[];
    // With no audience configured, a token that names one is still refused:
    // this service cannot identify itself with it (RFC 7519 §4.1.3).
    if (audiences === undefined ? named.length > 0 || aud !== undefined : !named.some((entry) => audiences.includes(entry))) {
      return refuse('token audience not accepted');
    }
    return Object.freeze(claims) as JwtClaims;
  };

  return async (request, next) => {
    const token = parse(bearerToken(request.headers['authorization']));
    const key = await verificationKey(token);
    if (token.signature.byteLength !== key.signatureBytes) return refuse('malformed token');
    if (!(await verifySignature(key, token.signature, token.signingInput))) return refuse('token signature invalid');
    return next(withAttribute(request, JWT_CLAIMS, verifiedClaims(token.payload)));
  };
}
