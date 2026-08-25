import { match } from 'ts-pattern';
import type { ActorSystem } from '../ActorSystem.js';
import { HttpError, type HttpMethod, type HttpRequest, type HttpResponse, Status } from './Types.js';
import type { WebsocketSocketAdapter } from './websocket/SocketAdapter.js';
import type { ResolvedWebsocketPolicy } from './websocket/WebsocketPolicy.js';
import { expandCors, type CorsRouteOptions } from './middleware/Cors.js';
import { stripSurrounding } from '../util/StripCharacters.js';

/**
 * A compiled HTTP route — the Route-DSL reduces to a list of these
 * (plus {@link CompiledWebsocketRoute}s), which the HTTP backend
 * registers in its native routing table.
 */
export type CompiledRoute = {
  readonly kind: 'http';
  readonly method: HttpMethod;
  readonly pattern: string;
  readonly handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse;
};

/**
 * Framework-owned entry point for one accepted WebSocket connection.
 * The backend never sees actors — it only hands us the upgrade request
 * and a normalised socket; the closure (built by the `websocket()`
 * directive) owns the codec, target ref and per-route policy.
 */
export type WebsocketConnectHandler = (
  system: ActorSystem,
  request: HttpRequest,
  socket: WebsocketSocketAdapter,
) => void;

/**
 * Resolve a WebSocket route's policy against a system's configuration —
 * route options > HOCON > built-in defaults.
 *
 * Carried on the route rather than hidden inside `connect` because the
 * *transport* needs the answer at bind time, one process-wide moment before
 * any connection exists, while `connect` only ever runs per connection.
 * `HttpExtension.bind` is where both the routes and the `ActorSystem` are in
 * scope, so that is the one place able to call this (#373).  Resolution is
 * memoised per route, so calling it at bind time and again on the first
 * connection yields the same object.
 */
export type WebsocketPolicyResolver = (system: ActorSystem) => ResolvedWebsocketPolicy;

/**
 * A compiled WebSocket route.  Occupies the `GET` verb at its pattern
 * (that's how the HTTP upgrade arrives).  `authorize` folds any
 * enclosing `withMiddleware(...)` — it runs once, against the upgrade
 * request, and returns `null` to accept or an {@link HttpResponse} to
 * reject the upgrade with a plain HTTP response.
 */
export type CompiledWebsocketRoute = {
  readonly kind: 'websocket';
  readonly method: 'GET';
  readonly pattern: string;
  readonly connect: WebsocketConnectHandler;
  readonly resolvePolicy: WebsocketPolicyResolver;
  readonly authorize: (request: HttpRequest) => Promise<HttpResponse | null>;
};

/**
 * A compiled fallback — answers any request that matched no other route.
 * Wired to the backend's not-found hook at bind time (exactly one per
 * server), so unlike {@link CompiledRoute} it carries no method or pattern.
 */
export type CompiledFallback = {
  readonly kind: 'fallback';
  readonly handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse;
};

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
 *   - `IpAllowlist({ allow })` — checks `remoteAddress` (or, with
 *     `trustedProxies` set, the client address resolved from the
 *     forwarded chain) against a CIDR list, short-circuits with 403
 *     if not allowed.
 *
 * Throwing `HttpError(status, message)` is the idiomatic short-circuit:
 * the global error handler catches it and emits the right response.
 */
export type Middleware = (
  request: HttpRequest,
  next: (request?: HttpRequest) => Promise<HttpResponse>,
) => Promise<HttpResponse> | HttpResponse;

/**
 * Node type emitted by DSL builders like `path(...)`, `get(...)`.  Internal
 * representation is a tree that knows how to flatten into CompiledRoutes.
 */
