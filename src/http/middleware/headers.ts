/**
 * Internal header helpers shared by the response-decorating middleware
 * (CORS, security headers, HSTS, …).  Not part of the public API.
 */
import type { HttpResponse } from '../types.js';

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
  const present = new Set(Object.keys(existing).map((k) => k.toLowerCase()));
  const merged: Record<string, string> = { ...existing };
  for (const [k, v] of Object.entries(add)) {
    if (!options.overwrite && present.has(k.toLowerCase())) continue;
    merged[k] = v;
  }
  return { ...response, headers: merged };
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
