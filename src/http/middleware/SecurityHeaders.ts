/**
 * A small, typed, helmet-style bundle of sensible security response
 * headers.  Every header is overridable and disable-able (`false`), the
 * handler's own header always wins, and CSP is deliberately excluded (too
 * app-specific — see {@link contentSecurityPolicy}).
 */
import type { Middleware } from '../Route.js';
import { applyHeaders } from './headers.js';
import { hstsHeaderValue, resolveHsts } from './Hsts.js';
import type { SecurityHeadersOptions, SecurityHeadersOptionsType } from './SecurityHeadersOptions.js';

const FEATURE_RE = /^[a-z][a-z-]*$/;

function serializePermissionsPolicy(policy: Readonly<Record<string, readonly string[]>>): string {
  const parts: string[] = [];
  for (const [feature, allow] of Object.entries(policy)) {
    if (!FEATURE_RE.test(feature)) {
      throw new Error(`securityHeaders: invalid Permissions-Policy feature "${feature}"`);
    }
    for (const item of allow) {
      if (/[,()]/.test(item)) {
        throw new Error(`securityHeaders: invalid Permissions-Policy allowlist item "${item}" for "${feature}"`);
      }
    }
    parts.push(`${feature}=(${allow.join(' ')})`);
  }
  return parts.join(', ');
}

/** Build a middleware that adds the configured security headers to every response. */
export function securityHeaders(options: SecurityHeadersOptions = {}): Middleware {
  const resolvedOptions = options as Partial<SecurityHeadersOptionsType>;
  const headers: Record<string, string> = {};

  if (resolvedOptions.contentTypeOptions ?? true) headers['x-content-type-options'] = 'nosniff';

  const frame = resolvedOptions.frameOptions ?? 'DENY';
  if (frame !== false) headers['x-frame-options'] = frame;

  const referrer = resolvedOptions.referrerPolicy ?? 'no-referrer';
  if (referrer !== false) headers['referrer-policy'] = referrer;

  const coop = resolvedOptions.crossOriginOpenerPolicy ?? 'same-origin';
  if (coop !== false) headers['cross-origin-opener-policy'] = coop;

  const corp = resolvedOptions.crossOriginResourcePolicy ?? 'same-origin';
  if (corp !== false) headers['cross-origin-resource-policy'] = corp;

  const coep = resolvedOptions.crossOriginEmbedderPolicy ?? false;
  if (coep !== false) headers['cross-origin-embedder-policy'] = coep;

  if (resolvedOptions.xssProtection ?? true) headers['x-xss-protection'] = '0';

  const pp = resolvedOptions.permissionsPolicy ?? false;
  if (pp !== false) headers['permissions-policy'] = serializePermissionsPolicy(pp);

  const hstsOpt = resolvedOptions.hsts ?? false;
  if (hstsOpt !== false) headers['strict-transport-security'] = hstsHeaderValue(resolveHsts(hstsOpt));

  return async (_req, next) => applyHeaders(await next(), headers);
}
