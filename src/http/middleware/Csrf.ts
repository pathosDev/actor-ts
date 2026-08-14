/**
 * Cross-Site Request Forgery protection.
 *
 * The framework has no session concept, so this is a stateless
 * double-submit scheme: the token is `payload.hmac(secret, payload)`.
 * Three separate things carry the defence, and it is worth being exact
 * about which does what — the HMAC is NOT what stops cookie planting:
 *
 *  - The **HMAC** rejects tokens this server never minted (garbage, a
 *    guess, a token from another deployment).  It binds a token to the
 *    server secret and to nothing else, so a token minted for one client
 *    verifies for every other: an attacker who can plant a cookie can
 *    plant a *signed* one they were legitimately handed, and the pair
 *    verifies.
 *  - The **`__Host-` cookie name** (the default) is what defeats planting.
 *    A browser refuses such a cookie unless it is `Secure`, `Path=/` and
 *    carries no `Domain`, which locks it to exactly this host: a sibling
 *    subdomain cannot write it, and a plaintext origin cannot write it at
 *    all.
 *  - The **Origin/Referer gate** on unsafe methods (on by default) rejects
 *    the cross-site request that would carry such a pair in the first
 *    place.
 *
 * The cookie is intentionally NOT HttpOnly: same-origin JS must read it to
 * echo it into the header.  The token authenticates nothing on its own
 * (auth still rides the session/auth cookie), and any XSS able to read it
 * already defeats every CSRF scheme.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Middleware } from '../Route.js';
import { HttpError, Status, type HttpRequest } from '../Types.js';
import { parseCookies, serializeCookie } from '../Cookies.js';
import { applyHeaders } from './Headers.js';
import {
  CsrfOptionsValidator,
  DEFAULT_CSRF_COOKIE_NAME,
  SameOriginOptionsValidator,
  normalizeOrigin,
  type CsrfOptions,
  type CsrfOptionsType,
  type OriginScheme,
  type SameOriginOptions,
  type SameOriginOptionsType,
} from './CsrfOptions.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Same-origin check for unsafe methods: the Origin/Referer must be the
 * request's own origin, or one of the allowlisted origins — compared
 * WHOLE, scheme included.
 *
 * The request's own origin is `expectedScheme` + the `Host` header,
 * because `Host` carries no scheme of its own and the app cannot see the
 * one the client used (TLS may terminate at a proxy, and a forwarded
 * scheme header is client-settable, so it is not trusted here).  Comparing
 * bare hosts instead — what this did before — accepts `http://app.example`
 * as same-origin for an HTTPS site, and likewise any exotic scheme that
 * parses an authority.
 */
function isSameOrigin(
  request: HttpRequest,
  allowedOrigins: ReadonlyArray<string> | undefined,
  allowMissing: boolean,
  expectedScheme: OriginScheme,
): boolean {
  const source = request.headers['origin'] ?? request.headers['referer'];
  if (!source) return allowMissing;
  const sourceOrigin = normalizeOrigin(source);
  if (!sourceOrigin) return false;
  const host = request.headers['host'];
  if (host && sourceOrigin === normalizeOrigin(`${expectedScheme}://${host}`)) return true;
  if (allowedOrigins) {
    for (const allowed of allowedOrigins) {
      if (sourceOrigin === normalizeOrigin(allowed)) return true;
    }
  }
  return false;
}

/**
 * Reject unsafe-method requests (POST/PUT/PATCH/DELETE) whose
 * Origin/Referer is cross-origin.  A lightweight standalone CSRF defence
 * for modern browsers; {@link csrfProtection} is the belt-and-suspenders
 * option.
 */
export function requireSameOrigin(options: SameOriginOptions = {}): Middleware {
  const resolvedOptions = options as Partial<SameOriginOptionsType>;
  new SameOriginOptionsValidator().validate(resolvedOptions);
  const expectedScheme = resolvedOptions.expectedScheme ?? 'https';
  return async (request, next) => {
    if (SAFE_METHODS.has(request.method)) return next();
    if (!isSameOrigin(request, resolvedOptions.allowedOrigins, resolvedOptions.allowMissingOrigin ?? false, expectedScheme)) {
      throw new HttpError(Status.Forbidden, 'cross-origin request rejected');
    }
    return next();
  };
}

