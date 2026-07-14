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
import { jsonCodec, type WebsocketCodec } from './WebsocketCodec.js';
import { wireConnection } from './ConnectionWiring.js';
import type { WebsocketServerRef } from './WebsocketMessages.js';
import {
  resolveWebsocketPolicy,
  type ResolvedWebsocketPolicy,
} from './WebsocketPolicy.js';
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

  const codec: WebsocketCodec<TOut, TIn> = options.codec ?? jsonCodec<TOut, TIn>();
  // Policy needs the ActorSystem's config, only available at connect
  // time; resolve once (route options > HOCON > defaults) and memoise.
  let policy: ResolvedWebsocketPolicy | null = null;

  const connect: WebsocketConnectHandler = (system, req, socket) => {
    if (policy === null) policy = resolveWebsocketPolicy(system, options);
    wireConnection<TOut, TIn, TSelf>(system, target, req, socket, codec, policy);
  };

  const node: Route = { kind: 'websocket', connect };
  return segment === null ? node : path(segment, node);
}
