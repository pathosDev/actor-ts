/**
 * All `websocket()`-route option-relevant types live here:
 *
 *   - {@link WebSocketRouteOptionsType} — the plain options-object shape
 *     (what you may also pass as a bare `{ … }` object).
 *   - {@link WebSocketRouteOptionsBuilder} — the fluent builder
 *     (`WebSocketRouteOptions.create()…`).
 *   - {@link WebSocketRouteOptions} — the accepted-input **union**
 *     (`WebSocketRouteOptionsBuilder | WebSocketRouteOptionsType`), plus a
 *     value alias to the builder so `WebSocketRouteOptions.create()` /
 *     `new WebSocketRouteOptions()` keep working.
 *
 *     const wsOptions = WebSocketRouteOptions.create().withCodec(rawCodec());
 *     websocket('/ws', ingress, wsOptions);
 *
 * The builder records only the fields you set (as own enumerable props), so it
 * reads/spreads exactly like a plain object; it feeds the same per-route
 * resolution (route options > HOCON `actor-ts.http.websocket` > defaults) —
 * unset fields fall through to HOCON.
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { WsCodec } from './WsCodec.js';
import type {
  BackpressurePolicy,
  InvalidMessagePolicy,
  OversizeFramePolicy,
  WebSocketPolicyOptions,
} from './WsPolicy.js';

/** The options a `websocket()` route may carry — codec + per-connection policy. */
export interface WebSocketRouteOptionsType<TOut, TIn> extends WebSocketPolicyOptions {
  /** Wire codec.  Default: `jsonCodec<TOut, TIn>()`. */
  readonly codec?: WsCodec<TOut, TIn>;
}

/** Fluent builder for {@link WebSocketRouteOptionsType}. */
export class WebSocketRouteOptionsBuilder<TOut = unknown, TIn = unknown>
  extends OptionsBuilder<WebSocketRouteOptionsType<TOut, TIn>> {
  /** Start a fresh builder.  Equivalent to `new WebSocketRouteOptionsBuilder()`. */
  static create<TOut = unknown, TIn = unknown>(): WebSocketRouteOptionsBuilder<TOut, TIn> {
    return new WebSocketRouteOptionsBuilder<TOut, TIn>();
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

/**
 * Accepted input for a `websocket()` route's options: the fluent
 * {@link WebSocketRouteOptionsBuilder} OR a plain
 * {@link WebSocketRouteOptionsType} object.
 */
export type WebSocketRouteOptions<TOut = unknown, TIn = unknown> =
  | WebSocketRouteOptionsBuilder<TOut, TIn>
  | Partial<WebSocketRouteOptionsType<TOut, TIn>>;
/** Value alias so `WebSocketRouteOptions.create()` / `new WebSocketRouteOptions()` resolve to the builder. */
export const WebSocketRouteOptions = WebSocketRouteOptionsBuilder;
