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
  stop(graceful: boolean): Promise<void>;
}

export interface HonoServerRunner {
  serve(opts: { host: string; port: number; fetch: FetchHandler }): Promise<HonoServerHandle>;
}
