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
  /**
   * Allowed browser `Origin`s for the upgrade handshake — the defence
   * against Cross-Site WebSocket Hijacking (CSWSH).  When set, an upgrade
   * whose `Origin` header is present but not in this list is rejected with
   * 403.  A **missing** `Origin` (non-browser client: native WebSocket,
   * server-to-server) is allowed — CSWSH rides a victim browser's ambient
   * cookie/session credentials, so a request without an Origin can't be
   * that attack.  Comparison is case-insensitive.  Unset → no origin check.
   *
   * Bearer-token auth is already resistant (browsers can't set the
   * `Authorization` header on a WS handshake); set this when the route's
   * auth is ambient (cookie / `IpAllowlist`).
   */
  readonly allowedOrigins?: ReadonlyArray<string>;
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

  /**
   * Restrict the upgrade to these browser origins (CSWSH defence).  A
   * present-but-unlisted `Origin` gets 403; a missing `Origin` (non-browser
   * client) is allowed.  Case-insensitive.
   */
  withAllowedOrigins(origins: ReadonlyArray<string>): this {
    return this.set('allowedOrigins', origins);
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

  /**
   * Cap concurrent connections for this route.  A new upgrade beyond the cap
   * is closed with 1013 ("try again later") before it is wired up
   * (security audit WS-5).  Default: unlimited.
   */
  withMaxConnections(max: number): this {
    return this.set('maxConnections', max);
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
