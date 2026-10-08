/**
 * Runtime-neutral "serve a fetch handler over HTTP" abstraction used by
 * `HonoBackend`.  The three runtimes supply different primitives:
 *
 *   - **Bun**   — `Bun.serve({ hostname, port, fetch })`
 *   - **Node**  — `@hono/node-server`'s `serve({ fetch, hostname, port })`
 *   - **Deno**  — `Deno.serve({ hostname, port }, fetch)`
 *
 * Every adapter accepts the same `HonoServeOptions` — `host`, `port` and
 * `fetch`, optionally `tls`, `http2`, `maxHeaderBytes`, `idleTimeoutMs` and
 * `requestDeadlineMs`, and a `serveOptions` bag of runtime-specific extras
 * that goes in beneath all of them — and returns a handle with the actual
 * bound `host`/`port`, what it applied of the typed tuning members, and a
 * `stop(graceful)` method.
 * Graceful stop waits for in-flight requests to complete (up to any
 * runtime-specific budget); non-graceful forces open connections closed.
 */

import type { TlsTransportOptionsType } from '../tcp/TcpBackend.js';

/**
 * The handler a runner installs on its runtime's HTTP server.
 *
 * The rest tail is part of the contract rather than decoration: no runtime
 * calls this with the request alone.  Bun passes `(request, server)` — and
 * Hono's WebSocket upgrade reads that second argument to call
 * `server.upgrade()` — Deno passes `(request, info)`, `@hono/node-server`
 * passes `(request, { incoming, outgoing })`.
 *
 * An implementation must **declare its leading `request` parameter literally**
 * rather than sweep everything into a rest parameter, because a rest parameter
 * contributes 0 to `Function.prototype.length` and `Deno.serve` reads that
 * number — see `DenoHonoRunner`'s `denoArityHandler` (#1197).  TypeScript
 * cannot express "arity ≥ 1" (a narrower function stays assignable to a wider
 * signature), so the runners normalise and a unit test asserts it.
 */
export type FetchHandler = (request: Request, ...runtimeExtras: unknown[]) => Promise<Response> | Response;

/**
 * TLS for the listening socket, in the raw TCP transport's vocabulary — PEM
 * contents or DER bytes, never a path.  The server-side subset: `serverName`
 * is the SNI a *client* sends.  Declared here rather than imported from
 * `src/http/` for the reason `maxFrameBytes` is passed in rather than
 * imported: `src/runtime/` sits below `src/http/` (#1522).
 */
export type HonoServeTls = Pick<TlsTransportOptionsType, 'cert' | 'key' | 'ca' | 'requestClientCert' | 'rejectUnauthorized'>;

/** What every runner's `serve()` accepts. */
export type HonoServeOptions = {
  readonly host: string;
  readonly port: number;
  readonly fetch: FetchHandler;
  /**
   * Runtime-specific extras folded into the runtime's own `serve()` — Bun's
   * `websocket` handlers, `@hono/node-server`'s `overrideGlobalObjects` or
   * `serverOptions` — always **beneath** what the runner writes itself
   * (#1486).  `host`, `port` and `fetch`, and Deno's stop signal, are the
   * runner's; and the listener's TLS and HTTP/2 shape is decided by `tls`
   * and `http2` alone, set or unset, so the bag's own `tls`/`http2` (Bun),
   * `cert`/`key` (Deno) and `createServer` (Node) are dropped.  So is Bun's
   * `idleTimeout`, which is `idleTimeoutMs` and `requestDeadlineMs`'s to
   * decide: a bag value would pass the ceiling and the unit conversion by.
   * Node's `serverOptions` is the one member merged rather than outranked:
   * the caller's keys stay, and the TLS material wins a collision.
   */
  readonly serveOptions?: object;
  /** Terminate TLS on the socket; unset serves plain HTTP. */
  readonly tls?: HonoServeTls;
  /** Offer `h2` through ALPN, HTTP/1.1 staying available.  Meaningless without `tls`; the validator above this layer refuses the pair. */
  readonly http2?: boolean;
  /**
   * The largest request header block the listener accepts, in bytes — the
   * server's `max-header-bytes`.  Unset leaves the runtime's own.
   *
   * A typed member rather than a key the caller folds into `serveOptions`,
   * because only one runtime can take it and the backend has to learn whether
   * it did: `node:http` takes it as `maxHeaderSize` when the server is built,
   * so the Node runner writes it into `@hono/node-server`'s `serverOptions`;
   * `Bun.serve` and `Deno.serve` have no per-server option for it, so those
   * runners apply nothing and their handles say so through
   * {@link HonoServerHandle.appliedServeOptions} (#1488).
   */
  readonly maxHeaderBytes?: number;
  /**
   * How long a connection may stay silent before the runtime closes it, in
   * milliseconds — the server's `idle-timeout`.  `0` disables it.  Unset, a
   * runner that holds one derives it from {@link requestDeadlineMs}, and with
   * neither set leaves the runtime's own.
   *
   * A typed member for the reason {@link maxHeaderBytes} is one: only one
   * runtime takes it here, and the backend has to learn whether it did.
   * `Bun.serve` takes it as `idleTimeout`, in whole seconds, so the Bun
   * runner holds it — and Bun's bound is the whole connection, so it also
   * closes one whose request is in flight while its handler writes nothing.
   * The Node runner ignores it: Node's idle bound is `keepAliveTimeout` on the
   * `node:http` server handed back as {@link HonoServerHandle.raw}, which the
   * backend writes after `serve()`.  `Deno.serve` has no such knob, so the
   * Deno runner ignores it too (#1487).
   */
  readonly idleTimeoutMs?: number;
  /**
   * The longest a handler on this server may take before the framework
   * answers it `503`, in milliseconds — the longest `requestTimeout()`
   * deadline compiled into its routes, and never less than the configured
   * one.  Passed in rather than read, because `src/runtime/` sits below the
   * HTTP subsystem that knows the routes.
   *
   * What a runner whose idle timeout also cuts a silent in-flight request
   * derives its default from when {@link idleTimeoutMs} is unset: long enough
   * that the `503` is written before the runtime closes the connection under
   * the handler, rather than the client getting no answer at all.
   */
  readonly requestDeadlineMs?: number;
};

