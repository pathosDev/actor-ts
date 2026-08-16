import type {
  FetchHandler,
  HonoServerHandle,
  HonoServerRunner,
  HonoWebsocketBridge,
} from './HonoServerRunner.js';

/**
 * Deno implementation — `Deno.serve({ hostname, port }, fetch)`.
 * Returns a `HttpServer` with `.shutdown()` for graceful stop and
 * `.unref()` + `AbortController` for hard stop.
 *
 * Requires `--allow-net` to bind the listener.  WebSocket support uses
 * `upgradeWebSocket` from `hono/deno` (which wraps `Deno.upgradeWebSocket`).
 */
export class DenoHonoRunner implements HonoServerRunner {
  async serve(options: { host: string; port: number; fetch: FetchHandler; serveOptions?: object }): Promise<HonoServerHandle> {
    const deno = (globalThis as { Deno?: DenoGlobal }).Deno;
    if (!deno || typeof deno.serve !== 'function') {
      throw new Error('DenoHonoRunner requires Deno runtime (globalThis.Deno.serve).');
    }
    const ac = new AbortController();
    const server = deno.serve(
      { hostname: options.host, port: options.port, signal: ac.signal, ...(options.serveOptions ?? {}) },
      denoArityHandler(options.fetch),
    );
    return {
      host: options.host,
      port: options.port,
      async stop(graceful: boolean): Promise<void> {
        if (graceful && typeof server.shutdown === 'function') {
          await server.shutdown();
          return;
        }
        ac.abort();
        try { await server.finished; } catch { /* ignore */ }
      },
    };
  }

  /**
   * `maxFrameBytes` is accepted for signature parity and then deliberately
   * dropped: Deno has no transport-level frame cap to install.  Hono's Deno
   * adapter forwards its option bag straight into `Deno.upgradeWebSocket`,
   * whose options are `protocol` and `idleTimeout` only — there is no
   * payload-size member to set.  So on Deno an oversize frame is still fully
   * buffered by the runtime before `maxFrameBytes` rejects it, and the
   * bridge reports that honestly by leaving `transportFrameCapBytes` unset
   * (#586).  Bun and Node do install the cap.
   */
  async webSocket(_app: unknown, _maxFrameBytes: number): Promise<HonoWebsocketBridge> {
    let mod: { upgradeWebSocket: unknown };
    try {
      const name = 'hono/deno';
      mod = (await import(name)) as typeof mod;
    } catch (e) {
      throw new Error(
        'websocket() routes on the Hono backend (Deno) require "hono".  '
          + 'Install it with: deno add npm:hono\nOriginal error: '
          + (e instanceof Error ? e.message : String(e)),
      );
    }
    return {
      upgradeWebSocket: mod.upgradeWebSocket as HonoWebsocketBridge['upgradeWebSocket'],
      serveOptions: {},
    };
  }
}

/**
 * Re-declare a fetch handler with both parameters spelled out, because
 * `Deno.serve` dispatches on the handler's `Function.prototype.length`.
 *
 * Since **Deno 2.9** — the release that landed "a new Deno-owned HTTP/1.1
 * serving path" — an arity-0 handler is read as one that does not want the
 * request, and Deno then skips building the `Request` and calls it with *no
 * arguments at all* (`ext/http/00_serve.ts`):
 *
 * ```js
 * const rawNoRequest = handler.length === 0 && nativeFastPath;
 * const zeroArgCallback = callback.length === 0 && !otelState.TRACING_ENABLED;
 * if (zeroArgCallback && op_http_is_raw_request(req)) response = await callback();
 * ```
 *
 * A rest parameter contributes 0 to that length, so a perfectly ordinary
 * `(...args) => app.fetch(...args)` forwarder — which is what `HonoBackend`
 * used, to keep Bun's second `server` argument reachable — was classified as
 * wanting nothing and handed nothing, and Hono's `app.fetch` then threw on
 * `undefined.method`.  Every request through the Hono backend answered 500
 * (#1197).  The identifiers above are absent from Deno 2.6.8 and 2.8.0 and
 * present from 2.9.0, and Deno had already fixed the same defect once
 * (denoland/deno#20054 → #20796, 2023) before the rewritten path reintroduced
 * it — so this is Deno's regression, not ours, and it is worked around here
 * rather than waited out.
 *
 * Nothing is lost by normalising: Deno never passes more than these two
 * arguments, and the callers all want the request.  Doing it in the runner
 * means any `FetchHandler` is safe on Deno however the caller wrote it.
 */
function denoArityHandler(fetch: FetchHandler): FetchHandler {
  return (request: Request, info: unknown) => fetch(request, info);
}

interface DenoHttpServer {
  readonly finished: Promise<void>;
  shutdown?(): Promise<void>;
}

interface DenoGlobal {
  serve(
    options: { hostname: string; port: number; signal?: AbortSignal },
    handler: FetchHandler,
  ): DenoHttpServer;
}
