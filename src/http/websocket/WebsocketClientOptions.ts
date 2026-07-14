/**
 * All WebSocket-client option-relevant types live here:
 *
 *   - {@link WebsocketClientOptionsType} — the plain options-object shape
 *     (what you may also pass as a bare `{ … }` object).
 *   - {@link WebsocketClientOptionsBuilder} — the fluent builder
 *     (`WebsocketClientOptions.create()…`).
 *   - {@link WebsocketClientOptions} — the accepted-input **union**
 *     (`WebsocketClientOptionsBuilder | WebsocketClientOptionsType`), plus a
 *     value alias to the builder so `WebsocketClientOptions.create()` /
 *     `new WebsocketClientOptions()` keep working.
 *
 * A `WebsocketClientActor` subclass takes a `WebsocketClientOptions` (or builds
 * one inline) and passes it to `super(...)`:
 *
 *     class FeedClient extends WebsocketClientActor<ClientMessage, ServerMessage> {
 *       constructor() {
 *         super(WebsocketClientOptions.create<ClientMessage, ServerMessage>()
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
import { BrokerOptionsBuilder, BrokerOptionsValidator } from '../../io/broker/BrokerOptions.js';
import type { BrokerCommonOptionsType } from '../../io/broker/BrokerOptions.js';
import type { WebsocketCodec } from './WebsocketCodec.js';

/** Plain options-object shape accepted by a {@link WebsocketClientActor}. */
export interface WebsocketClientOptionsType<TOut = unknown, TIn = unknown> extends BrokerCommonOptionsType {
  /** WebSocket URL (`ws://…` or `wss://…`).  Required (ctor or HOCON). */
  readonly url?: string;
  readonly protocols?: string | ReadonlyArray<string>;
  /** Custom request headers — Node/`ws` only; native/browsers ignore them. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Wire codec.  Default: `jsonCodec<TOut, TIn>()`. */
  readonly codec?: WebsocketCodec<TOut, TIn>;
  /** Inbound frame size cap; oversize frames are dropped with a warning.  Default 1 MiB. */
  readonly maxFrameBytes?: number;
  /** What to do with an inbound frame the codec can't decode.  Default 'drop'. */
  readonly onInvalidMessage?: 'drop' | 'hook' | 'disconnect';
  /** Send a ping every `pingIntervalMs` to keep the connection alive.  Default: disabled. */
  readonly pingIntervalMs?: number;
}

/** Fluent builder for {@link WebsocketClientOptionsType}. */
export class WebsocketClientOptionsBuilder<TOut = unknown, TIn = unknown>
  extends BrokerOptionsBuilder<WebsocketClientOptionsType<TOut, TIn>> {
  /** Start a fresh builder.  Equivalent to `new WebsocketClientOptionsBuilder()`. */
  static create<TOut = unknown, TIn = unknown>(): WebsocketClientOptionsBuilder<TOut, TIn> {
    return new WebsocketClientOptionsBuilder<TOut, TIn>();
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
  withCodec(codec: WebsocketCodec<TOut, TIn>): this {
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

/** Validates resolved {@link WebsocketClientOptionsType} settings. */
export class WebsocketClientOptionsValidator<TOut = unknown, TIn = unknown>
  extends BrokerOptionsValidator<WebsocketClientOptionsType<TOut, TIn>> {
  constructor() {
    super('WebsocketClientOptions');
  }
  protected rules(s: Partial<WebsocketClientOptionsType<TOut, TIn>>): void {
    this.commonRules(s);
    this.url('url', ['ws', 'wss']);
    this.positiveInt('maxFrameBytes');
    this.positiveNumber('pingIntervalMs');
    this.oneOf('onInvalidMessage', ['drop', 'hook', 'disconnect']);
  }
}

/**
 * Accepted input for any WebSocket-client-configurable constructor: the fluent
 * {@link WebsocketClientOptionsBuilder} OR a plain
 * {@link WebsocketClientOptionsType} object.
 */
export type WebsocketClientOptions<TOut = unknown, TIn = unknown> =
  | WebsocketClientOptionsBuilder<TOut, TIn>
  | Partial<WebsocketClientOptionsType<TOut, TIn>>;
/** Value alias so `WebsocketClientOptions.create()` / `new WebsocketClientOptions()` resolve to the builder. */
export const WebsocketClientOptions = WebsocketClientOptionsBuilder;
