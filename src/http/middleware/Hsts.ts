/**
 * HTTP Strict-Transport-Security middleware.
 *
 * Sets the `Strict-Transport-Security` header unconditionally (no HTTPS
 * gating): an `HttpRequest` carries no scheme, framework servers usually
 * sit behind a TLS-terminating proxy, and per RFC 6797 §8.1 browsers
 * ignore the header over plain HTTP anyway — so a plain-HTTP dev server is
 * a harmless no-op.
 */
import type { Middleware } from '../Route.js';
import { applyHeaders } from './headers.js';
import type { HstsOptions, HstsOptionsType } from './HstsOptions.js';

export interface ResolvedHsts {
  readonly maxAge: number;
  readonly includeSubDomains: boolean;
  readonly preload: boolean;
}

const ONE_YEAR_SECONDS = 31_536_000;

/** Apply defaults + validate an HSTS options bag (shared with securityHeaders). */
export function resolveHsts(options: Partial<HstsOptionsType>): ResolvedHsts {
  const resolved: ResolvedHsts = {
    maxAge: options.maxAge ?? 15_552_000, // 180 days
    includeSubDomains: options.includeSubDomains ?? true,
    preload: options.preload ?? false,
  };
  // hstspreload.org submission rules — refuse a policy that could never
  // actually be preloaded rather than emitting a silently-useless header.
  if (resolved.preload && (resolved.maxAge < ONE_YEAR_SECONDS || !resolved.includeSubDomains)) {
    throw new Error('HSTS preload requires maxAge >= 31536000 (1 year) and includeSubDomains');
  }
  return resolved;
}

/** Format the resolved policy as the header value. */
export function hstsHeaderValue(r: ResolvedHsts): string {
  let value = `max-age=${r.maxAge}`;
  if (r.includeSubDomains) value += '; includeSubDomains';
  if (r.preload) value += '; preload';
  return value;
}

/**
 * Build a middleware that adds `Strict-Transport-Security` to every
 * response (without clobbering one a handler already set).
 */
export function strictTransportSecurity(options: HstsOptions = {}): Middleware {
  const value = hstsHeaderValue(resolveHsts(options as Partial<HstsOptionsType>));
  return async (_req, next) => applyHeaders(await next(), { 'strict-transport-security': value });
}

/** Short alias for {@link strictTransportSecurity}. */
export const hsts = strictTransportSecurity;