export type Route =
  | { readonly kind: 'terminal'; readonly method: HttpMethod; readonly handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse }
  | { readonly kind: 'path'; readonly segment: string; readonly child: Route }
  | { readonly kind: 'concat'; readonly routes: ReadonlyArray<Route> }
  | { readonly kind: 'middleware'; readonly middleware: Middleware; readonly child: Route }
  | { readonly kind: 'websocket'; readonly connect: WebsocketConnectHandler; readonly resolvePolicy: WebsocketPolicyResolver; readonly authorize?: (request: HttpRequest) => HttpResponse | null }
  | { readonly kind: 'fallback'; readonly handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse }
  | { readonly kind: 'cors'; readonly settings: CorsRouteOptions; readonly child: Route };

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
  request: HttpRequest,
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
  const middleware: Middleware = async (request, next) => {
    try {
      return await next();
    } catch (err) {
      const recovered = await handler(err, request);
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
 *       fallback((request) => completeJson(Status.NotFound, { error: 'no route', path: request.path })),
 *     )
 */
export function fallback(handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route {
  return { kind: 'fallback', handler };
}

function normalizeSegment(s: string): string {
  return stripSurrounding(s, '/');
}

/* -------------------------- Method combinators ---------------------------- */

function methodRoute(method: HttpMethod, handler: Route['kind'] extends 'terminal' ? never : (request: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route {
  return { kind: 'terminal', method, handler };
}

export const get     = (h: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route => methodRoute('GET', h);
export const post    = (h: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route => methodRoute('POST', h);
export const put     = (h: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route => methodRoute('PUT', h);
export const del     = (h: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route => methodRoute('DELETE', h);
export const patch   = (h: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route => methodRoute('PATCH', h);
export const head    = (h: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route => methodRoute('HEAD', h);
export const options = (h: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse): Route => methodRoute('OPTIONS', h);

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

/**
 * Characters that must never reach a `location` header.  Two distinct
 * reasons, both measured on Bun and Node:
 *
 *   - CR / LF / NUL are already refused by both runtimes at header-write
 *     time, so checking here only trades an opaque 500 (`TypeError` /
 *     `ERR_INVALID_CHAR`) for a 400 that names the reason.
 *   - TAB is **accepted** by both — and browsers strip TAB, CR and LF from
 *     a URL before parsing it.  So a target that hides a TAB inside
 *     `javascript:` survives the wire intact and arrives at the browser as
 *     a working scheme.  That is why this runs before the scheme check,
 *     which searches the raw string and would never see it.
 *
 * VT and DEL land in between (Node refuses them, `fetch` Headers accept
 * them), so the class spans all of C0 plus DEL instead of enumerating a
 * split that is a runtime detail.
 */
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

/** A scheme per RFC 3986 §3.1 — its presence means the target is absolute. */
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Guard shared by both redirect helpers — an origin-agnostic wire check. */
function assertHeaderSafeTarget(url: string): void {
  if (CONTROL_CHARACTERS.test(url)) {
    throw new HttpError(Status.BadRequest, 'redirect target contains control characters');
  }
}

/**
 * Reject a redirect target that would take the browser off this origin.
 *
 * Classification mirrors what a browser does *before* parsing: leading
 * whitespace is ignored and backslashes read as slashes, so `/\evil.example`
 * and `\\evil.example` are protocol-relative exactly like `//evil.example`.
 * The normalised form is only used to decide — the caller's original string
 * is what gets emitted.
 *
 * The messages deliberately do not echo the offending target: reflecting
 * attacker-supplied input back into a response is the family of bug this
 * check exists to prevent.
 */
function assertSameOriginTarget(url: string): void {
  const candidate = url.trimStart().replaceAll('\\', '/');
  if (candidate.startsWith('//')) {
    throw new HttpError(
      Status.BadRequest,
      'redirect target is protocol-relative and leaves this origin — use redirectExternal() if that is intended',
    );
  }
  if (SCHEME_PREFIX.test(candidate)) {
    throw new HttpError(
      Status.BadRequest,
      'redirect target is an absolute URL and leaves this origin — use redirectExternal() if that is intended',
    );
  }
}

/**
 * Redirect to a **same-origin** target — helper around `Status.Found`.
 *
 * Only relative references pass (`/dashboard`, `../up`, `?q=1`, `#top`);
 * an absolute URL, a protocol-relative `//host` target, or a control
 * character throws `HttpError(400)`.  That default is the point: the
 * target is very often a request parameter, and the `?next=` pattern with
 * no validation is the textbook open redirect — a phishing link bounces a
 * freshly authenticated victim to a look-alike host (#125).  A framework
 * cannot force handlers to validate, so the helper they already reach for
 * validates instead.
 *
 * Use {@link redirectExternal} when leaving the origin is the intent.
 */
export function redirect(url: string, status: number = Status.Found): HttpResponse {
  assertHeaderSafeTarget(url);
  assertSameOriginTarget(url);
  return { status, headers: { location: url }, body: null };
}

/**
 * Redirect to a target that may leave this origin — the audited opt-in to
 * {@link redirect}'s same-origin rule.
 *
 * Being a separate function is the whole design: `grep redirectExternal`
 * enumerates every deliberate off-origin hop in a codebase, which a
 * boolean tucked into a third argument never could.  Pass a constant or a
 * value you allowlisted yourself — **never** a raw request parameter,
 * which is precisely the open redirect {@link redirect} refuses.
 *
 * Control characters are still rejected: those are a header-injection
 * vector, not a question of origin.
 */
export function redirectExternal(url: string, status: number = Status.Found): HttpResponse {
  assertHeaderSafeTarget(url);
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
 * Marks a response as *the* "proceed with the upgrade" sentinel.  A symbol
 * key is what makes the mark survive the object spread every decorating
 * middleware performs (`{ ...response, headers: merged }` copies own
 * enumerable symbol properties), so acceptance can be read structurally
 * rather than by reference identity.
 *
 * Module-private and unforgeable on purpose: nothing outside this file can
 * name the symbol, so no handler or middleware can mint a response that
 * claims to be an accepted upgrade (#757).
 */
const WEBSOCKET_ACCEPT = Symbol('actor-ts.websocket-accept');

/** A response carrying the accept mark — the shape {@link isWebsocketAccept} reads. */
type WebsocketAcceptResponse = HttpResponse & { readonly [WEBSOCKET_ACCEPT]: true };

/**
 * Sentinel returned by a WS route's inner `authorize` to mean "proceed with
 * the upgrade".  Middleware that calls `next()` and returns the result —
 * untouched, or decorated with headers via the usual spread — accepts;
 * anything else rejects the upgrade with that response.
 *
 * Frozen so the mark cannot be deleted in place; the spread that copies it
 * onto a decorated response produces an ordinary mutable object, which is
 * fine — forging one still requires the symbol.
 */
const WEBSOCKET_ACCEPT_SENTINEL: WebsocketAcceptResponse =
  Object.freeze({ status: 101, body: null, [WEBSOCKET_ACCEPT]: true as const });

/**
 * Read acceptance off a middleware's return value.
 *
 * Both halves are required.  The mark alone would accept a response that a
 * middleware spread the sentinel into and then *overrode* the status on —
 * a deliberate answer, not a pass-through — and `status === 101` alone
 * would accept any response a handler happened to build with that status.
 * Requiring both means only a response descended from this file's sentinel,
 * with the protocol-switch status intact, counts as "proceed"; everything
 * else stays a rejection, which keeps the fail-closed direction the
 * identity check had.
 */
function isWebsocketAccept(response: HttpResponse): boolean {
  return (response as Partial<WebsocketAcceptResponse>)[WEBSOCKET_ACCEPT] === true
    && response.status === WEBSOCKET_ACCEPT_SENTINEL.status;
}

/** Flatten a Route tree into the list of concrete endpoint registrations. */
export function compile(route: Route, prefix: string[] = []): CompiledEndpoint[] {
  return match(route)
    .with({ kind: 'terminal' }, (r): CompiledEndpoint[] => [{
      kind: 'http',
      method: r.method,
      pattern: buildPattern(prefix),
      handler: r.handler,
    }])
    .with({ kind: 'websocket' }, (r): CompiledEndpoint[] => {
      // Innermost gate: a route-level upgrade check (the CSWSH Origin
      // allowlist from `websocket({ allowedOrigins })`) if the node
      // carries one, else accept unconditionally.  Enclosing
      // withMiddleware() nodes fold their checks around this below.
      const gate = r.authorize;
      return [{
        kind: 'websocket',
        method: 'GET',
        pattern: buildPattern(prefix),
        connect: r.connect,
        resolvePolicy: r.resolvePolicy,
        authorize: gate
          ? async (request): Promise<HttpResponse | null> => gate(request)
          : async (): Promise<HttpResponse | null> => null,
      }];
    })
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
        const authorize = async (request: HttpRequest): Promise<HttpResponse | null> => {
          try {
            const response = await r.middleware(request, async (override?: HttpRequest) => (await inner(override ?? request)) ?? WEBSOCKET_ACCEPT_SENTINEL);
            // Structural: the middleware returned something descended from
            // the sentinel → accept.  That covers both passing it through
            // untouched and decorating it (`securityHeaders()`, `hsts()`,
            // `requestId()`, … all spread, which carries the mark), which a
            // reference-identity check refused (#757).  Any other response
            // — a short-circuit, or a replacement built from scratch — is
            // the middleware answering the request itself → reject the
            // upgrade with it.
            //
            // Headers a decorator added to the sentinel are dropped on the
            // accept path: `null` means "proceed" and the backend writes the
            // handshake response itself, so there is nowhere to put them.
            // Nothing is lost that reached the wire before — the decorated
            // sentinel used to be a *rejection*.
            return isWebsocketAccept(response) ? null : response;
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
  handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse,
): (request: HttpRequest) => Promise<HttpResponse> {
  return async (request: HttpRequest): Promise<HttpResponse> => {
    // `next(override?)` lets a middleware replace the request the handler
    // (and any inner middleware) sees — the override threads through the
    // stacked wraps because each wrap's `handler` is the next-inner one.
    const next = async (override?: HttpRequest): Promise<HttpResponse> =>
      Promise.resolve(handler(override ?? request));
    return Promise.resolve(middleware(request, next));
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
export function queryParam(request: HttpRequest, name: string): string | undefined {
  const value = request.query[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Extract a path parameter (guaranteed present by the pattern). */
export function pathParam(request: HttpRequest, name: string): string {
  const value = request.params[name];
  if (value === undefined) throw new HttpError(500, `Missing path parameter "${name}"`);
  return value;
}
