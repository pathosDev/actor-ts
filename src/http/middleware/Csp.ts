/**
 * Content-Security-Policy middleware — a small, typed, helmet-parity CSP
 * builder.  Nonce support is intentionally omitted for now (the framework
 * has no template/SSR integration to consume a per-request nonce); a
 * handler that needs one generates it and sets its own CSP header, and
 * this middleware backs off because it never overwrites a header the
 * handler already set.
 */
import type { Middleware } from '../Route.js';
import { applyHeaders } from './headers.js';
import type { CspDirectives, CspOptions, CspOptionsType } from './CspOptions.js';

/** helmet-parity baseline, merged under user directives when `useDefaults`. */
const BASELINE: CspDirectives = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  fontSrc: ["'self'", 'https:', 'data:'],
  formAction: ["'self'"],
  frameAncestors: ["'self'"],
  imgSrc: ["'self'", 'data:'],
  objectSrc: ["'none'"],
  scriptSrc: ["'self'"],
  scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
  upgradeInsecureRequests: true,
};

/** Emission order + camelCase→kebab-case directive names for list-valued directives. */
const LIST_DIRECTIVES: ReadonlyArray<readonly [keyof CspDirectives, string]> = [
  ['defaultSrc', 'default-src'],
  ['scriptSrc', 'script-src'],
  ['scriptSrcAttr', 'script-src-attr'],
  ['styleSrc', 'style-src'],
  ['imgSrc', 'img-src'],
  ['connectSrc', 'connect-src'],
  ['fontSrc', 'font-src'],
  ['objectSrc', 'object-src'],
  ['mediaSrc', 'media-src'],
  ['frameSrc', 'frame-src'],
  ['frameAncestors', 'frame-ancestors'],
  ['baseUri', 'base-uri'],
  ['formAction', 'form-action'],
  ['workerSrc', 'worker-src'],
  ['manifestSrc', 'manifest-src'],
  ['reportUri', 'report-uri'],
];

/** A source token may not contain characters that would break out of the directive. */
function assertSafeToken(token: string, directive: string): void {
  if (/[;,]/.test(token) || /\s/.test(token)) {
    throw new Error(`contentSecurityPolicy: invalid source "${token}" in ${directive} (no ";", ",", or whitespace)`);
  }
}

function serialize(directives: CspDirectives): string {
  const parts: string[] = [];
  for (const [key, name] of LIST_DIRECTIVES) {
    const sources = directives[key] as readonly string[] | undefined;
    if (!sources || sources.length === 0) continue; // absent or explicitly emptied → dropped
    for (const s of sources) assertSafeToken(s, name);
    parts.push(`${name} ${sources.join(' ')}`);
  }
  if (directives.reportTo) {
    assertSafeToken(directives.reportTo, 'report-to');
    parts.push(`report-to ${directives.reportTo}`);
  }
  if (directives.upgradeInsecureRequests) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

/** Build a middleware that adds a Content-Security-Policy header. */
export function contentSecurityPolicy(options: CspOptions = {}): Middleware {
  const resolvedOptions = options as Partial<CspOptionsType>;
  const useDefaults = resolvedOptions.useDefaults ?? true;
  const merged: CspDirectives = useDefaults ? { ...BASELINE, ...(resolvedOptions.directives ?? {}) } : (resolvedOptions.directives ?? {});
  const value = serialize(merged);
  const header = (resolvedOptions.reportOnly ?? false) ? 'content-security-policy-report-only' : 'content-security-policy';
  return async (_req, next) => applyHeaders(await next(), { [header]: value });
}
