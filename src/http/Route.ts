import { match } from 'ts-pattern';
import type { ActorSystem } from '../ActorSystem.js';
import { HttpError, type HttpMethod, type HttpRequest, type HttpResponse, Status } from './types.js';
import type { WebsocketSocketAdapter } from './websocket/SocketAdapter.js';
import { expandCors, type CorsRouteSettings } from './middleware/Cors.js';

/**
 * A compiled HTTP route — the Route-DSL reduces to a list of these
 * (plus {@link CompiledWebsocketRoute}s), which the HTTP backend
 * registers in its native routing table.
 */
export interface CompiledRoute {
  readonly kind: 'http';
  readonly method: HttpMethod;
  readonly pattern: string;
  readonly handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;
}

/**
 * Framework-owned entry point for one accepted WebSocket connection.
 * The backend never sees actors — it only hands us the upgrade request
 * and a normalised socket; the closure (built by the `websocket()`
 * directive) owns the codec, target ref and per-route policy.
 */
export type WebsocketConnectHandler = (
  system: ActorSystem,
  req: HttpRequest,
  socket: WebsocketSocketAdapter,
) => void;

/**
 * A compiled WebSocket route.  Occupies the `GET` verb at its pattern
 * (that's how the HTTP upgrade arrives).  `authorize` folds any
 * enclosing `withMiddleware(...)` — it runs once, against the upgrade
 * request, and returns `null` to accept or an {@link HttpResponse} to
 * reject the upgrade with a plain HTTP response.
 */
export interface CompiledWebsocketRoute {
  readonly kind: 'websocket';
  readonly method: 'GET';
  readonly pattern: string;
  readonly connect: WebsocketConnectHandler;
  readonly authorize: (req: HttpRequest) => Promise<HttpResponse | null>;
}

/**
 * A compiled fallback — answers any request that matched no other route.
 * Wired to the backend's not-found hook at bind time (exactly one per
 * server), so unlike {@link CompiledRoute} it carries no method or pattern.
 */
export interface CompiledFallback {
  readonly kind: 'fallback';
  readonly handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;
}

/** A compiled endpoint: a plain HTTP route, a WebSocket route, or the fallback. */
export type CompiledEndpoint = CompiledRoute | CompiledWebsocketRoute | CompiledFallback;

/**
 * Per-request hook that runs around a handler.  Receives the request
 * and a `next()` thunk; either short-circuit by returning your own
 * response, or call `next()` and pass its result through (optionally
 * wrapped, decorated, or re-thrown).
 *
 * `next()` optionally takes a **replacement request** — pass one to
 * enrich what the handler (and any inner middleware) sees, e.g. to inject
 * a generated request id or a verified CSRF token as a header.  Omit the
 * argument to forward the request unchanged; the two forms are otherwise
 * identical, so existing `next()` call sites keep working.
 *
 * Examples (all shipped in `src/http/middleware/`):
 *   - `BearerTokenAuth({ tokens })` — checks `Authorization: Bearer`,
 *     short-circuits with 401 on mismatch.
 *   - `IpAllowlist({ allow })` — checks `remoteAddress` (or a
 *     configured extractor) against a CIDR list, short-circuits
 *     with 403 if not allowed.
 *
 * Throwing `HttpError(status, msg)` is the idiomatic short-circuit:
 * the global error handler catches it and emits the right response.
 */
export type Middleware = (
  req: HttpRequest,
  next: (req?: HttpRequest) => Promise<HttpResponse>,
) => Promise<HttpResponse> | HttpResponse;

/**
 * Node type emitted by DSL builders like `path(...)`, `get(...)`.  Internal
 * representation is a tree that knows how to flatten into CompiledRoutes.
 */
export type Route =
  | { readonly kind: 'terminal'; readonly method: HttpMethod; readonly handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse }
  | { readonly kind: 'path'; readonly segment: string; readonly child: Route }
  | { readonly kind: 'concat'; readonly routes: ReadonlyArray<Route> }
  | { readonly kind: 'middleware'; readonly middleware: Middleware; readonly child: Route }
  | { readonly kind: 'websocket'; readonly connect: WebsocketConnectHandler }
  | { readonly kind: 'fallback'; readonly handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse }
  | { readonly kind: 'cors'; readonly settings: CorsRouteSettings; readonly child: Route };

/** Compose several sibling routes (OR semantics — first matching wins). */
export function concat(...routes: Route[]): Route {
  return { kind: 'concat', routes };
}

/** Scope all child routes under a static path segment. */
export function path(segment: string, child: Route): Route {
  return { kind: 'path', segment: normalizeSegment(segment), child };
}

/** Scope under a path prefix that may capture dynamic segments. */
export function pathPrefix(segment: string, child: Route): Route {
  return { kind: 'path', segment: normalizeSegment(segment), child };
}

