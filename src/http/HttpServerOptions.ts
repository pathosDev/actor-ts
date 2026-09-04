/**
 * All server-level option-relevant types live here:
 *
 *   - {@link HttpServerOptionsType} — the plain options-object shape.
 *   - {@link HttpServerOptionsBuilder} — the fluent builder
 *     (`HttpServerOptions.create()…`).
 *   - {@link HttpServerOptions} — the accepted-input **union**, plus a value
 *     alias to the builder.
 *   - {@link HttpServerOptionsValidator} — the consume-time domain check, run
 *     once by `HttpExtension.bind` on the merged settings.
 *
 *     const serverOptions = HttpServerOptions.create()
 *       .withIdleTimeoutMs(5_000)
 *       .withMaxConnections(1_000);
 *     await system.http('0.0.0.0', 8080).withServerOptions(serverOptions).bind(routes);
 *
 * These are bounds on the **connection**, not on a route: they belong to the
 * one listening socket a `bind()` opens, so they are resolved once at `bind()`
 * and handed to the backend at `listen()` rather than consulted per request.
 * Precedence is the project's usual `withServerOptions(...)` > HOCON
 * (`actor-ts.http.server`) > built-in default, per field.
 *
 * **Two of the four ship no built-in default at all**, and that is the point
 * of them: `idleTimeoutMs` and `maxConnections` unset means *leave the backend
 * alone*, which is not the same as any number this file could name — see the
 * constants below for why there are only two.
 */
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/**
 * Time to receive a request's complete header block — 60 s.
 *
 * The slow-loris control, and the reason this block exists at all: a peer that
 * opens a socket and dribbles header bytes forever occupies a connection with
 * no request to time out, so neither a route-level `timeout()` middleware nor
 * `requestTimeoutMs` ever sees it.  Node answers `408 Request Timeout` and
 * destroys the socket when this elapses.
 *
 * 60 s is chosen to be **exactly what all three backends already do**, so
 * publishing it changes nothing: it is `http.createServer`'s own default, and
 * Fastify does not override it (measured on bun 1.4.0 and node v26.7.0 —
 * `server.headersTimeout` reads 60000 on a bare `node:http` server, on Fastify
 * and on Express).  What the key buys is that the number is now *movable*
 * without a code change, and that it is written down somewhere an operator can
 * find it.
 */
export const DEFAULT_HTTP_SERVER_HEADER_TIMEOUT_MS = 60_000;

/**
 * Time to receive a request in full — headers *and* body — 300 s.
 *
 * Bounds *receiving*, never answering, so it does not cut off a slow handler,
 * a long poll or an SSE stream: the clock stops once the request has arrived.
 * What it does bound is an upload, which is the half that can be held open by
 * a peer rather than by this process.
 *
 * 300 s is `http.createServer`'s own default, and it is the value that makes
 * the three backends **agree** rather than the value that changes the fewest
 * of them.  They do not agree today: measured on bun 1.4.0 and node v26.7.0,
 * `server.requestTimeout` reads 300000 on a bare `node:http` server and on
 * Express, and **0 — no bound at all — on Fastify**, which is the default
 * backend.  So an actor-ts server on Fastify would wait forever for a body
 * that never finishes arriving while the same application on Express gave up
 * after five minutes.  Publishing the number is the same decision #357 made
 * for `bodyLimit`: the cap is the framework's, not whichever backend happens
 * to be mounted.
 *
 * At the shipped 1 MiB body cap, 300 s is a client sending under 3.5 KB/s.
 * A deployment that legitimately accepts slower uploads raises this, or sets
 * `0` to opt out entirely.
 */
export const DEFAULT_HTTP_SERVER_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Connection-level bounds for one bound server.
 *
 * Every field is optional and `undefined` means **not set**, which has to
 * survive the merge: for the two fields that ship no default it is the only
 * way to say "keep whatever the backend chose", and there is no number that
 * spells that.
 */
