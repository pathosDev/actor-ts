/**
 * All `websocket()`-route option-relevant types live here:
 *
 *   - {@link WebsocketRouteOptionsType} — the plain options-object shape
 *     (what you may also pass as a bare `{ … }` object).
 *   - {@link WebsocketRouteOptionsBuilder} — the fluent builder
 *     (`WebsocketRouteOptions.create()…`).
 *   - {@link WebsocketRouteOptions} — the accepted-input **union**
 *     (`WebsocketRouteOptionsBuilder | WebsocketRouteOptionsType`), plus a
 *     value alias to the builder so `WebsocketRouteOptions.create()` /
 *     `new WebsocketRouteOptions()` keep working.
 *
 *     const websocketOptions = WebsocketRouteOptions.create().withCodec(rawCodec());
 *     websocket('/ws', ingress, websocketOptions);
 *
 * The builder records only the fields you set (as own enumerable props), so it
 * reads/spreads exactly like a plain object; it feeds the same per-route
 * resolution (route options > HOCON `actor-ts.http.websocket` > defaults) —
 * unset fields fall through to HOCON.
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { WebsocketCodec } from './WebsocketCodec.js';
import type {
  BackpressurePolicy,
  InvalidMessagePolicy,
  OversizeFramePolicy,
  WebsocketPolicyOptions,
} from './WebsocketPolicy.js';

/** The options a `websocket()` route may carry — codec + per-connection policy. */
export interface WebsocketRouteOptionsType<TOut, TIn> extends WebsocketPolicyOptions {
  /** Wire codec.  Default: `jsonCodec<TOut, TIn>()`. */
  readonly codec?: WebsocketCodec<TOut, TIn>;
}

/** Fluent builder for {@link WebsocketRouteOptionsType}. */
export class WebsocketRouteOptionsBuilder<TOut = unknown, TIn = unknown>
  extends OptionsBuilder<WebsocketRouteOptionsType<TOut, TIn>> {
  /** Start a fresh builder.  Equivalent to `new WebsocketRouteOptionsBuilder()`. */
  static create<TOut = unknown, TIn = unknown>(): WebsocketRouteOptionsBuilder<TOut, TIn> {
    return new WebsocketRouteOptionsBuilder<TOut, TIn>();
  }

  /** Wire codec.  Default: `jsonCodec<TOut, TIn>()`. */
  withCodec(codec: WebsocketCodec<TOut, TIn>): this {
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
 * {@link WebsocketRouteOptionsBuilder} OR a plain
 * {@link WebsocketRouteOptionsType} object.
 */
export type WebsocketRouteOptions<TOut = unknown, TIn = unknown> =
  | WebsocketRouteOptionsBuilder<TOut, TIn>
  | Partial<WebsocketRouteOptionsType<TOut, TIn>>;
/** Value alias so `WebsocketRouteOptions.create()` / `new WebsocketRouteOptions()` resolve to the builder. */
export const WebsocketRouteOptions = WebsocketRouteOptionsBuilder;
