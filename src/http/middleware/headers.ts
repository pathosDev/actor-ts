/**
 * Internal header helpers shared by the response-decorating middleware
 * (CORS, security headers, HSTS, …) and by the backends' WebSocket
 * upgrade-reject path, which has an `HttpResponse` but no framework
 * response object to set headers on.  Not part of the public API.
 */
import type { Middleware } from '../Route.js';
import { HttpError, type HttpResponse } from '../types.js';

/** Merge `add` under `existing`, skipping any key `existing` already carries (case-insensitively). */
function mergeWithoutClobbering(
  existing: Readonly<Record<string, string>>,
  add: Readonly<Record<string, string>>,
): Record<string, string> {
  const present = new Set(Object.keys(existing).map((k) => k.toLowerCase()));
  const merged: Record<string, string> = { ...existing };
  for (const [k, v] of Object.entries(add)) {
    if (present.has(k.toLowerCase())) continue;
    merged[k] = v;
  }
  return merged;
}

/**
 * Return a copy of `response` with `add` merged into its headers.  By default a
 * key the response already carries (compared case-insensitively) is left
 * untouched — so a handler's explicit header wins over a middleware
 * default.  Pass `{ overwrite: true }` to force the middleware value.
 */
export function applyHeaders(
  response: HttpResponse,
  add: Readonly<Record<string, string>>,
  options: { readonly overwrite?: boolean } = {},
): HttpResponse {
  const existing = response.headers ?? {};
  const merged = options.overwrite ? { ...existing, ...add } : mergeWithoutClobbering(existing, add);
  return { ...response, headers: merged };
}

/**
 * The throwing counterpart of {@link applyHeaders}: returns the value to
 * rethrow so that `add` also rides on the response an `HttpError`
 * short-circuit produces.
 *
 * A decorator that only ever touched the *returned* response skipped
 * precisely the responses a CSRF, auth or rate-limit rejection produces,
 * because throwing `HttpError` is the framework's idiomatic short-circuit
 * (see `Middleware` in `Route.js`) and a rejected `await` never reaches the
 * decoration (#606).
 *
 * Returns a **copy** — `HttpError.headers` is readonly, and rewriting a
 * value someone else threw is not this layer's call.  Anything that is not
 * an `HttpError` comes back untouched: it maps to the generic 500 that
 * deliberately carries nothing from the thrown value, and substituting an
 * `HttpError` for it would both hide the original from an enclosing
 * `handleErrors` and turn a crash into a response that claims to be
 * deliberate.  Those responses are covered by the backend seam instead
 * (`newServerAt(…).withSecurityHeaders(…)`), which sees every response.
 */
export function applyHeadersToError(error: unknown, add: Readonly<Record<string, string>>): unknown {
  if (!(error instanceof HttpError)) return error;
  return new HttpError(error.status, error.message, error.extra, mergeWithoutClobbering(error.headers ?? {}, add));
}

/**
 * Build a middleware that stamps a fixed header map on whatever the inner
 * stack produces — the response it returns *and* the `HttpError` it throws.
 * Shared by the header-only decorators (`securityHeaders`,
 * `contentSecurityPolicy`, `strictTransportSecurity`) so the "returned or
 * thrown" invariant has one implementation rather than three.
 */
export function headerDecorator(add: Readonly<Record<string, string>>): Middleware {
  return async (_request, next) => {
    try {
      return applyHeaders(await next(), add);
    } catch (error) {
      throw applyHeadersToError(error, add);
    }
  };
}

/**
 * Merge `Vary` field names into an existing header value,
 * case-insensitively de-duplicated (the first spelling is kept).  Caches
 * must not cross-serve responses that vary by these fields.
 */
export function appendVary(existing: string | undefined, ...fields: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (field: string): void => {
    const trimmed = field.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    out.push(trimmed);
  };
  if (existing) for (const f of existing.split(',')) push(f);
  for (const f of fields) push(f);
  return out.join(', ');
}