/**
 * Wrap every handler in `child`'s subtree with the given `Middleware`.
 * The middleware runs **before** the handler; it can short-circuit
 * (return without calling `next()`) or transform the response.
 *
 * Nesting composes outside-in: `withMiddleware(a, withMiddleware(b,
 * get(h)))` runs `a` first, then if it calls `next()`, `b` runs, and
 * if `b` calls `next()`, the handler `h` runs.
 *
 *     const protectedRoutes = withMiddleware(
 *       BearerTokenAuth({ tokens: [process.env.MGMT_TOKEN!] }),
 *       withMiddleware(
 *         IpAllowlist({ allow: ['10.0.0.0/8'] }),
 *         path('cluster', concat(
 *           path('down', post(handleDown)),
 *           path('leave', post(handleLeave)),
 *         )),
 *       ),
 *     );
 */
export function withMiddleware(middleware: Middleware, child: Route): Route {
  return { kind: 'middleware', middleware, child };
}

/**
 * Handler for {@link handleErrors}.  Receives the thrown value (an
 * {@link HttpError} or anything else) plus the request; return an
 * {@link HttpResponse} to handle it, or `null`/`undefined` to decline —
 * declining re-throws so an outer `handleErrors` (or, failing that, the
 * backend's default mapping) takes over.
 */
export type ExceptionHandler = (
  err: unknown,
  req: HttpRequest,
) => Promise<HttpResponse | null | undefined> | HttpResponse | null | undefined;

/**
 * Scope an exception handler over `child`'s subtree — the akka-http
 * `ExceptionHandler` analogue, implemented as sugar over a `middleware`
 * node so it inherits handler-wrapping (and the WebSocket authorize fold)
 * for free.
 *
 * The handler sees the ORIGINAL thrown value — e.g. the `HttpError`
 * instance with its `status` / `extra` / `headers` — because DSL-level
 * wrappers run strictly before any backend's default error mapping.
 * Handlers nest outside-in like {@link withMiddleware}: the innermost
 * `handleErrors` gets first refusal, and returning `null` delegates
 * outward.  Placed around a `withMiddleware(...)` node it also catches
 * that middleware's throws (e.g. an auth 401).
 *
 *     handleErrors(
 *       (err) => err instanceof NotFoundError ? complete(Status.NotFound, ...) : null,
 *       path('users', concat(...)),
 *     )
 */
export function handleErrors(handler: ExceptionHandler, child: Route): Route {
  const middleware: Middleware = async (req, next) => {
    try {
      return await next();
    } catch (err) {
      const recovered = await handler(err, req);
      if (recovered !== null && recovered !== undefined) return recovered;
      throw err; // declined → escalate to the next enclosing handler / default
    }
  };
  return { kind: 'middleware', middleware, child };
}

/**
 * Answer any request that matched no other route — the server-global
 * not-found handler expressed in the DSL.  Wired to the backend's
 * not-found hook at bind time, so it is method-agnostic (it also answers
 * unmatched OPTIONS/HEAD) and MUST sit at the root of the tree: a fallback
 * scoped under `path()` / `pathPrefix()` is rejected at compile time,
 * because a server has exactly one not-found handler.  At most one
 * `fallback()` per server.  It still composes with
 * `withMiddleware()` / `handleErrors()`, which wrap its handler like any
 * other, so a fallback can carry security headers or its own recovery.
 *
 *     concat(
 *       path('api', apiRoutes),
 *       fallback((req) => completeJson(Status.NotFound, { error: 'no route', path: req.path })),
 *     )
 */
