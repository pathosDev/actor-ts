/**
 * Fluent builder for a `websocket()` route's options:
 *
 *     websocket('/ws', ingress, WebSocketRouteOptions.create().withCodec(rawCodec()))
 *
 * `build()` yields a `Partial<WebSocketRouteSettings>` that feeds the same
 * per-route resolution (route options > HOCON `actor-ts.http.websocket` >
 * defaults); unset fields fall through to HOCON.
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { WsCodec } from './WsCodec.js';
import type {
  BackpressurePolicy,
  InvalidMessagePolicy,
  OversizeFramePolicy,
} from './WsPolicy.js';
import type { WebSocketRouteSettings } from './WebSocketRoute.js';

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
