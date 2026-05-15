import { match } from 'ts-pattern';
import { HttpError, type HttpMethod, type HttpRequest, type HttpResponse, Status } from './types.js';

/**
 * A compiled route — the Route-DSL reduces to a list of these, which the
 * HTTP backend registers in its native routing table.
 */
export interface CompiledRoute {
  readonly method: HttpMethod;
  readonly pattern: string;
  readonly handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;
}

/**
 * Per-request hook that runs around a handler.  Receives the request
 * and a `next()` thunk; either short-circuit by returning your own
 * response, or call `next()` and pass its result through (optionally
 * wrapped, decorated, or re-thrown).
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
  next: () => Promise<HttpResponse>,
) => Promise<HttpResponse> | HttpResponse;

/**
 * Node type emitted by DSL builders like `path(...)`, `get(...)`.  Internal
 * representation is a tree that knows how to flatten into CompiledRoutes.
 */
export type Route =
  | { readonly kind: 'terminal'; readonly method: HttpMethod; readonly handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse }
  | { readonly kind: 'path'; readonly segment: string; readonly child: Route }
  | { readonly kind: 'concat'; readonly routes: ReadonlyArray<Route> }
  | { readonly kind: 'middleware'; readonly middleware: Middleware; readonly child: Route };

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

/* ------------------------------- Compilation ----------------------------- */

/** Flatten a Route tree into the list of concrete route registrations. */
export function compile(route: Route, prefix: string[] = []): CompiledRoute[] {
  return match(route)
    .with({ kind: 'terminal' }, (r) => [{
      method: r.method,
      pattern: buildPattern(prefix),
      handler: r.handler,
    }])
    .with({ kind: 'path' }, (r) => compile(r.child, [...prefix, r.segment]))
    .with({ kind: 'concat' }, (r) => r.routes.flatMap((child) => compile(child, prefix)))
    .with({ kind: 'middleware' }, (r) => {
      // Compile the subtree, then wrap each compiled handler with the
      // middleware.  Nested middlewares stack: an outer-then-inner wrap
      // builds a function that runs outer first, calls next() to run
      // inner, and inner's next() runs the original handler.
      return compile(r.child, prefix).map((c) => ({
        ...c,
        handler: wrapHandler(r.middleware, c.handler),
      }));
    })
    .exhaustive();
}

function wrapHandler(
  middleware: Middleware,
  handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse,
): (req: HttpRequest) => Promise<HttpResponse> {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const next = async (): Promise<HttpResponse> => Promise.resolve(handler(req));
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
  const v = req.query[name];
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

/** Extract a path parameter (guaranteed present by the pattern). */
export function pathParam(req: HttpRequest, name: string): string {
  const v = req.params[name];
  if (v === undefined) throw new HttpError(500, `Missing path parameter "${name}"`);
  return v;
}
