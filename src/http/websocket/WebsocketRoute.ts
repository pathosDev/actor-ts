/**
 * The `websocket()` routing directive — the one-liner that turns a
 * {@link WebsocketServerActor} into a WebSocket endpoint on the HTTP
 * server, composable with `path()` / `concat()` / `withMiddleware()`
 * exactly like `get()` / `post()`.
 *
 *     const server = system.spawn(PingServer, 'ping');
 *     await http.newServerAt('0.0.0.0', 8080).bind(websocket('/ws', server));
 *
 * Middleware wrapping the route runs once, against the HTTP upgrade
 * request, so `BearerTokenAuth` / `IpAllowlist` gate the handshake.
 */
import { path, type Route, type WebsocketConnectHandler } from '../Route.js';
import { Status, type HttpRequest, type HttpResponse } from '../types.js';
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
  // Policy needs the ActorSystem's config, only available at connect
  // time; resolve once (route options > HOCON > defaults) and memoise.
  let policy: ResolvedWebsocketPolicy | null = null;

  const connect: WebsocketConnectHandler = (system, request, socket) => {
    if (policy === null) policy = resolveWebsocketPolicy(system, options);
    wireConnection<TOut, TIn, TSelf>(system, target, request, socket, codec, policy);
  };

  // CSWSH defence — the origin rules fold into the route's innermost
  // upgrade `authorize`, which every backend runs before the handshake.
  // It has to be here rather than in middleware: an upgrade is a GET, and
  // the CSRF middleware treats GET as a safe method and waves it through.
  const originGuard = makeOriginGuard(options.allowedOrigins, options.requireSameOrigin ?? false);

  const node: Route = originGuard
    ? { kind: 'websocket', connect, authorize: originGuard }
    : { kind: 'websocket', connect };
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
