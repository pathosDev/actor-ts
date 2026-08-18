/**
 * HTML response helpers with escaping by default.
 *
 * The escaping primitives themselves live in `util/Html.ts` — `io/broker`
 * renders HTML too (mail bodies) and must not import from `http`.  They
 * are re-exported here so this module stays the one import path an HTTP
 * handler needs.
 */

import type { HttpResponse } from './Types.js';
import { SafeHtml } from '../util/Html.js';

export { escapeHtml, html, rawHtml, SafeHtml } from '../util/Html.js';

/**
 * Build an HTML response: `text/html; charset=utf-8` plus
 * `X-Content-Type-Options: nosniff` (so the declared type is honoured).
 * Accepts a {@link SafeHtml} (the safe path) or a raw string (the caller
 * asserting it is safe).  Supplied `headers` win on key collision.
 */
export function completeHtml(
  status: number,
  body: string | SafeHtml,
  headers?: Record<string, string>,
): HttpResponse {
  return {
    status,
    body: body instanceof SafeHtml ? body.value : body,
    contentType: 'text/html; charset=utf-8',
    headers: { 'x-content-type-options': 'nosniff', ...headers },
  };
}
