/**
 * The `websocket()` routing directive — the one-liner that turns a
 * {@link WebSocketServerActor} into a WebSocket endpoint on the HTTP
 * server, composable with `path()` / `concat()` / `withMiddleware()`
 * exactly like `get()` / `post()`.
 *
 *     const server = system.spawn(Props.create(() => new PingServer()), 'ping');
 *     await http.newServerAt('0.0.0.0', 8080).bind(websocket('/ws', server));
 *
 * Middleware wrapping the route runs once, against the HTTP upgrade
 * request, so `BearerTokenAuth` / `IpAllowlist` gate the handshake.
 */
import { path, type Route, type WebSocketConnectHandler } from '../Route.js';
import { jsonCodec, type WsCodec } from './WsCodec.js';
import { wireConnection } from './ConnectionWiring.js';
import type { WsServerRef } from './WsMessages.js';
import {
  resolveWsPolicy,
  type ResolvedWsPolicy,
} from './WsPolicy.js';
import type { WebSocketRouteOptions, WebSocketRouteOptionsType } from './WebSocketRouteOptions.js';

/** `websocket(target)` — mount at the enclosing path. */
export function websocket<TOut, TIn, TSelf = never>(
  target: WsServerRef<TOut, TIn, TSelf>,
  options?: WebSocketRouteOptions<TOut, TIn>,
): Route;
/** `websocket('/ws', target)` — sugar for `path('/ws', websocket(target))`. */
export function websocket<TOut, TIn, TSelf = never>(
  routePath: string,
  target: WsServerRef<TOut, TIn, TSelf>,
  options?: WebSocketRouteOptions<TOut, TIn>,
): Route;
export function websocket<TOut, TIn, TSelf = never>(
  a: string | WsServerRef<TOut, TIn, TSelf>,
  b?: WsServerRef<TOut, TIn, TSelf> | WebSocketRouteOptions<TOut, TIn>,
  c?: WebSocketRouteOptions<TOut, TIn>,
): Route {
  let segment: string | null;
  let target: WsServerRef<TOut, TIn, TSelf>;
  let builder: WebSocketRouteOptions<TOut, TIn> | undefined;
  if (typeof a === 'string') {
    segment = a;
    target = b as WsServerRef<TOut, TIn, TSelf>;
    builder = c;
  } else {
    segment = null;
    target = a;
    builder = b as WebSocketRouteOptions<TOut, TIn> | undefined;
  }
  const options: WebSocketRouteOptionsType<TOut, TIn> = ((builder ?? {}) as WebSocketRouteOptionsType<TOut, TIn>);

  const codec: WsCodec<TOut, TIn> = options.codec ?? jsonCodec<TOut, TIn>();
  // Policy needs the ActorSystem's config, only available at connect
  // time; resolve once (route options > HOCON > defaults) and memoise.
  let policy: ResolvedWsPolicy | null = null;

  const connect: WebSocketConnectHandler = (system, req, socket) => {
    if (policy === null) policy = resolveWsPolicy(system, options);
    wireConnection<TOut, TIn, TSelf>(system, target, req, socket, codec, policy);
  };

  const node: Route = { kind: 'websocket', connect };
  return segment === null ? node : path(segment, node);
}
