/**
 * Runtime-neutral "serve a fetch handler over HTTP" abstraction used by
 * `HonoBackend`.  The three runtimes supply different primitives:
 *
 *   - **Bun**   — `Bun.serve({ hostname, port, fetch })`
 *   - **Node**  — `@hono/node-server`'s `serve({ fetch, hostname, port })`
 *   - **Deno**  — `Deno.serve({ hostname, port }, fetch)`
 *
 * Every adapter accepts the same `{ host, port, fetch }` shape and
 * returns a handle with the actual bound `host`/`port` plus a
 * `stop(graceful)` method.  Graceful stop waits for in-flight requests
 * to complete (up to any runtime-specific budget); non-graceful forces
 * open connections closed.
 */

export type FetchHandler = (request: Request) => Promise<Response> | Response;

export interface HonoServerHandle {
  readonly host: string;
  readonly port: number;
  /** Underlying native server (e.g. the node:http Server on Node) — used by
   *  `@hono/node-ws`'s `injectWebSocket`.  Absent on Bun/Deno. */
  readonly raw?: unknown;
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
 * needs `{ websocket }`); `attach` runs post-listen wiring (Node needs
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
  serve(options: { host: string; port: number; fetch: FetchHandler; serveOptions?: object }): Promise<HonoServerHandle>;
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