/**
 * Which typed tuning members of {@link HonoServeOptions} a runner put into
 * effect on the listener it started — `true` only where the listener reports
 * holding the value it was given, so a runtime that accepts an option and
 * ignores it is not taken at its word.
 */
export type HonoAppliedServeOptions = {
  readonly maxHeaderBytes: boolean;
  /**
   * Whether a set {@link HonoServeOptions.idleTimeoutMs} went into the
   * runtime's own option.  `Bun.serve` validates what it is given — a
   * fraction, or a value past its ceiling, throws — so the option is read
   * where it is written, which is what the report counts for this bound.
   * Optional, and absent reads as not applied: only the Bun runner holds it.
   */
  readonly idleTimeoutMs?: boolean;
  /**
   * Present only when {@link HonoServeOptions.idleTimeoutMs} was unset and
   * the timeout derived from {@link HonoServeOptions.requestDeadlineMs} did
   * not fit under the runtime's ceiling: what was installed instead, in
   * milliseconds — too short to let every `503` win, so the backend carries
   * it onto its report and `bind()` names the deadline it cannot cover.
   */
  readonly idleTimeoutHeldAtCeilingMs?: number;
};

export interface HonoServerHandle {
  readonly host: string;
  readonly port: number;
  /** Underlying native server (e.g. the node:http Server on Node) — used by
   *  `@hono/node-ws`'s `injectWebSocket`.  Absent on Bun/Deno. */
  readonly raw?: unknown;
  /**
   * What this runner applied of the typed tuning members, or absent for none
   * — what the Deno runner reports, whose `serve()` takes no per-server
   * option for any of them.  `HonoBackend` carries it onto the binding's
   * report, so `bind()` warns about a member the deployment set that did not
   * take.
   */
  readonly appliedServeOptions?: HonoAppliedServeOptions;
  stop(graceful: boolean): Promise<void>;
}

/** Hono's per-runtime WSContext (the socket handed to the event callbacks). */
export interface WSContextLike {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  readonly protocol?: string;
  readonly raw?: unknown;
}

/** The events object a Hono `upgradeWebSocket` factory returns. */
export interface WSEventsLike {
  onOpen?(evt: unknown, ws: WSContextLike): void;
  onMessage?(evt: { data: unknown }, ws: WSContextLike): void;
  onClose?(evt: { code?: number; reason?: string }, ws: WSContextLike): void;
  onError?(evt: unknown, ws: WSContextLike): void;
}

/** Hono `upgradeWebSocket` middleware factory. */
export type UpgradeWebsocketFunction = (createEvents: (c: unknown) => WSEventsLike) => unknown;

/**
 * Per-runtime WebSocket bridge.  `upgradeWebSocket` is Hono's middleware
 * factory; `serveOptions` are extra options folded into `serve()` (Bun
 * needs `{ websocket }`), under the precedence `HonoServeOptions.serveOptions`
 * states; `attach` runs post-listen wiring (Node needs
 * `injectWebSocket(server)`).
 *
 * `transportFrameCapBytes` reports what the runner managed to install as the
 * runtime-level frame limit — `undefined` means the runtime exposes no such
 * knob, so oversize frames are still fully buffered before anything can
 * reject them (#586).  It is the bridge's answer to "did the cap take?", not
 * a request: callers pass the wanted cap into `webSocket`.
 */
export type HonoWebsocketBridge = {
  readonly upgradeWebSocket: UpgradeWebsocketFunction;
  readonly serveOptions: object;
  readonly attach?: (handle: HonoServerHandle) => void;
  readonly transportFrameCapBytes?: number;
};

export interface HonoServerRunner {
  /**
   * The longest {@link HonoServeOptions.idleTimeoutMs} this runner's runtime
   * can hold, in milliseconds — present on a runner that takes the idle
   * timeout through `serve()`, absent on one that does not take it there.
   *
   * Declared by the runner, where the runtime is known, and enforced by the
   * backend before `serve()` is called, where the key that set the value is
   * known: an error that names `withIdleTimeoutMs` and the HOCON leaf needs
   * the configuration vocabulary, which `src/runtime/` does not import.
   */
  readonly idleTimeoutCeilingMs?: number;
  serve(options: HonoServeOptions): Promise<HonoServerHandle>;
  /**
   * Optional capability — all three built-in runners implement it.
   *
   * `maxFrameBytes` is passed in rather than imported because `src/runtime/`
   * sits *below* `src/http/`: a runner reaching into the HTTP subsystem for
   * the constant would invert that dependency.  The runner installs it as
   * the runtime's own payload limit where one exists, so a hostile peer
   * cannot make the process buffer a frame the application would reject
   * anyway.
   */
  webSocket?(app: unknown, maxFrameBytes: number): Promise<HonoWebsocketBridge>;
}
