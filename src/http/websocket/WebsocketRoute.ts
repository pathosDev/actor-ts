/**
 * The `websocket()` routing directive — the one-liner that turns a
 * {@link WebsocketServerActor} into a WebSocket endpoint on the HTTP
 * server, composable with `path()` / `concat()` / `withMiddleware()`
 * exactly like `get()` / `post()`.
 *
 *     const server = system.spawn(PingServer, 'ping');
 *     await http.newServerAt('127.0.0.1', 8080).bind(websocket('/ws', server));
 *
 * Middleware wrapping the route runs once, against the HTTP upgrade
 * request, so `BearerTokenAuth` / `IpAllowlist` gate the handshake.
 *
 * The bind address here is loopback deliberately, and it is the snippet a
 * developer reads before any example: a wildcard bind in the first thing
 * anyone copies is how an unauthenticated relay ends up reachable from every
 * interface on a laptop or an unpolicied container (#756).  Widen it once the
 * service is meant to be reached from elsewhere, not before.
 */
import { path, type Route, type WebsocketConnectHandler, type WebsocketPolicyResolver } from '../Route.js';
import { Status, type HttpRequest, type HttpResponse } from '../Types.js';
import { jsonCodec, type WebsocketCodec } from './WebsocketCodec.js';
import { wireConnection } from './ConnectionWiring.js';
import type { WebsocketServerRef } from './WebsocketMessages.js';
import {
  resolveWebsocketPolicy,
  type ResolvedWebsocketPolicy,
} from './WebsocketPolicy.js';
import { WebsocketRouteOptionsValidator } from './WebsocketRouteOptions.js';
import type { WebsocketRouteOptions, WebsocketRouteOptionsType } from './WebsocketRouteOptions.js';

/** `websocket(target)` — mount at the enclosing path. */
export function websocket<TOut, TIn, TSelf = never>(
  target: WebsocketServerRef<TOut, TIn, TSelf>,
  options?: WebsocketRouteOptions<TOut, TIn>,
): Route;
/** `websocket('/ws', target)` — sugar for `path('/ws', websocket(target))`. */
export function websocket<TOut, TIn, TSelf = never>(
  routePath: string,
  target: WebsocketServerRef<TOut, TIn, TSelf>,
  options?: WebsocketRouteOptions<TOut, TIn>,
): Route;
export function websocket<TOut, TIn, TSelf = never>(
  a: string | WebsocketServerRef<TOut, TIn, TSelf>,
  b?: WebsocketServerRef<TOut, TIn, TSelf> | WebsocketRouteOptions<TOut, TIn>,
  c?: WebsocketRouteOptions<TOut, TIn>,
): Route {
  let segment: string | null;
  let target: WebsocketServerRef<TOut, TIn, TSelf>;
  let builder: WebsocketRouteOptions<TOut, TIn> | undefined;
  if (typeof a === 'string') {
    segment = a;
    target = b as WebsocketServerRef<TOut, TIn, TSelf>;
    builder = c;
  } else {
    segment = null;
    target = a;
    builder = b as WebsocketRouteOptions<TOut, TIn> | undefined;
  }
  const options: WebsocketRouteOptionsType<TOut, TIn> = ((builder ?? {}) as WebsocketRouteOptionsType<TOut, TIn>);
  new WebsocketRouteOptionsValidator<TOut, TIn>().validate(options);

  const codec: WebsocketCodec<TOut, TIn> = options.codec ?? jsonCodec<TOut, TIn>();
  // Policy needs the ActorSystem's config, so it cannot be resolved while the
  // route tree is being built; resolve once (route options > HOCON >
  // defaults) and memoise.  Two callers share that single answer: the backend
  // reads `maxFrameBytes` off it at bind time to size the transport (#373),
  // and every connection wires itself with it.
  let policy: ResolvedWebsocketPolicy | null = null;
  const resolvePolicy: WebsocketPolicyResolver = (system) => {
    if (policy === null) policy = resolveWebsocketPolicy(system, options);
    return policy;
  };

  const connect: WebsocketConnectHandler = (system, request, socket) => {
    wireConnection<TOut, TIn, TSelf>(system, target, request, socket, codec, resolvePolicy(system));
  };

  // CSWSH defence — the origin rules fold into the route's innermost
  // upgrade `authorize`, which every backend runs before the handshake.
  // It has to be here rather than in middleware: an upgrade is a GET, and
  // the CSRF middleware treats GET as a safe method and waves it through.
  //
  // `requireSameOrigin` defaults to **true** (#756).  It shipped defaulting to
  // `false`, which made every user route CSWSH-exposed until its author
  // remembered an option they had to know existed — while DevTools, the one
  // route in the tree that thought about it, installed the same guard
  // unconditionally.  A security control that is only on for the people who
  // already knew to ask for it is not a control, and pre-1.0 permits the hard
  // cut; `withRequireSameOrigin(false)` is the explicit opt-out for a route
  // that genuinely serves a different origin.
  const originGuard = makeOriginGuard(options.allowedOrigins, options.requireSameOrigin ?? true);

  const node: Route = originGuard
    ? { kind: 'websocket', connect, resolvePolicy, authorize: originGuard }
    : { kind: 'websocket', connect, resolvePolicy };
  return segment === null ? node : path(segment, node);
}

/**
 * Host of an `Origin` header value, lowercased, or `null` if it does not
 * parse.  Local to this module rather than shared with `Csrf.ts`: that one
 * compares two origins, this one compares an origin against a `Host` header,
 * which carries no scheme — so there is nothing to widen or narrow here.
 */
function originHost(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Build the Origin guard for the upgrade handshake, or `undefined` when
 * neither rule is configured.  See
 * {@link WebsocketRouteOptionsType.allowedOrigins},
 * {@link WebsocketRouteOptionsType.requireSameOrigin} and security audit WS-2.
 */
function makeOriginGuard(
  allowedOrigins: ReadonlyArray<string> | undefined,
  requireSameOrigin: boolean,
): ((request: HttpRequest) => HttpResponse | null) | undefined {
  const allow = new Set((allowedOrigins ?? []).map((o) => o.toLowerCase()));
  if (allow.size === 0 && !requireSameOrigin) return undefined;

  return (request: HttpRequest): HttpResponse | null => {
    const origin = request.headers['origin'];
    // Missing Origin → non-browser client (native WS / server-to-server);
    // CSWSH rides a victim browser's ambient credentials and a browser
    // always sends one, so it cannot be that attack.  Allow.
    if (origin === undefined) return null;
    if (allow.has(origin.toLowerCase())) return null;
    if (requireSameOrigin) {
      const host = request.headers['host'];
      const from = originHost(origin);
      if (host !== undefined && from !== null && from === host.toLowerCase()) return null;
    }
    return { status: Status.Forbidden, body: { error: `websocket origin not allowed: ${origin}` } };
  };
}
