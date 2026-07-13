/**
 * Minimal cookie parsing + serialisation.  The framework had no cookie
 * helper; CSRF needs one, and handlers do too, so it lives at the HTTP
 * root (not under middleware/) and is part of the public API.
 *
 * Security posture: parsing caps the number of pairs (untrusted input),
 * and serialisation REJECTS values or names that could smuggle a second
 * header or break out of the cookie (header-injection guard), plus
 * enforces the `__Secure-` / `__Host-` prefix rules and the
 * SameSite=None→Secure requirement.
 */

/** Attributes for a `Set-Cookie` value. */
export interface CookieAttributes {
  readonly maxAgeSeconds?: number;
  readonly expires?: Date;
  readonly domain?: string;
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly sameSite?: 'strict' | 'lax' | 'none';
}

/** Hard cap on parsed pairs — a client cannot make us build an unbounded map. */
const MAX_COOKIE_PAIRS = 128;

/** RFC 6265 cookie-name token characters. */
const COOKIE_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Illegal in a cookie value: anything outside printable ASCII (controls,
 * space, DEL, non-ASCII) plus the structural delimiters `" , ; \`.  This
 * is a superset-safe guard — it rejects everything RFC 6265 forbids and
 * anything that could inject a header.
 */
const ILLEGAL_COOKIE_VALUE = /[^\x21-\x7e]|["(),;\\]/;

/**
 * Parse a request `Cookie` header into a name→value map.  First
 * occurrence of a name wins (RFC 6265 §5.4 ordering); malformed pairs are
 * skipped, never thrown; values are best-effort %XX-decoded (kept raw on
 * failure) with one layer of surrounding double quotes stripped.  At most
 * {@link MAX_COOKIE_PAIRS} pairs are accepted.
 */
export function parseCookies(header: string | undefined): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!header) return out;
  let count = 0;
  for (const part of header.split(';')) {
    if (count >= MAX_COOKIE_PAIRS) break;
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try { value = decodeURIComponent(value); } catch { /* not %-encoded — keep raw */ }
    out[name] = value;
    count++;
  }
  return out;
}

/**
 * Serialise one `Set-Cookie` value.  THROWS on an invalid name, a value
 * containing an illegal character (header-injection guard), a
 * `SameSite=None` cookie that isn't `Secure`, or a violated cookie-prefix
 * rule (`__Secure-` needs Secure; `__Host-` needs Secure + Path=/ + no
 * Domain).  Value is emitted verbatim — pre-encode it yourself if needed.
 */
export function serializeCookie(name: string, value: string, attrs: CookieAttributes = {}): string {
  if (!COOKIE_NAME_RE.test(name)) {
    throw new Error(`serializeCookie: invalid cookie name "${name}"`);
  }
  if (ILLEGAL_COOKIE_VALUE.test(value)) {
    throw new Error('serializeCookie: cookie value contains an illegal character');
  }
  const secure = attrs.secure ?? false;
  if (attrs.sameSite === 'none' && !secure) {
    throw new Error('serializeCookie: SameSite=None requires Secure');
  }
  if (name.startsWith('__Secure-') && !secure) {
    throw new Error('serializeCookie: the "__Secure-" prefix requires Secure');
  }
  if (name.startsWith('__Host-') && (!secure || attrs.path !== '/' || attrs.domain !== undefined)) {
    throw new Error('serializeCookie: the "__Host-" prefix requires Secure, Path=/, and no Domain');
  }
  if (attrs.maxAgeSeconds !== undefined && !Number.isInteger(attrs.maxAgeSeconds)) {
    throw new Error('serializeCookie: maxAgeSeconds must be an integer');
  }

  const parts = [`${name}=${value}`];
  if (attrs.maxAgeSeconds !== undefined) parts.push(`Max-Age=${attrs.maxAgeSeconds}`);
  if (attrs.expires) parts.push(`Expires=${attrs.expires.toUTCString()}`);
  if (attrs.domain) parts.push(`Domain=${attrs.domain}`);
  if (attrs.path) parts.push(`Path=${attrs.path}`);
  if (attrs.httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (attrs.sameSite) {
    parts.push(`SameSite=${attrs.sameSite === 'strict' ? 'Strict' : attrs.sameSite === 'lax' ? 'Lax' : 'None'}`);
  }
  return parts.join('; ');
}
