/**
 * CORS as a route directive.  A plain middleware cannot do CORS correctly:
 * a preflight `OPTIONS` to a `GET`-only pattern never matches a compiled
 * route, so no middleware would run.  Instead `cors(options, child)` is a
 * dedicated Route kind that the compiler expands via {@link expandCors} —
 * decorating the real responses AND synthesising an `OPTIONS` preflight
 * route per pattern.
 *
 * Ordering: place `cors()` OUTSIDE any auth middleware.  The synthesised
 * preflight routes are ordinary children of an enclosing
 * `withMiddleware(...)`, and preflights are anonymous by spec — wrapping
 * them in auth would 401 every preflight.
 */
import type { CompiledEndpoint, Route } from '../Route.js';
import type { HttpMethod, HttpRequest, HttpResponse } from '../types.js';
import { applyHeaders, appendVary } from './headers.js';
import type { CorsOptions, CorsOptionsType, CorsOrigin } from './CorsOptions.js';

/** Resolved CORS policy stored on the `cors` Route node. */
export interface CorsRouteSettings {
  readonly origins: CorsOrigin;
  readonly methods?: ReadonlyArray<HttpMethod>;
  readonly allowedHeaders?: ReadonlyArray<string>;
  readonly exposedHeaders?: ReadonlyArray<string>;
  readonly credentials: boolean;
  readonly maxAge?: number;
}

/**
 * Apply the CORS policy to `child`'s subtree.  Validates the options up
 * front: `origins` is required, and `credentials` cannot be combined with
 * `'*'` (the Fetch spec forbids `Access-Control-Allow-Origin: *` with
 * credentials).
 */
export function cors(options: CorsOptions, child: Route): Route {
  const o = options as Partial<CorsOptionsType>;
  if (o.origins === undefined) {
    throw new Error('cors: origins is required — call withOrigins(...), withAnyOrigin(), or withOriginPredicate(...)');
  }
  if (o.credentials && o.origins === '*') {
    throw new Error('cors: credentials cannot be combined with "*" origins (the Fetch spec forbids it)');
  }
  const settings: CorsRouteSettings = {
    origins: o.origins,
    methods: o.methods,
    allowedHeaders: o.allowedHeaders,
    exposedHeaders: o.exposedHeaders,
    credentials: o.credentials ?? false,
    maxAge: o.maxAge,
  };
  return { kind: 'cors', settings, child };
}

function isAllowed(origins: CorsOrigin, origin: string): boolean {
  if (origins === '*') return true;
  if (typeof origins === 'function') {
    try { return origins(origin); } catch { return false; }
  }
  return origins.includes(origin);
}

/** Echo the request origin, or literal `*` only when wildcard AND not credentialed. */
function allowOriginValue(settings: CorsRouteSettings, origin: string): string {
  return settings.origins === '*' && !settings.credentials ? '*' : origin;
}

/** Never echo raw client bytes into a response header: keep only token chars, cap length. */
function sanitiseRequestHeaders(value: string): string {
  return value.replace(/[^A-Za-z0-9,\s-]/g, '').slice(0, 1024);
}

/** Decorate an actual (non-preflight) response with the CORS headers. */
function decorateResponse(settings: CorsRouteSettings, res: HttpResponse, req: HttpRequest): HttpResponse {
  const origin = req.headers['origin'];
  if (!origin || !isAllowed(settings.origins, origin)) return res;
  const acao = allowOriginValue(settings, origin);
  const add: Record<string, string> = { 'access-control-allow-origin': acao };
  if (settings.credentials) add['access-control-allow-credentials'] = 'true';
  if (settings.exposedHeaders && settings.exposedHeaders.length > 0) {
    add['access-control-expose-headers'] = settings.exposedHeaders.join(', ');
  }
  let out = applyHeaders(res, add);
  // A cache must not serve the wrong origin's response back.
  if (acao !== '*') {
    out = applyHeaders(out, { vary: appendVary(out.headers?.['vary'], 'Origin') }, { overwrite: true });
  }
  return out;
}

