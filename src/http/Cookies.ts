/**
 * Minimal cookie parsing + serialisation.  The framework had no cookie
 * helper; CSRF needs one, and handlers do too, so it lives at the HTTP
 * root (not under middleware/) and is part of the public API.
 *
 * Security posture: parsing caps the number of pairs (untrusted input),
 * and serialisation is **safe by omission** — the attributes a caller does
 * not mention resolve to the strict end (`Secure`, `HttpOnly`,
 * `SameSite=Lax`, `Path=/`), so the short call is the safe one rather than
 * the bare `name=value` it used to emit.  Every part that reaches the
 * header is then validated: names, values, `Path` and `Domain` are all
 * REJECTED when they could smuggle a second attribute or a second header,
 * and the `__Secure-` / `__Host-` prefix rules and the
 * SameSite=None→Secure requirement are enforced on top.
 */

/**
 * Attributes for a `Set-Cookie` value.  Defaults are the strict ones: an
 * omitted flag is not an opt-out, it is the safe choice, and loosening it
 * takes an explicit `false`.
 */
export type CookieAttributes = {
  readonly maxAgeSeconds?: number;
  readonly expires?: Date;
  /**
   * No default: a cookie without `Domain` is host-only, which is the
   * narrower scope.  Setting it shares the cookie with every subdomain.
   */
  readonly domain?: string;
  /**
   * Default `'/'`, and always emitted.  Omitting the attribute would let
   * the browser derive a default-path from the request URI, so the same
   * cookie would be scoped to `/account` when minted from `/account/login`
   * and to `/` when minted from the root — scope that depends on which
   * endpoint happened to issue it.  Pass the path explicitly to narrow it.
   */
  readonly path?: string;
  /** Default `true`.  Pass `false` only for a plain-HTTP deployment. */
  readonly secure?: boolean;
  /** Default `true`.  Pass `false` when same-origin JS must read the cookie. */
  readonly httpOnly?: boolean;
  /** Default `'lax'`, and always emitted. */
  readonly sameSite?: 'strict' | 'lax' | 'none';
};

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
 * A legal `Path` attribute: a leading `/`, then printable ASCII minus
 * space, `;` and `,`.  RFC 6265 forbids only control characters and `;`
 * there, but `;` alone is the whole attack — `path: '/;Domain=evil.example'`
 * appends a second attribute, and because §5.3 keeps the LAST `Domain` seen
 * it would override a legitimate one rather than lose to it.  Space and `,`
 * are excluded too: both are header-list delimiters, so a value carrying
 * one survives us and confuses whatever folds or splits `Set-Cookie` next.
 * Non-ASCII is rejected rather than guessed at — percent-encode it.
 */
const COOKIE_PATH_RE = /^\/[\x21-\x2b\x2d-\x3a\x3c-\x7e]*$/;

/**
 * A legal `Domain` attribute: RFC 1123 labels, optionally with the legacy
 * leading dot (browsers strip it, and applications still write it).  The
 * label alphabet is ASCII by construction, which is what makes this both an
 * injection guard and a correctness one — an internationalised domain has
 * to arrive already punycoded (`xn--…`), because a raw Unicode `Domain` is
 * not something a browser will match against either.
 */
const COOKIE_DOMAIN_RE = /^\.?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

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
 * Serialise one `Set-Cookie` value.  Unmentioned attributes default to the
 * strict end — `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` — so
 * `serializeCookie('session', id)` is a cookie you can ship, and the
 * result also satisfies the `__Host-` prefix rules without further
 * argument.  A cookie that same-origin JS has to read, or one served over
 * plain HTTP, says so explicitly (`httpOnly: false` / `secure: false`).
 *
 * THROWS on an invalid name; a value containing an illegal character; a
 * `Path` or `Domain` that is not one (both go into the header verbatim, so
 * both are an attribute-injection vector); an invalid `expires` Date; a
 * non-integer `maxAgeSeconds`; a `SameSite=None` cookie that isn't
 * `Secure`; or a violated cookie-prefix rule (`__Secure-` needs Secure;
 * `__Host-` needs Secure + Path=/ + no Domain).  Value is emitted verbatim
 * — pre-encode it yourself if needed.
 *
 * The three Secure-related throws now fire only on an explicit
 * `secure: false`, which is the point: they existed to catch a cookie the
 * browser would silently drop, and omitting the attribute no longer
 * produces one.
 */
export function serializeCookie(name: string, value: string, attrs: CookieAttributes = {}): string {
  if (!COOKIE_NAME_RE.test(name)) {
    throw new Error(`serializeCookie: invalid cookie name "${name}"`);
  }
  if (ILLEGAL_COOKIE_VALUE.test(value)) {
    throw new Error('serializeCookie: cookie value contains an illegal character');
  }
  const secure = attrs.secure ?? true;
  const httpOnly = attrs.httpOnly ?? true;
  const sameSite = attrs.sameSite ?? 'lax';
  const path = attrs.path ?? '/';
  if (!COOKIE_PATH_RE.test(path)) {
    throw new Error(`serializeCookie: invalid cookie path "${path}"`);
  }
  if (attrs.domain !== undefined && !COOKIE_DOMAIN_RE.test(attrs.domain)) {
    throw new Error(`serializeCookie: invalid cookie domain "${attrs.domain}"`);
  }
  if (sameSite === 'none' && !secure) {
    throw new Error('serializeCookie: SameSite=None requires Secure');
  }
  if (name.startsWith('__Secure-') && !secure) {
    throw new Error('serializeCookie: the "__Secure-" prefix requires Secure');
  }
  if (name.startsWith('__Host-') && (!secure || path !== '/' || attrs.domain !== undefined)) {
    throw new Error('serializeCookie: the "__Host-" prefix requires Secure, Path=/, and no Domain');
  }
  if (attrs.maxAgeSeconds !== undefined && !Number.isInteger(attrs.maxAgeSeconds)) {
    throw new Error('serializeCookie: maxAgeSeconds must be an integer');
  }
  // An invalid Date stringifies to `Expires=Invalid Date`, which a browser
  // discards along with the rest of the attribute — a silently sessionised
  // cookie rather than an error anyone notices.
  if (attrs.expires !== undefined && Number.isNaN(attrs.expires.getTime())) {
    throw new Error('serializeCookie: expires must be a valid Date');
  }

  const parts = [`${name}=${value}`];
  if (attrs.maxAgeSeconds !== undefined) parts.push(`Max-Age=${attrs.maxAgeSeconds}`);
  if (attrs.expires) parts.push(`Expires=${attrs.expires.toUTCString()}`);
  if (attrs.domain !== undefined) parts.push(`Domain=${attrs.domain}`);
  parts.push(`Path=${path}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  parts.push(`SameSite=${sameSite === 'strict' ? 'Strict' : sameSite === 'lax' ? 'Lax' : 'None'}`);
  return parts.join('; ');
}
