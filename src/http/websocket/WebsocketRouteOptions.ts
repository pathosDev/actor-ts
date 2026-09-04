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
import { OptionsValidator } from '../../util/OptionsValidator.js';
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
  /**
   * Accept an upgrade whose `Origin` names this same server, without having
   * to enumerate the origins up front.  Use it when the page driving the
   * socket is served by the server itself and you cannot know the host in
   * advance — behind a port-forward, a container hostname or a developer's
   * `localhost` on an arbitrary port.
   *
   * Combines with {@link allowedOrigins}: an upgrade passes when the
   * `Origin` matches the request's own `Host` **or** appears in the list.  A
   * missing `Origin` is allowed for the same reason it is there — CSWSH
   * needs a browser, and a browser always sends one.
   *
   * The comparison is host-only, because `Host` carries no scheme to
   * compare against.  A reverse proxy that rewrites `Host` but not `Origin`
   * will therefore fail the check; list the real origins instead.
   *
   * **Default: `true`** — every `websocket()` route rejects a cross-origin
   * browser upgrade unless it says otherwise (#756).  It shipped defaulting
   * to `false`, which left the control on for whoever already knew to ask for
   * it and off for everyone else; a route whose auth is ambient (a session
   * cookie, `IpAllowlist`) was then CSWSH-exposed by omission.  Pre-1.0
   * permits the hard cut, and DevTools had already concluded the same thing
   * for its own socket by installing the guard unconditionally.
   *
   * **A non-browser client is unaffected**, and that is the point of the
   * missing-`Origin` rule above rather than an accident of it: a Node, Bun or
   * Deno `WebSocket`, and any server-to-server dialer, sends no `Origin`
   * header at all, so it takes the "missing → allowed" branch exactly as
   * before.  What the flipped default changes is browser traffic from a page
   * this server did not serve.
   *
   * **Opt out explicitly with `withRequireSameOrigin(false)`** when the page
   * driving the socket really is served from elsewhere — a frontend on its own
   * dev server or CDN.  Prefer naming that origin in {@link allowedOrigins};
   * `false` with no allowlist restores the pre-#756 behaviour of no origin
   * check at all.
   */
  readonly requireSameOrigin?: boolean;
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

  /**
   * Accept an upgrade whose `Origin` names this same server, so a page the
   * server itself serves works without knowing the host in advance.
   * Combines with `withAllowedOrigins`; a missing `Origin` (a non-browser
   * client, which sends none) stays allowed.
   *
   * **On by default since #756** — call this with `false` only to opt a route
   * out, when the page driving the socket is served from a different origin
   * and naming it in `withAllowedOrigins` is not workable.
   */
  withRequireSameOrigin(enabled: boolean): this {
    return this.set('requireSameOrigin', enabled);
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

  /**
   * Cap the inbound frames held while the connection actor is starting.  Past
   * it the socket is closed with 1013 rather than buffered without bound
   * (#717).  Default 256.
   */
  withMaxPreAttachFrames(frames: number): this {
    return this.set('maxPreAttachFrames', frames);
  }

  /**
   * The byte half of `withMaxPreAttachFrames`.  Raise it alongside
   * `withMaxFrameBytes` on a route that expects large frames immediately after
   * the handshake — the first frame is exempt, the second is not.  Default 4 MiB.
   */
  withMaxPreAttachBytes(bytes: number): this {
    return this.set('maxPreAttachBytes', bytes);
  }

  /**
   * How long an admitted upgrade waits for its connection actor before the
   * socket is closed and its `maxConnections` slot released.  `Infinity`
   * disables the watchdog.  Default 10 s.
   */
  withAcceptTimeoutMs(milliseconds: number): this {
    return this.set('acceptTimeoutMs', milliseconds);
  }
}

/**
 * Validates the route-only option fields.  The per-connection policy knobs
 * (frame / buffer caps, enums, `maxConnections`) are validated separately, on
 * the resolved policy, by `WebsocketPolicyOptionsValidator` — this validator
 * covers what does not go through policy resolution: `allowedOrigins`.
 */
export class WebsocketRouteOptionsValidator<TOut = unknown, TIn = unknown>
  extends OptionsValidator<WebsocketRouteOptionsType<TOut, TIn>> {
  constructor() {
    super('WebsocketRouteOptions');
  }
  protected rules(s: Partial<WebsocketRouteOptionsType<TOut, TIn>>): void {
    const { allowedOrigins } = s;
    // An empty array means "no guard" (allow all) — permitted; only entries
    // must be plausible: a non-array or an empty / non-string entry is a bug.
    if (
      allowedOrigins !== undefined &&
      (!Array.isArray(allowedOrigins) || allowedOrigins.some((origin) => typeof origin !== 'string' || origin.length === 0))
    ) {
      this.fail('allowedOrigins', 'must be an array of non-empty origin strings', allowedOrigins);
    }
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
