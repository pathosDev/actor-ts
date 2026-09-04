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
import type { HttpMethod, HttpRequest, HttpResponse } from '../Types.js';
import { MAXIMUM_ECHOED_CORS_HEADERS_LENGTH } from '../Constants.js';
import { applyHeaders, appendVary, readHeader } from './Headers.js';
import { CorsOptionsValidator, type CorsOptions, type CorsOptionsType, type CorsOrigin } from './CorsOptions.js';

/** Resolved CORS policy stored on the `cors` Route node. */
export type CorsRouteOptions = {
  readonly origins: CorsOrigin;
  readonly methods?: ReadonlyArray<HttpMethod>;
  readonly allowedHeaders?: ReadonlyArray<string>;
  readonly exposedHeaders?: ReadonlyArray<string>;
  readonly credentials: boolean;
  readonly maxAge?: number;
};

/**
 * Apply the CORS policy to `child`'s subtree.  Validates the options up
 * front: `origins` is required, and `credentials` cannot be combined with
 * `'*'` (the Fetch spec forbids `Access-Control-Allow-Origin: *` with
 * credentials).
 */
export function cors(options: CorsOptions, child: Route): Route {
  const resolvedOptions = options as Partial<CorsOptionsType>;
  if (resolvedOptions.origins === undefined) {
    throw new Error('cors: origins is required — call withOrigins(...), withAnyOrigin(), or withOriginPredicate(...)');
  }
  new CorsOptionsValidator().validate(resolvedOptions);
  const settings: CorsRouteOptions = {
    origins: resolvedOptions.origins,
    methods: resolvedOptions.methods,
    allowedHeaders: resolvedOptions.allowedHeaders,
    exposedHeaders: resolvedOptions.exposedHeaders,
    credentials: resolvedOptions.credentials ?? false,
    maxAge: resolvedOptions.maxAge,
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
function allowOriginValue(settings: CorsRouteOptions, origin: string): string {
  return settings.origins === '*' && !settings.credentials ? '*' : origin;
}

/**
 * RFC 7230 `tchar` — the alphabet of a header *name*, which is the only thing
 * `Access-Control-Request-Headers` carries.  Deliberately the same production
 * as `COOKIE_NAME_RE` in `../Cookies.ts`; both validate an HTTP token.
 */
const REQUEST_HEADER_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Echo the client's requested header names back, keeping only the elements
 * that are legal tokens and bounding the result at
 * {@link MAXIMUM_ECHOED_CORS_HEADERS_LENGTH}.  Never echoes raw client bytes.
 *
 * The value is a comma-separated list of header *names*, so it is validated as
 * one — element by element, an element that is not a token dropped whole —
 * rather than scrubbed character by character.  Its predecessor did the latter
 * and got it backwards (#792): `value.replace(/[^A-Za-z0-9,\s-]/g, '')` is a
 * *negated* class, so every character `\s` matches is a character the class
 * KEEPS.  CR, LF, HTAB and U+00A0 — precisely the class the guard existed to
 * remove — were the ones it preserved, while it stripped only the harmless
 * punctuation around them.
 *
 * No response was ever split by that, and the reason is worth writing down
 * because it was never this function: measured on Bun 1.4.0, Node 26.7.0 and
 * Deno 2.6.8, all three request parsers refuse a bare CR or LF inside a header
 * value (400, or a line break that terminates the field), and every sink the
 * framework writes a response header through — `setHeader` on the
 * Fastify/Express path, `Headers.set` on Hono's — throws `ERR_INVALID_CHAR` /
 * `TypeError` on one.  What did reach the wire was HTAB and U+00A0, which all
 * six of those accept.  Filtering to tokens no longer depends on any of it.
 */
function sanitiseRequestHeaders(value: string): string {
  const names: string[] = [];
  let length = 0;
  for (const element of value.split(',')) {
    const name = element.trim();
    if (!REQUEST_HEADER_TOKEN.test(name)) continue;
    // `, ` between names, so every name after the first costs two more.
    const cost = length === 0 ? name.length : name.length + 2;
    if (length + cost > MAXIMUM_ECHOED_CORS_HEADERS_LENGTH) break;
    names.push(name);
    length += cost;
  }
  return names.join(', ');
}

/** Decorate an actual (non-preflight) response with the CORS headers. */
function decorateResponse(settings: CorsRouteOptions, response: HttpResponse, request: HttpRequest): HttpResponse {
  const origin = request.headers['origin'];
  if (!origin || !isAllowed(settings.origins, origin)) return response;
  const acao = allowOriginValue(settings, origin);
  const add: Record<string, string> = { 'access-control-allow-origin': acao };
  if (settings.credentials) add['access-control-allow-credentials'] = 'true';
  if (settings.exposedHeaders && settings.exposedHeaders.length > 0) {
    add['access-control-expose-headers'] = settings.exposedHeaders.join(', ');
  }
  let out = applyHeaders(response, add);
  // A cache must not serve the wrong origin's response back.  Read the
  // handler's own Vary case-insensitively: an exact-key `['vary']` misses a
  // `Vary: Cookie` and replaces it with a bare `Vary: Origin`, which tells
  // caches it is safe to serve one user's response to the next (#603).
  if (acao !== '*') {
    out = applyHeaders(out, { vary: appendVary(readHeader(out.headers, 'vary'), 'Origin') }, { overwrite: true });
  }
  return out;
}

const PREFLIGHT_VARY = 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers';

/** Build the 204 preflight response for an allowed (or disallowed) origin. */
function preflightResponse(settings: CorsRouteOptions, methods: ReadonlyArray<string>, request: HttpRequest): HttpResponse {
  const origin = request.headers['origin'];
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
    // Nothing legal left to echo → omit the field rather than send an empty
    // one.  Both deny every non-simple header, but only the absent form says
    // so; `Access-Control-Allow-Headers: ` reads as a bug in the server.
    const echoed = sanitiseRequestHeaders(request.headers['access-control-request-headers'] ?? '');
    if (echoed.length > 0) headers['access-control-allow-headers'] = echoed;
  }
  if (settings.credentials) headers['access-control-allow-credentials'] = 'true';
  if (settings.maxAge !== undefined) headers['access-control-max-age'] = String(settings.maxAge);
  return { status: 204, headers, body: null };
}

function isPreflight(request: HttpRequest): boolean {
  return request.headers['origin'] !== undefined && request.headers['access-control-request-method'] !== undefined;
}

/**
 * Expand a `cors` node's compiled children: decorate real responses, fold
 * an origin check into WebSocket upgrades, and synthesise a per-pattern
 * `OPTIONS` preflight (or intercept a user-defined one).
 */
export function expandCors(children: CompiledEndpoint[], settings: CorsRouteOptions): CompiledEndpoint[] {
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
        authorize: async (request: HttpRequest): Promise<HttpResponse | null> => {
          const origin = request.headers['origin'];
          if (origin !== undefined && !isAllowed(settings.origins, origin)) {
            return { status: 403, body: { error: 'cross-origin WebSocket upgrade rejected' } };
          }
          return inner(request);
        },
      });
      continue;
    }
    if (c.kind === 'fallback') {
      const handler = c.handler;
      out.push({ ...c, handler: async (request) => decorateResponse(settings, await handler(request), request) });
      continue;
    }
    // http
    if (c.method === 'OPTIONS') {
      patternsWithOptions.add(c.pattern);
      const methods = [...(methodsByPattern.get(c.pattern) ?? new Set<string>())];
      const userHandler = c.handler;
      out.push({
        ...c,
        handler: async (request) => isPreflight(request) ? preflightResponse(settings, methods, request) : decorateResponse(settings, await userHandler(request), request),
      });
    } else {
      const handler = c.handler;
      out.push({ ...c, handler: async (request) => decorateResponse(settings, await handler(request), request) });
    }
  }

  for (const [pattern, methods] of methodsByPattern) {
    if (patternsWithOptions.has(pattern)) continue;
    const methodList = [...methods];
    out.push({
      kind: 'http',
      method: 'OPTIONS',
      pattern,
      handler: (request: HttpRequest) => preflightResponse(settings, methodList, request),
    });
  }

  return out;
}
