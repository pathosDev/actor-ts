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
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { jsonCodec, type WsCodec } from './WsCodec.js';
import { wireConnection } from './ConnectionWiring.js';
import type { WsServerRef } from './WsMessages.js';
import {
  resolveWsPolicy,
  type BackpressurePolicy,
  type InvalidMessagePolicy,
  type OversizeFramePolicy,
  type ResolvedWsPolicy,
  type WebSocketPolicyOptions,
} from './WsPolicy.js';

/** The settings a `websocket()` route may carry — codec + per-connection policy. */
export interface WebSocketRouteSettings<TOut, TIn> extends WebSocketPolicyOptions {
  /** Wire codec.  Default: `jsonCodec<TOut, TIn>()`. */
  readonly codec?: WsCodec<TOut, TIn>;
}

/**
 * Fluent builder for a `websocket()` route's options:
 *
 *     websocket('/ws', ingress, WebSocketRouteOptions.create().withCodec(rawCodec()))
 *
 * `build()` yields a `Partial<WebSocketRouteSettings>` that feeds the same
 * per-route resolution (route options > HOCON `actor-ts.http.websocket` >
 * defaults); unset fields fall through to HOCON.
 */
export class WebSocketRouteOptions<TOut = unknown, TIn = unknown>
  extends OptionsBuilder<WebSocketRouteSettings<TOut, TIn>> {
  /** Start a fresh builder.  Equivalent to `new WebSocketRouteOptions()`. */
  static create<TOut = unknown, TIn = unknown>(): WebSocketRouteOptions<TOut, TIn> {
    return new WebSocketRouteOptions<TOut, TIn>();
  }

  /** Wire codec.  Default: `jsonCodec<TOut, TIn>()`. */
  withCodec(codec: WsCodec<TOut, TIn>): this {
    return this.set('codec', codec);
  }

  /** Inbound frame size cap in bytes.  Default 1 MiB. */
  withMaxFrameBytes(bytes: number): this {
    return this.set('maxFrameBytes', bytes);
  }

  /** What to do with an inbound frame exceeding `maxFrameBytes`.  Default 'close'. */
  withOnOversizeFrame(policy: OversizeFramePolicy): this {
    return this.set('onOversizeFrame', policy);
  }

  /** What to do with an inbound frame the codec can't decode.  Default 'close'. */
  withOnInvalidMessage(policy: InvalidMessagePolicy): this {
    return this.set('onInvalidMessage', policy);
  }

  /** Outbound buffer cap in bytes before backpressure kicks in.  Default 4 MiB. */
  withMaxBufferedBytes(bytes: number): this {
    return this.set('maxBufferedBytes', bytes);
  }

  /** What to do when a slow consumer overflows the buffer.  Default 'drop'. */
  withOnBackpressure(policy: BackpressurePolicy): this {
    return this.set('onBackpressure', policy);
  }
}

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
  const options: Partial<WebSocketRouteSettings<TOut, TIn>> = builder?.build() ?? {};

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