export type HttpServerOptionsType = {
  /**
   * How long an idle keep-alive connection is held before it is destroyed
   * (`server.keepAliveTimeout`).  **No built-in default** — unset leaves the
   * backend's own, and the backends deliberately disagree: 72 s on Fastify,
   * 5 s on Express and on Hono-over-Node (measured).  Fastify's is high on
   * purpose, so the server outlives a load balancer's idle window and the
   * balancer never posts a request onto a socket the server is closing; five
   * seconds is `node:http`'s own.  Neither is wrong, so this ships no value
   * rather than picking a winner.  `0` disables the timeout.
   */
  readonly idleTimeoutMs?: number;
  /**
   * How long a connection may take to deliver its complete header block
   * (`server.headersTimeout`) before it is answered `408` and destroyed.
   * Default 60 s.  `0` disables the guard — which reopens the slow-loris hole
   * this key exists to close, so it is a deliberate act.
   */
  readonly headerTimeoutMs?: number;
  /**
   * How long a connection may take to deliver a request in full, headers and
   * body (`server.requestTimeout`).  Default 300 s.  Bounds *receiving* only,
   * so a slow handler, a long poll and an SSE stream are unaffected.  `0`
   * disables it.
   */
  readonly requestTimeoutMs?: number;
  /**
   * Concurrent connections the listening socket accepts before it starts
   * closing new ones (`net.Server.maxConnections`).  **No built-in default** —
   * unset is unlimited, which is what every release before this key did, and
   * `Infinity` is the code-side spelling of the same thing.
   *
   * Server-wide, so it counts every connection the process accepts on this
   * binding — including the WebSocket upgrades that
   * `actor-ts.http.websocket.max-connections` caps per route, and including
   * DevTools when it is attached to the same server.
   */
  readonly maxConnections?: number;
};

/** Fluent builder for {@link HttpServerOptionsType}. */
export class HttpServerOptionsBuilder extends OptionsBuilder<HttpServerOptionsType> {
  /** Start a fresh builder.  Equivalent to `new HttpServerOptionsBuilder()`. */
  static create(): HttpServerOptionsBuilder {
    return new HttpServerOptionsBuilder();
  }

  /** Idle keep-alive window before the socket is destroyed.  Unset leaves the backend's own. */
  withIdleTimeoutMs(ms: number): this {
    return this.set('idleTimeoutMs', ms);
  }

  /** Time to receive the complete headers before a `408`.  Default 60 s. */
  withHeaderTimeoutMs(ms: number): this {
    return this.set('headerTimeoutMs', ms);
  }

  /** Time to receive the entire request, headers and body.  Default 300 s. */
  withRequestTimeoutMs(ms: number): this {
    return this.set('requestTimeoutMs', ms);
  }

  /** Concurrent connections accepted before new ones are closed.  Unset is unlimited. */
  withMaxConnections(connections: number): this {
    return this.set('maxConnections', connections);
  }
}

/**
 * Validates resolved {@link HttpServerOptionsType} settings, once, on the
 * merged result — so a builder, a plain object and a HOCON leaf are all
 * covered by the same rules.
 *
 * The three timeouts are **non-negative rather than positive**, unlike the
 * client's `defaultTimeoutMs`.  The asymmetry is deliberate and is the
 * runtime's, not a relaxation: `0` is `node:http`'s own spelling for "no
 * bound" on all three properties, so refusing it would leave an operator who
 * wants Fastify's historical unbounded `requestTimeout` back with no way to
 * ask for it.  What the rule still catches is the failure that has no
 * spelling: `NaN` and a negative both arm a guard that never fires, which
 * reads as "configured" and behaves as "off".
 */
export class HttpServerOptionsValidator extends OptionsValidator<HttpServerOptionsType> {
  constructor() {
    super('HttpServerOptions');
  }

  protected rules(s: Partial<HttpServerOptionsType>): void {
    this.nonNegativeNumber('idleTimeoutMs');
    this.nonNegativeNumber('headerTimeoutMs');
    this.nonNegativeNumber('requestTimeoutMs');
    this.positiveIntOrUnbounded('maxConnections', s.maxConnections);
  }

  /**
   * `positiveInt`, widened to admit `Infinity`.
   *
   * The same helper `WebsocketPolicyOptionsValidator` carries, for the same
   * reason and on the same-named field: `Infinity` is how code spells the
   * unlimited default, and the base helpers read the snapshot themselves and
   * reject it on the way.  A no-op on `undefined`, like every other helper.
   */
  private positiveIntOrUnbounded(field: string, value: number | undefined): void {
    if (value === undefined || value === Infinity) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      this.fail(field, 'must be a positive integer or Infinity', value);
    }
  }
}

/**
 * Accepted input for `newServerAt(...).withServerOptions(...)`: the fluent
 * {@link HttpServerOptionsBuilder} OR a plain {@link HttpServerOptionsType}
 * object.
 */
export type HttpServerOptions = HttpServerOptionsBuilder | Partial<HttpServerOptionsType>;
/** Value alias so `HttpServerOptions.create()` / `new HttpServerOptions()` resolve to the builder. */
export const HttpServerOptions = HttpServerOptionsBuilder;
