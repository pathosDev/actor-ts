/**
 * All WebSocket-client option-relevant types live here:
 *
 *   - {@link WebSocketClientOptionsType} — the plain settings-object shape
 *     (what you may also pass as a bare `{ … }` object).
 *   - {@link WebSocketClientOptionsBuilder} — the fluent builder
 *     (`WebSocketClientOptions.create()…`).
 *   - {@link WebSocketClientOptions} — the accepted-input **union**
 *     (`WebSocketClientOptionsBuilder | WebSocketClientOptionsType`), plus a
 *     value alias to the builder so `WebSocketClientOptions.create()` /
 *     `new WebSocketClientOptions()` keep working.
 *
 * A `WebSocketClientActor` subclass takes a `WebSocketClientOptions` (or builds
 * one inline) and passes it to `super(...)`:
 *
 *     class FeedClient extends WebSocketClientActor<ClientMsg, ServerMsg> {
 *       constructor() {
 *         super(WebSocketClientOptions.create<ClientMsg, ServerMsg>()
 *           .withUrl('ws://localhost:8080/ws'));
 *       }
 *     }
 *
 * The reconnect / circuit-breaker / outbound-buffer knobs come from
 * {@link BrokerOptionsBuilder} (the WS client is a {@link BrokerActor}); this
 * class adds only the WebSocket-specific fields.  The builder records only the
 * fields you set (as own enumerable props), so it reads/spreads exactly like a
 * plain object; the same three-layer merge applies (constructor > HOCON under
 * `actor-ts.io.broker.websocket` > built-in defaults), so any field left unset
 * falls through to HOCON.
 */
import { BrokerOptionsBuilder } from '../../io/broker/BrokerOptions.js';
import type { BrokerCommonOptionsType } from '../../io/broker/BrokerSettings.js';
import type { WsCodec } from './WsCodec.js';

/** Plain settings-object shape accepted by a {@link WebSocketClientActor}. */
export interface WebSocketClientOptionsType<TOut = unknown, TIn = unknown> extends BrokerCommonOptionsType {
  /** WebSocket URL (`ws://…` or `wss://…`).  Required (ctor or HOCON). */
  readonly url?: string;
  readonly protocols?: string | ReadonlyArray<string>;
  /** Custom request headers — Node/`ws` only; native/browsers ignore them. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Wire codec.  Default: `jsonCodec<TOut, TIn>()`. */
  readonly codec?: WsCodec<TOut, TIn>;
  /** Inbound frame size cap; oversize frames are dropped with a warning.  Default 1 MiB. */
  readonly maxFrameBytes?: number;
  /** What to do with an inbound frame the codec can't decode.  Default 'drop'. */
  readonly onInvalidMessage?: 'drop' | 'hook' | 'disconnect';
  /** Send a ping every `pingIntervalMs` to keep the connection alive.  Default: disabled. */
  readonly pingIntervalMs?: number;
}

/** Fluent builder for {@link WebSocketClientOptionsType}. */
export class WebSocketClientOptionsBuilder<TOut = unknown, TIn = unknown>
  extends BrokerOptionsBuilder<WebSocketClientOptionsType<TOut, TIn>> {
  /** Start a fresh builder.  Equivalent to `new WebSocketClientOptionsBuilder()`. */
  static create<TOut = unknown, TIn = unknown>(): WebSocketClientOptionsBuilder<TOut, TIn> {
    return new WebSocketClientOptionsBuilder<TOut, TIn>();
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

/**
 * Accepted input for any WebSocket-client-configurable constructor: the fluent
 * {@link WebSocketClientOptionsBuilder} OR a plain
 * {@link WebSocketClientOptionsType} object.
 */
export type WebSocketClientOptions<TOut = unknown, TIn = unknown> =
  | WebSocketClientOptionsBuilder<TOut, TIn>
  | Partial<WebSocketClientOptionsType<TOut, TIn>>;
/** Value alias so `WebSocketClientOptions.create()` / `new WebSocketClientOptions()` resolve to the builder. */
export const WebSocketClientOptions = WebSocketClientOptionsBuilder;
