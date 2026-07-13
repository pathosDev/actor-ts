/**
 * Minimal `:param`-style path matcher for WebSocket upgrade routing.
 *
 * The Express backend can't use its router for upgrades (the `upgrade`
 * event bypasses the router entirely, and path-to-regexp drifted between
 * Express 4 and 5), so we match the compiled pattern ourselves — the
 * same dialect as `RouteRegistration.pattern` (`/room/:id`).  No
 * wildcards in v1.
 */

/** Returns captured params if `pathname` matches `pattern`, else `null`. */
export function matchWebsocketPattern(pattern: string, pathname: string): Record<string, string> | null {
  const pSegs = pattern.split('/').filter((s) => s.length > 0);
  const uSegs = pathname.split('/').filter((s) => s.length > 0);
  if (pSegs.length !== uSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pSegs.length; i++) {
    const patternSegment = pSegs[i]!;
    const uriSegment = uSegs[i]!;
    if (patternSegment.startsWith(':')) {
      params[patternSegment.slice(1)] = decodeURIComponent(uriSegment);
    } else if (patternSegment !== uriSegment) {
      return null;
    }
  }
  return params;
}