function sign(secret: string | Uint8Array, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function makeToken(secret: string | Uint8Array): string {
  const payload = randomBytes(32).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

/** Constant-time string compare (equal-length only; length is fixed for our tokens). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * A token is valid iff its HMAC recomputes — an unsigned or garbage token
 * fails here.  A token this server DID mint passes no matter whose browser
 * presents it: the payload is a bare nonce, so there is nothing tying it to
 * a client.  What keeps someone else's token out of the victim's cookie jar
 * is the `__Host-` cookie name, not this function.
 */
function verifyToken(secret: string | Uint8Array, token: string): boolean {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  return safeEqual(token.slice(dot + 1), sign(secret, token.slice(0, dot)));
}

function hasSetCookie(headers: Readonly<Record<string, string>> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((k) => k.toLowerCase() === 'set-cookie');
}

function formFieldValue(request: HttpRequest, field: string): string | undefined {
  const ct = request.headers['content-type'] ?? '';
  if (!ct.includes('application/x-www-form-urlencoded') || !request.body) return undefined;
  try {
    return new URLSearchParams(new TextDecoder().decode(request.body)).get(field) ?? undefined;
  } catch { return undefined; }
}

/**
 * Read the CSRF token an SSR handler should template into its form/meta —
 * the forwarded request header first (present from the very first GET),
 * then the cookie.
 */
export function readCsrfToken(request: HttpRequest, options: { cookieName?: string; headerName?: string } = {}): string | null {
  const fromHeader = request.headers[(options.headerName ?? 'x-csrf-token').toLowerCase()];
  if (fromHeader) return fromHeader;
  return parseCookies(request.headers['cookie'])[options.cookieName ?? DEFAULT_CSRF_COOKIE_NAME] ?? null;
}

/** Build the stateless double-submit CSRF middleware. */
export function csrfProtection(options: CsrfOptions): Middleware {
  const resolvedOptions = options as Partial<CsrfOptionsType>;
  const secret = resolvedOptions.secret;
  // Required-field guard stays a bare Error; the >= 16-byte validity of a
  // PRESENT secret (and the nested cookie rules) move to the validator.
  if (secret === undefined) {
    throw new Error('csrfProtection: a secret of at least 16 bytes is required (32 recommended)');
  }
  new CsrfOptionsValidator().validate(resolvedOptions);
  const cookieName = resolvedOptions.cookieName ?? DEFAULT_CSRF_COOKIE_NAME;
  const headerName = (resolvedOptions.headerName ?? 'x-csrf-token').toLowerCase();
  const cookie = resolvedOptions.cookie ?? {};
  const cookieAttrs = {
    path: cookie.path ?? '/',
    secure: cookie.secure ?? true,
    sameSite: cookie.sameSite ?? 'lax' as const,
    httpOnly: false, // JS must read it to echo it into the header
    domain: cookie.domain,
    maxAgeSeconds: cookie.maxAgeSeconds,
  };
  const verifyOrigin = resolvedOptions.verifyOrigin ?? true;
  // A non-Secure CSRF cookie is an explicit declaration that the app runs
  // over plain HTTP — take it as the expected scheme rather than rejecting
  // every one of that app's own origins.
  const expectedScheme = resolvedOptions.expectedScheme ?? (cookie.secure === false ? 'http' : 'https');
  const formFieldName = resolvedOptions.formFieldName;

  return async (request, next) => {
    const cookies = parseCookies(request.headers['cookie']);
    const cookieToken = cookies[cookieName];

    if (SAFE_METHODS.has(request.method)) {
      const token = cookieToken && verifyToken(secret, cookieToken) ? cookieToken : makeToken(secret);
      // Forward the token to the handler as a request header so an SSR
      // handler can read it via readCsrfToken() even on the first GET.
      const response = await next({ ...request, headers: { ...request.headers, [headerName]: token } });
      if (hasSetCookie(response.headers)) return response; // single-value Record — don't stomp
      return applyHeaders(response, {
        'set-cookie': serializeCookie(cookieName, token, cookieAttrs),
      });
    }

    // Unsafe method: origin gate (token is the primary gate, so a missing
    // Origin/Referer is allowed through to the token check), then the pair.
    if (verifyOrigin && !isSameOrigin(request, resolvedOptions.allowedOrigins, true, expectedScheme)) {
      throw new HttpError(Status.Forbidden, 'CSRF verification failed');
    }
    const submitted = request.headers[headerName] ?? (formFieldName ? formFieldValue(request, formFieldName) : undefined);
    if (
      !cookieToken
      || submitted === undefined
      || !verifyToken(secret, cookieToken)
      || !safeEqual(cookieToken, submitted)
    ) {
      throw new HttpError(Status.Forbidden, 'CSRF verification failed');
    }
    return next();
  };
}