export function fallback(handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route {
  return { kind: 'fallback', handler };
}

function normalizeSegment(s: string): string {
  const trimmed = s.replace(/^\/+|\/+$/g, '');
  return trimmed;
}

/* -------------------------- Method combinators ---------------------------- */

function methodRoute(method: HttpMethod, handler: Route['kind'] extends 'terminal' ? never : (req: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route {
  return { kind: 'terminal', method, handler };
}

export const get     = (h: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route => methodRoute('GET', h);
export const post    = (h: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route => methodRoute('POST', h);
export const put     = (h: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route => methodRoute('PUT', h);
export const del     = (h: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route => methodRoute('DELETE', h);
export const patch   = (h: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route => methodRoute('PATCH', h);
export const head    = (h: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route => methodRoute('HEAD', h);
export const options = (h: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route => methodRoute('OPTIONS', h);

/* ------------------------- Convenience responses -------------------------- */

/** Shorthand for `{ status, body }`.  `body` may be a string, object, or bytes. */
export function complete(status: number, body?: HttpResponse['body'], headers?: Record<string, string>): HttpResponse {
  return { status, body: body ?? null, headers };
}

/** JSON response with `application/json`.  Shortcut for the 99% case. */
export function completeJson(status: number, body: unknown, headers?: Record<string, string>): HttpResponse {
  return { status, body: body as object, headers, contentType: 'application/json; charset=utf-8' };
}

/** Plain-text response. */
export function completeText(status: number, body: string, headers?: Record<string, string>): HttpResponse {
  return { status, body, headers, contentType: 'text/plain; charset=utf-8' };
}

/** Redirect — helper around `Status.Found`. */
export function redirect(url: string, status: number = Status.Found): HttpResponse {
  return { status, headers: { location: url }, body: null };
}

/** Rejection — throw to short-circuit to a 4xx/5xx. */
export function reject(status: number, message: string, extra?: Record<string, unknown>): never {
  throw new HttpError(status, message, extra);
}

/**
 * The framework's default error→response mapping: an {@link HttpError}
 * becomes its status + `{ error, ...extra }` JSON (carrying any custom
 * `headers`); anything else becomes a generic 500 that deliberately does
 * NOT echo the thrown message.  Kept in one place so the WebSocket
 * upgrade-reject path and the `fallback()` wrapper map errors identically.
 */
export function defaultErrorResponse(err: unknown): HttpResponse {
  if (err instanceof HttpError) {
    return { status: err.status, headers: err.headers, body: { error: err.message, ...(err.extra ?? {}) } };
  }
  return { status: Status.InternalServerError, body: { error: 'Internal Server Error' } };
}

/* ------------------------------- Compilation ----------------------------- */

/**
 * Sentinel returned by a WS route's inner `authorize` to mean "proceed
 * with the upgrade".  Middleware that calls `next()` and passes the
 * result through untouched yields this exact frozen object (identity
 * check) → accept; anything else → reject the upgrade with that response.
 */
const WS_ACCEPT: HttpResponse = Object.freeze({ status: 101, body: null });

/** Flatten a Route tree into the list of concrete endpoint registrations. */
export function compile(route: Route, prefix: string[] = []): CompiledEndpoint[] {
  return match(route)
    .with({ kind: 'terminal' }, (r): CompiledEndpoint[] => [{
      kind: 'http',
      method: r.method,
      pattern: buildPattern(prefix),
      handler: r.handler,
    }])
    .with({ kind: 'websocket' }, (r): CompiledEndpoint[] => [{
      kind: 'websocket',
      method: 'GET',
      pattern: buildPattern(prefix),
      connect: r.connect,
      // Innermost default: accept unconditionally.  Enclosing
      // withMiddleware() nodes fold their checks into this below.
      authorize: async (): Promise<HttpResponse | null> => null,
    }])
    .with({ kind: 'path' }, (r) => compile(r.child, [...prefix, r.segment]))
    .with({ kind: 'concat' }, (r) => r.routes.flatMap((child) => compile(child, prefix)))
    .with({ kind: 'fallback' }, (r): CompiledEndpoint[] => {
      if (prefix.length > 0) {
        throw new Error(
          'fallback() must sit at the root of the route tree — the not-found '
          + 'handler is server-global, so a fallback scoped under path()/'
          + 'pathPrefix() is not supported.',
        );
      }
      return [{ kind: 'fallback', handler: r.handler }];
    })
    .with({ kind: 'middleware' }, (r): CompiledEndpoint[] => {
      // Compile the subtree, then fold the middleware in.  For HTTP
      // children it wraps the handler (nested middlewares stack
      // outside-in).  For WebSocket children it folds into `authorize`:
      // the middleware runs once, against the upgrade request.
      return compile(r.child, prefix).map((c): CompiledEndpoint => {
        if (c.kind === 'http') {
          return { ...c, handler: wrapHandler(r.middleware, c.handler) };
        }
        if (c.kind === 'fallback') {
          // A fallback under middleware: wrap its handler the same way
          // (the fallback stays root-scoped — middleware doesn't add a
          // path prefix, so the compile-time root guard still holds).
          return { ...c, handler: wrapHandler(r.middleware, c.handler) };
        }
        const inner = c.authorize;
        const authorize = async (req: HttpRequest): Promise<HttpResponse | null> => {
          try {
            const res = await r.middleware(req, async (override?: HttpRequest) => (await inner(override ?? req)) ?? WS_ACCEPT);
            // Identity: middleware passed the sentinel through → accept.
            // Any other response (short-circuit or transform) → reject.
            return res === WS_ACCEPT ? null : res;
          } catch (err) {
            return defaultErrorResponse(err);
          }
        };
        return { ...c, authorize };
      });
    })
    .with({ kind: 'cors' }, (r) => expandCors(compile(r.child, prefix), r.settings))
    .exhaustive();
}

function wrapHandler(
  middleware: Middleware,
  handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse,
): (req: HttpRequest) => Promise<HttpResponse> {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    // `next(override?)` lets a middleware replace the request the handler
    // (and any inner middleware) sees — the override threads through the
    // stacked wraps because each wrap's `handler` is the next-inner one.
    const next = async (override?: HttpRequest): Promise<HttpResponse> =>
      Promise.resolve(handler(override ?? req));
    return Promise.resolve(middleware(req, next));
  };
}

function buildPattern(segments: string[]): string {
  const cleaned = segments
    .flatMap(s => s.split('/'))
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (cleaned.length === 0) return '/';
  return '/' + cleaned.join('/');
}

/* ------------------------ Parameter convenience ---------------------------- */

/**
 * Extract a query parameter as a trimmed string, or undefined.  Array-valued
 * params (e.g. `?x=1&x=2`) return the first value.
 */
export function queryParam(req: HttpRequest, name: string): string | undefined {
  const value = req.query[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Extract a path parameter (guaranteed present by the pattern). */
export function pathParam(req: HttpRequest, name: string): string {
  const value = req.params[name];
  if (value === undefined) throw new HttpError(500, `Missing path parameter "${name}"`);
  return value;
}
