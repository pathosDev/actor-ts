/**
 * Cross-Site Request Forgery protection.
 *
 * The framework has no session concept, so this is a stateless
 * double-submit scheme HARDENED with an HMAC: the token is
 * `payload.hmac(secret, payload)`.  A plain double-submit is defeated by
 * an attacker who can plant a cookie (from a sibling subdomain or a
 * MITM'd http origin) and send a matching header; the HMAC binds validity
 * to the server secret, so a planted pair fails verification.  On unsafe
 * methods it also checks Origin/Referer as a second gate.
 *
 * The cookie is intentionally NOT HttpOnly: same-origin JS must read it to
 * echo it into the header.  The token authenticates nothing on its own
 * (auth still rides the session/auth cookie), and any XSS able to read it
 * already defeats every CSRF scheme.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Middleware } from '../Route.js';
import { HttpError, Status, type HttpRequest } from '../types.js';
import { parseCookies, serializeCookie } from '../cookies.js';
import { applyHeaders } from './headers.js';
import {
  CsrfOptionsValidator,
  type CsrfOptions,
  type CsrfOptionsType,
  type SameOriginOptions,
  type SameOriginOptionsType,
} from './CsrfOptions.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hostOf(urlLike: string): string | null {
  try { return new URL(urlLike).host; } catch { return null; }
}

/** Same-origin check for unsafe methods: the Origin/Referer host must match the request host (or an allowlisted origin). */
function isSameOrigin(req: HttpRequest, allowedOrigins: ReadonlyArray<string> | undefined, allowMissing: boolean): boolean {
  const source = req.headers['origin'] ?? req.headers['referer'];
  if (!source) return allowMissing;
  const sourceHost = hostOf(source);
  if (!sourceHost) return false;
  if (req.headers['host'] && sourceHost === req.headers['host']) return true;
  if (allowedOrigins) {
    for (const allowed of allowedOrigins) {
      if (allowed === source || hostOf(allowed) === sourceHost) return true;
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
  return async (req, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (!isSameOrigin(req, resolvedOptions.allowedOrigins, resolvedOptions.allowMissingOrigin ?? false)) {
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

/** A token is valid iff its HMAC recomputes — a planted/unsigned token fails here. */
function verifyToken(secret: string | Uint8Array, token: string): boolean {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  return safeEqual(token.slice(dot + 1), sign(secret, token.slice(0, dot)));
}

function hasSetCookie(headers: Readonly<Record<string, string>> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((k) => k.toLowerCase() === 'set-cookie');
}

function formFieldValue(req: HttpRequest, field: string): string | undefined {
  const ct = req.headers['content-type'] ?? '';
  if (!ct.includes('application/x-www-form-urlencoded') || !req.body) return undefined;
  try {
    return new URLSearchParams(new TextDecoder().decode(req.body)).get(field) ?? undefined;
  } catch { return undefined; }
}

/**
 * Read the CSRF token an SSR handler should template into its form/meta —
 * the forwarded request header first (present from the very first GET),
 * then the cookie.
 */
export function readCsrfToken(req: HttpRequest, opts: { cookieName?: string; headerName?: string } = {}): string | null {
  const fromHeader = req.headers[(opts.headerName ?? 'x-csrf-token').toLowerCase()];
  if (fromHeader) return fromHeader;
  return parseCookies(req.headers['cookie'])[opts.cookieName ?? 'csrf-token'] ?? null;
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
  const cookieName = resolvedOptions.cookieName ?? 'csrf-token';
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
  const formFieldName = resolvedOptions.formFieldName;

  return async (req, next) => {
    const cookies = parseCookies(req.headers['cookie']);
    const cookieToken = cookies[cookieName];

    if (SAFE_METHODS.has(req.method)) {
      const token = cookieToken && verifyToken(secret, cookieToken) ? cookieToken : makeToken(secret);
      // Forward the token to the handler as a request header so an SSR
      // handler can read it via readCsrfToken() even on the first GET.
      const res = await next({ ...req, headers: { ...req.headers, [headerName]: token } });
      if (hasSetCookie(res.headers)) return res; // single-value Record — don't stomp
      return applyHeaders(res, {
        'set-cookie': serializeCookie(cookieName, token, cookieAttrs),
      });
    }

    // Unsafe method: origin gate (token is the primary gate, so a missing
    // Origin/Referer is allowed through to the token check), then the pair.
    if (verifyOrigin && !isSameOrigin(req, resolvedOptions.allowedOrigins, true)) {
      throw new HttpError(Status.Forbidden, 'CSRF verification failed');
    }
    const submitted = req.headers[headerName] ?? (formFieldName ? formFieldValue(req, formFieldName) : undefined);
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
