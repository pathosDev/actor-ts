/**
 * The `websocket()` routing directive — the one-liner that turns a
 * {@link WebsocketServerActor} into a WebSocket endpoint on the HTTP
 * server, composable with `path()` / `concat()` / `withMiddleware()`
 * exactly like `get()` / `post()`.
 *
 *     const server = system.spawn(Props.create(() => new PingServer()), 'ping');
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

  // CSWSH defence — an Origin allowlist folds into the route's innermost
  // upgrade `authorize`, which every backend runs before the handshake.
  const originGuard = makeOriginGuard(options.allowedOrigins);

  const node: Route = originGuard
    ? { kind: 'websocket', connect, authorize: originGuard }
    : { kind: 'websocket', connect };
  return segment === null ? node : path(segment, node);
}

/**
 * Build an Origin-allowlist guard for the upgrade handshake, or `undefined`
 * when no origins are configured.  See
 * {@link WebsocketRouteOptionsType.allowedOrigins} and security audit WS-2.
 */
function makeOriginGuard(
  allowedOrigins: ReadonlyArray<string> | undefined,
): ((request: HttpRequest) => HttpResponse | null) | undefined {
  if (!allowedOrigins || allowedOrigins.length === 0) return undefined;
  const allow = new Set(allowedOrigins.map((o) => o.toLowerCase()));
  return (request: HttpRequest): HttpResponse | null => {
    const origin = request.headers['origin'];
    // Missing Origin → non-browser client (native WS / server-to-server);
    // CSWSH can't apply, so allow.  Present-but-unlisted → reject.
    if (origin === undefined) return null;
    if (allow.has(origin.toLowerCase())) return null;
    return { status: Status.Forbidden, body: { error: `websocket origin not allowed: ${origin}` } };
  };
}
