/**
 * Fluent builder for {@link WebSocketClientSettings}.  A `WebSocketClientActor`
 * subclass takes a `WebSocketClientOptions` (or builds one inline) and passes
 * it to `super(...)`:
 *
 *     class FeedClient extends WebSocketClientActor<ClientMsg, ServerMsg> {
 *       constructor() {
 *         super(WebSocketClientOptions.create<ClientMsg, ServerMsg>()
 *           .withUrl('ws://localhost:8080/ws'));
 *       }
 *     }
 *
 * The reconnect / circuit-breaker / outbound-buffer knobs come from
 * {@link BrokerOptions} (the WS client is a {@link BrokerActor}); this class
 * adds only the WebSocket-specific fields.  `build()` snapshots a
 * `Partial<WebSocketClientSettings>` that feeds the actor's usual three-layer
 * resolution (constructor > HOCON under `actor-ts.io.broker.websocket` >
 * built-in defaults), so any field left unset falls through to HOCON.
 */
import { BrokerOptions } from '../../io/broker/BrokerOptions.js';
import type { WsCodec } from './WsCodec.js';
import type { WebSocketClientSettings } from './WebSocketClientActor.js';

export class WebSocketClientOptions<TOut = unknown, TIn = unknown>
  extends BrokerOptions<WebSocketClientSettings<TOut, TIn>> {
  /** Start a fresh builder.  Equivalent to `new WebSocketClientOptions()`. */
  static create<TOut = unknown, TIn = unknown>(): WebSocketClientOptions<TOut, TIn> {
    return new WebSocketClientOptions<TOut, TIn>();
  }

  /** WebSocket URL (`ws://…` or `wss://…`).  Required (here or via HOCON). */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Sub-protocol(s) offered in the handshake. */
  withProtocols(protocols: string | ReadonlyArray<string>): this {
    return this.set('protocols', protocols);
  }

  /** Custom request headers — Node/`ws` only; native/browsers ignore them. */
  withHeaders(headers: Readonly<Record<string, string>>): this {
    return this.set('headers', headers);
  }

  /** Wire codec.  Default: `jsonCodec<TOut, TIn>()`. */
  withCodec(codec: WsCodec<TOut, TIn>): this {
    return this.set('codec', codec);
  }

  /** Inbound frame size cap; oversize frames are dropped with a warning.  Default 1 MiB. */
  withMaxFrameBytes(bytes: number): this {
    return this.set('maxFrameBytes', bytes);
  }

  /** What to do with an inbound frame the codec can't decode.  Default 'drop'. */
  withOnInvalidMessage(policy: 'drop' | 'hook' | 'disconnect'): this {
    return this.set('onInvalidMessage', policy);
  }

  /** Send a ping every `ms` to keep the connection alive.  Default: disabled. */
  withPingIntervalMs(ms: number): this {
    return this.set('pingIntervalMs', ms);
  }
}
