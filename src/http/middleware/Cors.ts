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
import { ConfigError, type Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { MAXIMUM_ECHOED_CORS_HEADERS_LENGTH } from '../Constants.js';
import { applyHeaders, appendVary, readHeader } from './Headers.js';
import {
  CORS_WILDCARD_ORIGIN,
  CorsOptionsValidator,
  DEFAULT_CORS_CREDENTIALS,
  type CorsOptions,
  type CorsOptionsType,
  type CorsOrigin,
} from './CorsOptions.js';

/** Resolved CORS policy — what {@link expandCors} decorates responses from. */
export type CorsRouteOptions = {
  readonly origins: CorsOrigin;
  readonly methods?: ReadonlyArray<HttpMethod>;
  readonly allowedHeaders?: ReadonlyArray<string>;
  readonly exposedHeaders?: ReadonlyArray<string>;
  readonly credentials: boolean;
  readonly maxAge?: number;
};

/**
 * Apply the CORS policy to `child`'s subtree.
 *
 * The options are carried on the node **unresolved** and merged with
 * `actor-ts.http.cors` by {@link resolveCorsPolicy} when the tree is compiled
 * (#878).  They cannot be resolved here: a route tree is built before any
 * `ActorSystem` exists, so this function has no configuration to merge and no
 * way to tell "the caller set nothing" from "the caller set nothing *and* the
 * deployment set nothing either".
 *
 * What still happens here is the half that needs no configuration — the
 * options a caller actually wrote are validated against each other, so
 * `withAnyOrigin().withCredentials()` throws at construction as it always has.
 * Only the **required-`origins`** check moved to the compile step, because a
 * config file is now allowed to be the sole source of `origins`.
 */
export function cors(options: CorsOptions, child: Route): Route {
  const routeOptions = options as Partial<CorsOptionsType>;
  new CorsOptionsValidator().validate(routeOptions);
  return { kind: 'cors', options: routeOptions, child };
}

/**
 * Merge a `cors()` node's route options with `actor-ts.http.cors` — route
 * options > HOCON > built-in defaults, per field, `undefined` on the higher
 * layer falling through rather than shadowing.
 *
 * `config` is optional because `compile()` is a public export that predates
 * the configuration layer: a caller compiling a tree outside an `ActorSystem`
 * gets exactly the pre-#878 behaviour, which is the built-in defaults and
 * whatever the route named.
 *
 * All six leaves are read here; only two of them ship a value in
 * `reference.conf`.  The other four are comment-only there because a published
 * literal would be worse than no key at all: `methods` and `allowedHeaders`
 * have *computed* defaults (the methods registered at each pattern, and the
 * echoed request headers) that a fleet-wide literal would override, `maxAge`
 * unset means no `Access-Control-Max-Age` header is sent at all, and a shipped
 * `origins` would satisfy the required-origins guard below for every route in
 * the process — turning a misconfigured `cors({}, routes)` from a loud error
 * into a silent deny-all.
 */
export function resolveCorsPolicy(options: Partial<CorsOptionsType>, config?: Config): CorsRouteOptions {
  const fromConfig = readCorsOptionsFromConfig(config);
  const merged: Partial<CorsOptionsType> = {
    origins: options.origins ?? fromConfig.origins,
    methods: options.methods ?? fromConfig.methods,
    allowedHeaders: options.allowedHeaders ?? fromConfig.allowedHeaders,
    exposedHeaders: options.exposedHeaders ?? fromConfig.exposedHeaders,
    credentials: options.credentials ?? fromConfig.credentials,
    maxAge: options.maxAge ?? fromConfig.maxAge,
  };
  if (merged.origins === undefined) {
    throw new Error(
      'cors: origins is required — call withOrigins(...), withAnyOrigin(), or '
      + `withOriginPredicate(...), or set ${ConfigKeys.http.cors.origins} in your configuration`,
    );
  }
  new CorsOptionsValidator().validate(merged);
  return {
    origins: merged.origins,
    methods: merged.methods,
    allowedHeaders: merged.allowedHeaders,
    exposedHeaders: merged.exposedHeaders,
    credentials: merged.credentials ?? DEFAULT_CORS_CREDENTIALS,
    maxAge: merged.maxAge,
  };
}

/**
 * The `actor-ts.http.cors` layer, as a partial — an absent leaf stays
 * `undefined` so the layer below it is reached, rather than being punched
 * through with a default.
 *
 * Values are read raw and left to {@link CorsOptionsValidator} on the merged
 * result, the same shape `resolveWebsocketPolicy` uses, with one exception:
 * `origins` is the one field a configuration file must not be able to widen,
 * so its check is here and throws a `ConfigError` naming the key.
 */
function readCorsOptionsFromConfig(config?: Config): Partial<CorsOptionsType> {
  const keys = ConfigKeys.http.cors;
  if (config === undefined || !config.hasPath(keys.root)) return {};
  return {
    origins: config.hasPath(keys.origins) ? configuredOrigins(config, keys.origins) : undefined,
    methods: config.hasPath(keys.methods) ? (config.getStringList(keys.methods) as HttpMethod[]) : undefined,
    allowedHeaders: config.hasPath(keys.allowedHeaders) ? config.getStringList(keys.allowedHeaders) : undefined,
    exposedHeaders: config.hasPath(keys.exposedHeaders) ? config.getStringList(keys.exposedHeaders) : undefined,
    credentials: config.hasPath(keys.credentials) ? config.getBoolean(keys.credentials) : undefined,
    // `getInt`, never `getDuration`.  The field is a count of SECONDS written
    // straight into `Access-Control-Max-Age`, while `getDuration` answers in
    // milliseconds — so reading `1h` that way would emit `3600000`, a 1000x
    // error no gate in this repository would catch.  A bare integer it is.
    maxAge: config.hasPath(keys.maxAge) ? config.getInt(keys.maxAge) : undefined,
  };
}

/**
 * The configured allowlist, with the wildcard refused.
 *
 * `withAnyOrigin()` is documented as the explicit opt-in — "must be explicit,
 * no accidental wildcard" — and #128 was filed because CORS defaults were too
 * permissive.  A config file that can write `origins = ["*"]` re-opens exactly
 * that: one line in an `application.conf`, applying to every `cors()` route in
 * the process, turning an allowlist into "everyone".  So the wildcard has no
 * path through HOCON at all, and neither does the predicate arm, which is a
 * function and could not have one.
 */
function configuredOrigins(config: Config, key: string): ReadonlyArray<string> {
  const origins = config.getStringList(key);
  if (origins.includes(CORS_WILDCARD_ORIGIN)) {
    throw new ConfigError(
      `Config at "${key}" must not contain "${CORS_WILDCARD_ORIGIN}" — allowing every origin is `
      + 'code-only (withAnyOrigin()), so that a configuration file cannot widen a route\'s CORS '
      + 'policy to any origin.',
    );
  }
  return origins;
}

function isAllowed(origins: CorsOrigin, origin: string): boolean {
  if (origins === CORS_WILDCARD_ORIGIN) return true;
  if (typeof origins === 'function') {
    try { return origins(origin); } catch { return false; }
  }
  return origins.includes(origin);
}

/** Echo the request origin, or literal `*` only when wildcard AND not credentialed. */
function allowOriginValue(settings: CorsRouteOptions, origin: string): string {
  return settings.origins === CORS_WILDCARD_ORIGIN && !settings.credentials ? CORS_WILDCARD_ORIGIN : origin;
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