const PREFLIGHT_VARY = 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers';

/** Build the 204 preflight response for an allowed (or disallowed) origin. */
function preflightResponse(settings: CorsRouteSettings, methods: ReadonlyArray<string>, req: HttpRequest): HttpResponse {
  const origin = req.headers['origin'];
  if (!origin || !isAllowed(settings.origins, origin)) {
    // No ACA-* headers → the browser fails the preflight; no info leak.
    return { status: 204, headers: { vary: PREFLIGHT_VARY }, body: null };
  }
  const headers: Record<string, string> = {
    vary: PREFLIGHT_VARY,
    'access-control-allow-origin': allowOriginValue(settings, origin),
    'access-control-allow-methods': (settings.methods ?? methods).join(', '),
  };
  if (settings.allowedHeaders && settings.allowedHeaders.length > 0) {
    headers['access-control-allow-headers'] = settings.allowedHeaders.join(', ');
  } else {
    const requested = req.headers['access-control-request-headers'];
    if (requested) headers['access-control-allow-headers'] = sanitiseRequestHeaders(requested);
  }
  if (settings.credentials) headers['access-control-allow-credentials'] = 'true';
  if (settings.maxAge !== undefined) headers['access-control-max-age'] = String(settings.maxAge);
  return { status: 204, headers, body: null };
}

function isPreflight(req: HttpRequest): boolean {
  return req.headers['origin'] !== undefined && req.headers['access-control-request-method'] !== undefined;
}

/**
 * Expand a `cors` node's compiled children: decorate real responses, fold
 * an origin check into WebSocket upgrades, and synthesise a per-pattern
 * `OPTIONS` preflight (or intercept a user-defined one).
 */
export function expandCors(children: CompiledEndpoint[], settings: CorsRouteSettings): CompiledEndpoint[] {
  // Methods registered per pattern (a WS route occupies GET).
  const methodsByPattern = new Map<string, Set<string>>();
  const record = (pattern: string, method: string): void => {
    const set = methodsByPattern.get(pattern) ?? new Set<string>();
    set.add(method);
    methodsByPattern.set(pattern, set);
  };
  for (const c of children) {
    if (c.kind === 'http') record(c.pattern, c.method);
    else if (c.kind === 'websocket') record(c.pattern, 'GET');
  }

  const out: CompiledEndpoint[] = [];
  const patternsWithOptions = new Set<string>();

  for (const c of children) {
    if (c.kind === 'websocket') {
      const inner = c.authorize;
      out.push({
        ...c,
        authorize: async (req: HttpRequest): Promise<HttpResponse | null> => {
          const origin = req.headers['origin'];
          if (origin !== undefined && !isAllowed(settings.origins, origin)) {
            return { status: 403, body: { error: 'cross-origin WebSocket upgrade rejected' } };
          }
          return inner(req);
        },
      });
      continue;
    }
    if (c.kind === 'fallback') {
      const handler = c.handler;
      out.push({ ...c, handler: async (req) => decorateResponse(settings, await handler(req), req) });
      continue;
    }
    // http
    if (c.method === 'OPTIONS') {
      patternsWithOptions.add(c.pattern);
      const methods = [...(methodsByPattern.get(c.pattern) ?? new Set<string>())];
      const userHandler = c.handler;
      out.push({
        ...c,
        handler: async (req) => isPreflight(req) ? preflightResponse(settings, methods, req) : decorateResponse(settings, await userHandler(req), req),
      });
    } else {
      const handler = c.handler;
      out.push({ ...c, handler: async (req) => decorateResponse(settings, await handler(req), req) });
    }
  }

  for (const [pattern, methods] of methodsByPattern) {
    if (patternsWithOptions.has(pattern)) continue;
    const methodList = [...methods];
    out.push({
      kind: 'http',
      method: 'OPTIONS',
      pattern,
      handler: (req: HttpRequest) => preflightResponse(settings, methodList, req),
    });
  }

  return out;
}
